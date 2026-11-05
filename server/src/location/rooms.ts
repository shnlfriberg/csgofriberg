import { roomView } from './roomView';
export { roomView } from './roomView';
import { broadcast } from './roomBroadcast';
export { broadcast } from './roomBroadcast';
import { randomUUID } from 'crypto';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { db } from '../db/knex';
import { authenticateCookie, getGuestFromCookie } from '../middleware/auth';
import { HttpError } from '../middleware/common';
import { isGuestBanned } from '../services/guestAccounts';
import { withKeyLock } from './lock';
import { generateRoomId } from '../socket/roomFactory';
import { socketAllowedWithIp } from '../socket/connection';
import { getRequestPow } from '../services/pow';
import { config } from '../config';
import { redis, redisKey } from '../redis';
import { randomSelection } from './games';
import { assertGuess, DIFFICULTIES, score } from './rules';
import { deleteState, readState, writeState } from './store';
import { countMetric } from './metrics';
import { queueResult } from './resultOutbox';
export { flushResult } from './resultOutbox';
import { startMaintenanceWorkers } from './maintenanceWorkers';
import { answerSchema, difficultySchema } from './validation';
import type {
  AnswerInput,
  Identity,
  RoomPlayer,
  RoomState,
  RoomView,
} from './types';

const localRooms = new Set<string>();
const channel = (id: string) => `location:room:${id}`;
const player = (identity: Identity, socketId: string): RoomPlayer => ({
  identity,
  socketId,
  ready: false,
  connected: true,
  disconnectAt: null,
  retired: false,
  guesses: [],
  currentGuess: null,
  requests: {},
});
export async function getLocationRoom(id: string) {
  const room = await readState<RoomState>(`room:${id}`);
  if (!room) throw new HttpError(404, 'LOCATION_ROOM_NOT_FOUND');
  return room;
}
export async function saveRoom(room: RoomState): Promise<void> {
  room.revision++;
  if (room.status === 'finished') await db('location_result_outbox').insert({
    game_id: room.gameId, payload: JSON.stringify(room), attempts: 0, due_at: Date.now(), last_error: null,
  }).onConflict('game_id').ignore();
  const next = Math.min(
    Date.now() + 2000,
    ...[
      room.startsAt,
      room.endsAt,
      room.nextAt,
      ...room.players.map((p) => p.disconnectAt),
    ].filter((v): v is number => v !== null)
  );
  const client = redis();
  if (client) {
    const batch = client
      .multi()
      .set(redisKey(`location:room:${room.id}`), JSON.stringify(room), {
        EX: 86400,
      });
    if (room.status === 'finished' || room.status === 'cancelled')
      batch.zRem(redisKey('location:rooms'), room.id);
    else
      batch.zAdd(redisKey('location:rooms'), { score: next, value: room.id });
    if (room.status === 'finished')
      batch
        .set(redisKey(`location:outbox:${room.gameId}`), JSON.stringify(room), {
          EX: 7 * 86400,
        })
        .zAdd(redisKey('location:outbox'), {
          value: room.gameId,
          score: Date.now(),
        });
    for (const p of room.players.filter((p) => !p.retired))
      batch.set(
        redisKey(`location:room-owner:${p.identity.key}`),
        JSON.stringify(room.id),
        { EX: 86400 }
      );
    await batch.exec();
  } else {
    await writeState(`room:${room.id}`, room, 86400);
    if (room.status === 'finished') await queueResult(room);
    for (const p of room.players.filter((p) => !p.retired))
      await writeState(`room-owner:${p.identity.key}`, room.id, 86400);
    if (room.status === 'finished' || room.status === 'cancelled')
      localRooms.delete(room.id);
    else localRooms.add(room.id);
  }
}
export async function advanceRoom(
  room: RoomState,
  now = Date.now()
): Promise<boolean> {
  let changed = false;
  if (['finished', 'cancelled'].includes(room.status)) return false;
  for (const p of [...room.players])
    if (!p.connected && p.disconnectAt !== null && p.disconnectAt <= now) {
      if (room.status === 'waiting')
        room.players = room.players.filter((other) => other !== p);
      else p.retired = true;
      p.disconnectAt = null;
      changed = true;
    }
  if (
    !room.players.length ||
    (room.status !== 'waiting' && room.players.every((p) => p.retired))
  ) {
    room.status = 'cancelled';
    room.startsAt = room.endsAt = room.nextAt = null;
    return true;
  }
  if (room.status === 'waiting') {
    if (!room.players.some((p) => p.identity.key === room.host)) {
      room.host = room.players[0].identity.key;
      changed = true;
    }
    if (room.createdAt + 1800_000 <= now) {
      room.status = 'cancelled';
      changed = true;
    }
    return changed;
  }
  if (room.status === 'round_over' && room.nextAt! <= now) {
    room.round++;
    for (const p of room.players) p.currentGuess = null;
    room.status = 'preparing';
    room.startsAt = now + 3000;
    room.endsAt = room.startsAt + room.duration * 1000;
    room.nextAt = null;
    changed = true;
  }
  if (room.status === 'preparing' && room.startsAt! <= now) {
    room.status = 'playing';
    room.startsAt = null;
    changed = true;
  }
  if (
    room.status === 'playing' &&
    (room.endsAt! <= now ||
      room.players
        .filter((p) => !p.retired)
        .every((p) => p.currentGuess !== null))
  ) {
    for (const p of room.players)
      p.guesses.push(p.retired ? null : p.currentGuess);
    room.endsAt = null;
    room.startsAt = null;
    room.status = room.round === 5 ? 'finished' : 'round_over';
    room.nextAt = room.round === 5 ? null : now + 8000;
    changed = true;
  }
  return changed;
}
async function attach(
  io: Server,
  socket: Socket,
  room: RoomState,
  me: Identity
): Promise<void> {
  await socket.join(channel(room.id));
  socket.data.locationRoomId = room.id;
  const p = room.players.find((item) => item.identity.key === me.key)!;
  if (!p.retired) {
    p.socketId = socket.id;
    p.connected = true;
    p.disconnectAt = null;
  }
  await saveRoom(room);
  await broadcast(io, room);
}
async function availableIdentity(me: Identity) {
  const existingId = await readState<string>(`room-owner:${me.key}`);
  if (!existingId) return;
  const room = await readState<RoomState>(`room:${existingId}`);
  if (
    room &&
    !['finished', 'cancelled'].includes(room.status) &&
    room.players.some((p) => p.identity.key === me.key && !p.retired)
  )
    throw new HttpError(409, 'LOCATION_ALREADY_IN_ROOM');
}
async function requireMatchmakingEmail(me: Identity): Promise<void> {
  // Read current verification state: a connected or queued identity can outlive
  // email changes, and the authentication cache may still hold the old state.
  const user = me.userId
    ? await db('users')
        .where({ id: me.userId })
        .first('email', 'email_verified_at', 'banned_at', 'matchmaking_restricted')
    : null;
  if (!user?.email || !user.email_verified_at) {
    await cancelQueues(me.key);
    throw new HttpError(403, 'EMAIL_VERIFICATION_REQUIRED');
  }
  if (user.banned_at || user.matchmaking_restricted) {
    await cancelQueues(me.key);
    throw new HttpError(403, user.banned_at ? 'USER_BANNED' : 'MATCHMAKING_RESTRICTED');
  }
}
export async function createLocationRoom(
  io: Server,
  socket: Socket,
  me: Identity,
  difficulty: RoomState['difficulty'],
  duration: number
): Promise<RoomState> {
  return withKeyLock(`location:seat:${me.key}`, async () => {
    await availableIdentity(me);
    const room = await emptyRoom(me, socket.id, difficulty, duration);
    await cancelQueues(me.key);
    await attach(io, socket, room, me);
    return room;
  });
}
async function emptyRoom(
  me: Identity,
  socketId: string,
  difficulty: RoomState['difficulty'],
  duration: number
): Promise<RoomState> {
  let id = await generateRoomId();
  while (await readState(`room:${id}`)) id = await generateRoomId();
  return {
    id,
    gameId: randomUUID(),
    host: me.key,
    difficulty,
    duration,
    status: 'waiting',
    players: [player(me, socketId)],
    maps: [],
    questions: [],
    round: 0,
    startsAt: null,
    endsAt: null,
    nextAt: null,
    createdAt: Date.now(),
    revision: 0,
  };
}
async function cancelQueues(key: string): Promise<void> {
  for (const difficulty of DIFFICULTIES) {
    await deleteState(`queue:${difficulty}:${key}`);
    const client = redis();
    if (client)
      await client.zRem(redisKey(`location:queue:${difficulty}`), key);
    else {
      const keys =
        (await readState<string[]>(`queue-list:${difficulty}`)) || [];
      await writeState(
        `queue-list:${difficulty}`,
        keys.filter((item) => item !== key),
        300
      );
    }
  }
}
export async function answerRoom(
  room: RoomState,
  me: Identity,
  input: AnswerInput
): Promise<void> {
  const p = room.players.find((p) => p.identity.key === me.key);
  if (!p || p.retired) throw new HttpError(403, 'LOCATION_RETIRED');
  const fingerprint = JSON.stringify(input);
  if (p.requests[input.requestId]) {
    if (p.requests[input.requestId] !== fingerprint)
      throw new HttpError(409, 'LOCATION_REQUEST_CONFLICT');
    return;
  }
  if (
    input.round !== room.round ||
    input.version !== room.round ||
    room.status !== 'playing' ||
    room.endsAt! <= Date.now()
  )
    throw new HttpError(409, 'LOCATION_ROUND_LOCKED');
  if (p.currentGuess) throw new HttpError(409, 'LOCATION_ROUND_LOCKED');
  assertGuess(input, room.maps);
  p.currentGuess = {
    mapId: input.mapId,
    floorId: input.floorId,
    u: input.u,
    v: input.v,
  };
  p.requests[input.requestId] = fingerprint;
}
export async function startRoom(room: RoomState): Promise<void> {
  if (
    room.status !== 'waiting' ||
    room.players.length < 2 ||
    !room.players.every((p) => p.ready && p.connected)
  )
    throw new HttpError(409, 'LOCATION_NOT_READY');
  const selection = await randomSelection(room.difficulty);
  room.questions = selection.questions;
  room.maps = selection.maps;
  room.round = 1;
  room.status = 'preparing';
  room.startsAt = Date.now() + 3000;
  room.endsAt = room.startsAt + room.duration * 1000;
}
export function setupLocationSocket(io: Server): () => Promise<void> {
  const inFlight = new Set<Promise<unknown>>();
  let stopped = false;
  const track = (task: Promise<unknown>) => {
    inFlight.add(task);
    void task
      .catch((error) => {
        if (!(error instanceof Error && error.message === 'RESOURCE_BUSY'))
          console.error('[location]', error);
      })
      .finally(() => inFlight.delete(task));
  };
  io.on('connection', (socket) => {
    const me = socket.data.identity as Identity;
    socket.on('location:room:delta', (enabled) => { socket.data.locationDelta = enabled === true; });
    const restore = (async () => {
      const id = await readState<string>(`room-owner:${me.key}`);
      if (!id) return;
      await withKeyLock(`location:room:${id}`, async () => {
        const room = await readState<RoomState>(`room:${id}`);
        if (
          room?.players.some((p) => p.identity.key === me.key) &&
          !['finished', 'cancelled'].includes(room.status)
        ) {
          await advanceRoom(room);
          await attach(io, socket, room, me);
        }
      });
    })();
    track(restore);
    const handle = (
      event: string,
      schema: z.ZodTypeAny,
      action: (data: any) => Promise<unknown>
    ) =>
      socket.on(event, (raw, ack) => {
        if (Number(socket.data.pendingLocationEvents || 0) >= 8) {
          if (typeof ack === 'function')
            ack({ ok: false, code: 'RATE_LIMITED' });
          return;
        }
        socket.data.pendingLocationEvents =
          Number(socket.data.pendingLocationEvents || 0) + 1;
        const task = (async () => {
          await restore;
          if (!socket.data.locationPowVerified) {
            const proof = getRequestPow({
              headers: socket.handshake.headers,
              ip: socket.data.ip,
            });
            if (!proof || proof.difficulty < config.powDifficulty)
              throw new HttpError(428, 'POW_REQUIRED');
            socket.data.locationPowVerified = true;
          }
          if (
            !(await socketAllowedWithIp(
              socket,
              event,
              me.key,
              event.endsWith('create') ? 6 : 60,
              180,
              60
            ))
          )
            throw new HttpError(429, 'RATE_LIMITED');
          if (me.userId) {
            if (
              (await authenticateCookie(socket.handshake.headers.cookie))
                ?.id !== me.userId
            )
              throw new HttpError(401, 'AUTH_EXPIRED');
          } else if (
            getGuestFromCookie(socket.handshake.headers.cookie)?.key !==
              me.key.slice(2) ||
            (await isGuestBanned(me.key.slice(2)))
          )
            throw new HttpError(403, 'USER_BANNED');
          const parsed = schema.safeParse(raw);
          if (!parsed.success) throw new HttpError(400, 'VALIDATION_FAILED');
          const result = await action(parsed.data);
          if (typeof ack === 'function') ack({ ok: true, data: result });
        })()
          .catch((error) => {
            if (typeof ack === 'function')
              ack({
                ok: false,
                code:
                  error instanceof HttpError
                    ? error.code
                    : error instanceof Error &&
                        error.message === 'RESOURCE_BUSY'
                      ? 'LOCATION_BUSY'
                      : error instanceof Error && error.message === 'REDIS_UNAVAILABLE'
                        ? 'REDIS_UNAVAILABLE'
                      : 'INTERNAL_ERROR',
              });
          })
          .finally(() => {
            socket.data.pendingLocationEvents = Math.max(
              0,
              Number(socket.data.pendingLocationEvents) - 1
            );
          });
        track(task);
      });
    const roomIdSchema = z.object({
      roomId: z.string().regex(/^[A-Z0-9]{5}$/),
    });
    const mutate = async (
      data: { roomId: string },
      action: (room: RoomState) => Promise<void>
    ): Promise<RoomView> =>
      withKeyLock(`location:room:${data.roomId}`, async () => {
        const room = await getLocationRoom(data.roomId);
        if (!room.players.some((p) => p.identity.key === me.key))
          throw new HttpError(403, 'FORBIDDEN');
        await advanceRoom(room);
        await action(room);
        await advanceRoom(room);
        await saveRoom(room);
        await broadcast(io, room);
        return roomView(room, me.key);
      });
    handle(
      'location:room:create',
      z.object({
        difficulty: difficultySchema,
        duration: z.union([z.literal(60), z.literal(120), z.literal(180)]),
      }),
      async (data) =>
        roomView(
          await createLocationRoom(
            io,
            socket,
            me,
            data.difficulty,
            data.duration
          ),
          me.key
        )
    );
    handle('location:room:join', roomIdSchema, async (data) =>
      withKeyLock(`location:seat:${me.key}`, () =>
        withKeyLock(`location:room:${data.roomId}`, async () => {
          const room = await getLocationRoom(data.roomId);
          await advanceRoom(room);
          if (!room.players.some((p) => p.identity.key === me.key)) {
            await availableIdentity(me);
            if (room.status !== 'waiting' || room.players.length >= 8)
              throw new HttpError(409, 'LOCATION_ROOM_UNAVAILABLE');
            room.players.push(player(me, socket.id));
          }
          if (room.players.find((p) => p.identity.key === me.key)!.retired)
            throw new HttpError(403, 'LOCATION_RETIRED');
          await cancelQueues(me.key);
          await attach(io, socket, room, me);
          return roomView(room, me.key);
        })
      )
    );
    handle('location:room:state', roomIdSchema, async (data) =>
      roomView(await getLocationRoom(data.roomId), me.key)
    );
    handle(
      'location:room:ready',
      roomIdSchema.extend({ ready: z.boolean() }),
      (data) =>
        mutate(data, async (room) => {
          if (room.status !== 'waiting')
            throw new HttpError(409, 'LOCATION_ROUND_LOCKED');
          room.players.find((p) => p.identity.key === me.key)!.ready =
            data.ready;
        })
    );
    handle('location:room:start', roomIdSchema, (data) =>
      mutate(data, async (room) => {
        if (room.host !== me.key) throw new HttpError(403, 'FORBIDDEN');
        await startRoom(room);
      })
    );
    handle('location:room:answer', roomIdSchema.merge(answerSchema), (data) =>
      mutate(data, (room) => {
        const { roomId: _id, ...input } = data;
        return answerRoom(room, me, input);
      })
    );
    handle('location:room:leave', roomIdSchema, async (data) => {
      await withKeyLock(`location:room:${data.roomId}`, async () => {
        const room = await getLocationRoom(data.roomId);
        const p = room.players.find((p) => p.identity.key === me.key);
        if (!p) throw new HttpError(403, 'FORBIDDEN');
        if (room.status === 'waiting')
          room.players = room.players.filter((other) => other !== p);
        else if (!['finished', 'cancelled'].includes(room.status)) {
          p.retired = true;
          p.connected = false;
          p.disconnectAt = null;
        }
        await advanceRoom(room);
        await saveRoom(room);
        await broadcast(io, room);
        if ((await readState<string>(`room-owner:${me.key}`)) === room.id)
          await deleteState(`room-owner:${me.key}`);
        await socket.leave(channel(room.id));
        socket.data.locationRoomId = null;
      });
      return { ok: true };
    });
    handle(
      'location:match:cancel',
      z.object({ difficulty: difficultySchema }),
      async () =>
        withKeyLock('location:match', async () => {
          await cancelQueues(me.key);
          return { ok: true };
        })
    );
    handle(
      'location:match:join',
      z.object({ difficulty: difficultySchema }),
      async (data) =>
        withKeyLock('location:match', async () => {
          await requireMatchmakingEmail(me);
          await availableIdentity(me);
          const client = redis();
          const keys = client
            ? await client.zRange(
                redisKey(`location:queue:${data.difficulty}`),
                0,
                -1
              )
            : (await readState<string[]>(`queue-list:${data.difficulty}`)) ||
              [];
          for (const key of keys) {
            const queued = await readState<{
              identity: Identity;
              socketId: string;
            }>(`queue:${data.difficulty}:${key}`);
            if (key === me.key) continue;
            if (
              !queued ||
              !(await io.in(queued.socketId).fetchSockets()).length
            ) {
              await cancelQueues(key);
              continue;
            }
            const matched = await withKeyLock(`location:seat:${me.key}`, () =>
              withKeyLock(`location:seat:${key}`, async () => {
                await requireMatchmakingEmail(me);
                await availableIdentity(me);
                try {
                  await requireMatchmakingEmail(queued.identity);
                  await availableIdentity(queued.identity);
                } catch (error) {
                  if (
                    !(
                      error instanceof HttpError &&
                      ['LOCATION_ALREADY_IN_ROOM', 'EMAIL_VERIFICATION_REQUIRED', 'USER_BANNED', 'MATCHMAKING_RESTRICTED'].includes(
                        error.code
                      )
                    )
                  )
                    throw error;
                  await cancelQueues(key);
                  return null;
                }
                const room = await emptyRoom(
                  me,
                  socket.id,
                  data.difficulty,
                  120
                );
                room.players.push(player(queued.identity, queued.socketId));
                room.players.forEach((p) => (p.ready = true));
                // Draw and validate before joining sockets or reserving either identity.
                await startRoom(room);
                await socket.join(channel(room.id));
                await io.in(queued.socketId).socketsJoin(channel(room.id));
                await saveRoom(room);
                await cancelQueues(key);
                await cancelQueues(me.key);
                await broadcast(io, room);
                return room;
              })
            );
            if (matched) return { room: roomView(matched, me.key) };
          }
          await withKeyLock(`location:seat:${me.key}`, async () => {
            await requireMatchmakingEmail(me);
            await availableIdentity(me);
            await cancelQueues(me.key);
            await writeState(
              `queue:${data.difficulty}:${me.key}`,
              { identity: me, socketId: socket.id },
              300
            );
          });
          if (client) {
            await client.zAdd(redisKey(`location:queue:${data.difficulty}`), {
              value: me.key,
              score: Date.now(),
            });
            await client.expire(
              redisKey(`location:queue:${data.difficulty}`),
              600
            );
          } else
            await writeState(
              `queue-list:${data.difficulty}`,
              [...new Set([
                ...((await readState<string[]>(`queue-list:${data.difficulty}`)) || []),
                me.key,
              ])],
              300
            );
          return { queued: true };
        })
    );
    socket.on('disconnect', () =>
      track(
        (async () => {
          const id = await readState<string>(`room-owner:${me.key}`);
          if (!id) return;
          await withKeyLock(`location:room:${id}`, async () => {
            const room = await readState<RoomState>(`room:${id}`);
            if (!room || ['finished', 'cancelled'].includes(room.status))
              return;
            const p = room.players.find(
              (p) => p.identity.key === me.key && p.socketId === socket.id
            );
            if (p) {
              p.connected = false;
              p.disconnectAt = Date.now() + 30000;
              await saveRoom(room);
              await broadcast(io, room);
            }
          });
        })()
      )
    );
  });
  let ticking = false;
  const stopMaintenance = startMaintenanceWorkers();
  const tick = async () => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const client = redis();
      const ids = client
        ? await client.zRangeByScore(
            redisKey('location:rooms'),
            0,
            Date.now(),
            { LIMIT: { offset: 0, count: 100 } }
          )
        : [...localRooms];
      for (const id of ids)
        try {
          await withKeyLock(`location:room:${id}`, async () => {
            const room = await readState<RoomState>(`room:${id}`);
            if (!room) {
              if (client) await client.zRem(redisKey('location:rooms'), id);
              else localRooms.delete(id);
              return;
            }
            let changed = false;
            const present = new Set(
              (await io.in(channel(id)).fetchSockets()).map((s) => s.id)
            );
            for (const p of room.players)
              if (p.connected && !p.retired && !present.has(p.socketId)) {
                p.connected = false;
                p.disconnectAt = Date.now() + 30000;
                changed = true;
              }
            changed = (await advanceRoom(room)) || changed;
            if (changed) {
              await saveRoom(room);
              await broadcast(io, room);
            } else if (client) {
              const deadlines = [room.startsAt, room.endsAt, room.nextAt, ...room.players.map(p => p.disconnectAt)]
                .filter((v): v is number => v !== null && v > Date.now());
              await client.zAdd(redisKey('location:rooms'), { value: id, score: Math.min(Date.now() + 2000, ...deadlines) });
              countMetric('rooms.unchanged');
            }
          });
        } catch (error) {
          if (!(error instanceof Error && error.message === 'RESOURCE_BUSY'))
            console.error('[location:room-tick]', error);
        }
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => track(tick()), 500);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await stopMaintenance();
    await Promise.allSettled([...inFlight]);
  };
}
