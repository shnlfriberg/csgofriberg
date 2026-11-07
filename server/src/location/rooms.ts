import { randomUUID } from 'crypto';
import { voteRematch, rematchUnanimous } from '../rooms/rematch';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { db } from '../db/knex';
import { authenticateCookie, getGuestFromCookie } from '../middleware/auth';
import { HttpError } from '../middleware/common';
import { redis, redisKey } from '../redis';
import { isGuestBanned } from '../services/guestAccounts';
import { getMaintenanceUntil } from '../services/roomStore';
import { socketAllowedWithIp } from '../socket/connection';
import { activateRoomAdapter } from '../rooms/kernel';
import { allocateRoomCode, registerCodeNamespace } from '../rooms/kernel/codes';
import { registerKernelEvent } from '../rooms/kernel/events';
import { startLeasedWorker } from '../rooms/kernel/lease';
import { countKernel } from '../rooms/kernel/metrics';
import {
  claimOccupancy,
  claimOccupancyOrThrow,
  isOccupiedError,
  occupancyKey,
  occupiedError,
  releaseOccupancy,
  resolveOccupancy,
  encodeOccupancy,
  OCCUPANCY_TTL_SECONDS,
} from '../rooms/kernel/occupancy';
import { identityScope, onlineIdentities } from '../rooms/kernel/presence';
import type { GameRoomAdapter } from '../rooms/kernel/registry';
import { registerScheduleConsumer } from '../rooms/kernel/scheduler';
import { parseScheduleItem, ScheduleSource } from '../rooms/kernel/schedules';
import { cancelLocalTimer, setLocalTimer } from '../rooms/kernel/timers';
import { kernelScript } from '../rooms/kernel/state';
import { withKeyLock } from './lock';
import { randomSelection } from './games';
import { DIFFICULTIES } from './rules';
import { deleteState, readState, writeState } from './store';
import { countMetric } from './metrics';
import { flushDueResults, flushResult, queueResult } from './resultOutbox';
import { startMaintenanceWorkers } from './maintenanceWorkers';
import { answerSchema, difficultySchema } from './validation';
import { roomView } from './roomView';
import {
  advance,
  answer,
  assertStartable,
  hasChanges,
  isTerminal,
  joinPlayer,
  leavePlayer,
  newChanges,
  newPlayer,
  nextDeadline,
  occupyingKeys,
  requirePlayer,
  setPresence,
  setReady,
  startGame,
  type RoomChanges,
} from './roomEngine';
import {
  emitFullView,
  emitRevision,
  mapsHash,
  socketProtocol,
  subscribeRemote,
  subscribeSocket,
  unsubscribeSocket,
  viewFor,
  type LocationProtocol,
} from './roomProtocol';
import type { AnswerInput, Identity, RoomState, RoomView } from './types';

export { roomView } from './roomView';
export { flushResult } from './resultOutbox';

/**
 * 图寻 multiplayer rooms on the shared room kernel.
 *
 * The kernel provides site-wide occupancy (`identity-room:` shared with classic
 * rooms), the shared five-character code namespace, deadline scheduling with
 * leases, identity presence and the event wrapper. This module keeps the
 * 图寻-specific parts: the state machine (roomEngine), question selection,
 * scoring, privacy of guesses before reveal and the result outbox.
 */
const ROOM_TTL_SECONDS = 86_400;
const INDEX_GRACE_MS = 5_000;
const LOCAL_TIMER_HORIZON_MS = 60_000;
const QUEUE_TTL_SECONDS = 300;
const QUEUE_SCAN = 21;

const locationSchedules = new ScheduleSource('location', 'kernel:schedules:location');
const tickMember = (id: string) => `tick|${id}|0`;
const outboxMember = (gameId: string) => `outbox|${gameId}|0`;
const roomRef = (roomId: string) => ({ game: 'location' as const, roomId });
let locationIo: Server | null = null;

registerCodeNamespace('location', {
  redisKeys: (id) => [redisKey(`location:room:${id}`)],
  localExists: async (id) => Boolean(await readState(`room:${id}`)),
});

// ---------------------------------------------------------------- storage

export async function readRoom(id: string): Promise<RoomState | null> {
  return readState<RoomState>(`room:${id}`);
}

export async function getLocationRoom(id: string): Promise<RoomState> {
  const room = await readRoom(id);
  if (!room) throw new HttpError(404, 'LOCATION_ROOM_NOT_FOUND');
  return room;
}

const SAVE_SCRIPT = `local current = tonumber(redis.call('GET', KEYS[2]) or '-1')
if current >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
if ARGV[4] == '1' then
  redis.call('ZREM', KEYS[3], ARGV[13])
  redis.call('ZREM', KEYS[4], ARGV[6])
else
  redis.call('ZADD', KEYS[3], ARGV[5], ARGV[13])
  if ARGV[7] ~= '' then redis.call('ZADD', KEYS[4], ARGV[7], ARGV[6]) else redis.call('ZREM', KEYS[4], ARGV[6]) end
end
if ARGV[11] ~= '' then
  redis.call('ZADD', KEYS[4], ARGV[12], 'outbox|' .. ARGV[11] .. '|0')
  redis.call('ZADD', KEYS[5], ARGV[12], ARGV[11])
end
local releaseCount = tonumber(ARGV[9])
for index = 6, 5 + releaseCount do
  if redis.call('GET', KEYS[index]) == ARGV[8] then redis.call('DEL', KEYS[index]) end
end
for index = 6 + releaseCount, #KEYS do
  if redis.call('GET', KEYS[index]) == ARGV[8] then redis.call('EXPIRE', KEYS[index], ARGV[10]) end
end
return 1`;

/**
 * Persist one revision atomically: room JSON with a revision CAS, the active
 * room index, the next kernel deadline, the outbox wake-up and occupancy
 * release/refresh. No polling is needed because the deadline is exact.
 */
async function persist(room: RoomState, options: { release: string[]; outbox: boolean }): Promise<void> {
  const deadline = nextDeadline(room);
  const terminal = isTerminal(room);
  const client = redis();
  if (!client) {
    await writeState(`room:${room.id}`, room, ROOM_TTL_SECONDS);
    if (terminal) await locationSchedules.remove(tickMember(room.id));
    else await locationSchedules.add(tickMember(room.id), deadline ?? Date.now() + LOCAL_TIMER_HORIZON_MS);
    if (options.outbox) {
      await queueResult(room);
      await locationSchedules.add(outboxMember(room.gameId), Date.now());
    }
    await releaseOccupancy(roomRef(room.id), options.release);
    return;
  }
  const refresh = occupyingKeys(room).filter((key) => !options.release.includes(key));
  const result = await kernelScript(
    'location-room-save-v1',
    SAVE_SCRIPT,
    [
      redisKey(`location:room:${room.id}`),
      redisKey(`location:room-rev:${room.id}`),
      redisKey('location:rooms'),
      redisKey('kernel:schedules:location'),
      redisKey('location:outbox'),
      ...options.release.map(occupancyKey),
      ...refresh.map(occupancyKey),
    ],
    [
      JSON.stringify(room),
      String(room.revision),
      String(ROOM_TTL_SECONDS),
      terminal ? '1' : '0',
      String((deadline ?? Date.now() + LOCAL_TIMER_HORIZON_MS) + INDEX_GRACE_MS),
      tickMember(room.id),
      deadline === null ? '' : String(deadline),
      encodeOccupancy(roomRef(room.id)),
      String(options.release.length),
      String(OCCUPANCY_TTL_SECONDS),
      options.outbox ? room.gameId : '',
      String(Date.now()),
      room.id,
    ]
  );
  if (Number(result) !== 1) throw new Error('RESOURCE_BUSY');
}

async function insertOutbox(room: RoomState): Promise<void> {
  await db('location_result_outbox').insert({
    game_id: room.gameId, payload: JSON.stringify(room), attempts: 0, due_at: Date.now(), last_error: null,
  }).onConflict('game_id').ignore();
}

/**
 * Low-level save used by maintenance tooling and tests: no broadcast and no
 * local timers. The exact kernel deadline lets a running room server pick it up.
 */
export async function saveRoom(room: RoomState): Promise<void> {
  room.revision++;
  const finished = room.status === 'finished';
  if (finished) await insertOutbox(room);
  await persist(room, { release: isTerminal(room) ? room.players.map((p) => p.identity.key) : [], outbox: finished });
}

function armTimers(room: RoomState, outbox: boolean): void {
  const deadline = nextDeadline(room);
  if (deadline === null) cancelLocalTimer(`location:${room.id}`);
  else if (deadline - Date.now() <= LOCAL_TIMER_HORIZON_MS) {
    setLocalTimer(`location:${room.id}`, deadline - Date.now() + 5, async () => {
      if (await locationSchedules.claimOne(tickMember(room.id))) await runTick(room.id);
    });
  }
  if (outbox) {
    setLocalTimer(`location-outbox:${room.gameId}`, 0, async () => {
      if (await locationSchedules.claimOne(outboxMember(room.gameId))) await runOutbox(room.gameId);
    });
  }
}

async function graceFrozenUntil(room: RoomState, now: number): Promise<number> {
  const due = room.players.some((p) => !p.connected && p.disconnectAt !== null && p.disconnectAt <= now);
  return due ? getMaintenanceUntil().catch(() => 0) : 0;
}

export interface MutationResult<R> {
  room: RoomState;
  result: R;
  changes: RoomChanges;
  committed: boolean;
}

/**
 * Read → advance → mutate → advance → commit one revision under the room lock.
 * Nothing is written (and no revision is consumed) when nothing changed.
 */
export async function mutateRoom<R>(
  id: string,
  action: (room: RoomState, changes: RoomChanges, now: number) => R | Promise<R>
): Promise<MutationResult<R>> {
  return withKeyLock(`location:room:${id}`, async () => {
    const room = await getLocationRoom(id);
    const now = Date.now();
    const previousRevision = room.revision;
    const previousStatus = room.status;
    const changes = newChanges();
    const frozen = await graceFrozenUntil(room, now);
    advance(room, now, changes, frozen);
    const result = await action(room, changes, now);
    advance(room, now, changes, frozen);
    if (!hasChanges(changes)) {
      await reschedule(room);
      await scheduleRematch(room);
      return { room, result, changes, committed: false };
    }
    room.revision = previousRevision + 1;
    const finishedNow = room.status === 'finished' && previousStatus !== 'finished';
    if (finishedNow) await insertOutbox(room);
    if (room.status === 'preparing' && !room.mapsHash && room.maps.length) room.mapsHash = mapsHash(room);
    await persist(room, { release: [...changes.released], outbox: finishedNow });
    if (locationIo) emitRevision(locationIo, room, changes, previousRevision);
    armTimers(room, finishedNow);
    await scheduleRematch(room);
    countKernel('location.commits');
    return { room, result, changes, committed: true };
  });
}

async function reschedule(room: RoomState): Promise<void> {
  const deadline = nextDeadline(room);
  if (deadline === null || isTerminal(room)) {
    await locationSchedules.remove(tickMember(room.id));
    return;
  }
  await locationSchedules.add(tickMember(room.id), deadline);
  const client = redis();
  if (client) await client.zAdd(redisKey('location:rooms'), { value: room.id, score: deadline + INDEX_GRACE_MS });
  armTimers(room, false);
  countMetric('rooms.unchanged');
}

async function runTick(id: string): Promise<void> {
  try {
    await mutateRoom(id, () => undefined);
  } catch (error) {
    if (error instanceof HttpError && error.code === 'LOCATION_ROOM_NOT_FOUND') {
      await locationSchedules.remove(tickMember(id));
      await redis()?.zRem(redisKey('location:rooms'), id);
      return;
    }
    throw error;
  }
}

async function runOutbox(gameId: string): Promise<void> {
  try {
    await flushResult(gameId);
  } finally {
    // Failures are rescheduled through the SQL due time and the outbox sweep.
    await locationSchedules.remove(outboxMember(gameId));
  }
}

async function scheduleRematch(room: RoomState): Promise<void> {
  const member = `rematch|${room.id}|0`;
  if (room.status === 'finished' && room.rematch?.acceptedKeys.length)
    await locationSchedules.add(member, Date.now() + 2_000);
  else await locationSchedules.remove(member);
}

async function updateRematch(room: RoomState, changes: RoomChanges, now: number, actor?: string, wanted?: boolean): Promise<void> {
  if (room.status !== 'finished') {
    if (actor) throw new HttpError(409, 'REMATCH_NOT_AVAILABLE');
    return;
  }
  const candidates = room.players.filter(p => !p.retired && !room.rematch?.leftKeys?.includes(p.identity.key));
  const live = await onlineIdentities(candidates.map(p => identityScope(p.identity.key)));
  const occupied = await Promise.all(candidates.map(p => resolveOccupancy(p.identity.key)));
  const keys = candidates.filter((p, i) => live[i].has(p.identity.key) &&
    (!occupied[i] || (occupied[i]?.game === 'location' && occupied[i]?.roomId === room.id))).map(p => p.identity.key);
  if (actor && (!keys.includes(actor) || (wanted && keys.length < 2))) throw new HttpError(409, 'REMATCH_NOT_AVAILABLE');
  const votes = voteRematch(room.rematch, keys, actor, wanted);
  if (JSON.stringify(votes) !== JSON.stringify(room.rematch)) {
    room.rematch = votes;
    changes.sections.add('rematch');
  }
  if (!rematchUnanimous(votes)) return;
  const selection = await randomSelection(room.difficulty);
  await claimOccupancyOrThrow(roomRef(room.id), keys).catch(occupancyFailure);
  // The old result was snapshotted to the outbox before this reset.
  room.gameId = randomUUID();
  room.players = candidates.filter(p => keys.includes(p.identity.key)).map(p => ({ ...newPlayer(p.identity, p.socketId), ready: true }));
  if (!keys.includes(room.host)) room.host = keys[0];
  room.rematch = undefined;
  room.mapsHash = null;
  room.nextAt = null;
  room.createdAt = now;
  startGame(room, selection, now, changes);
  changes.sections.add('reset');
}

// ------------------------------------------------------------- compat API

/** Original pure transition API (used by tests and maintenance tooling). */
export async function advanceRoom(room: RoomState, now = Date.now()): Promise<boolean> {
  return advance(room, now);
}

export async function answerRoom(room: RoomState, me: Identity, input: AnswerInput): Promise<void> {
  answer(room, me.key, input, Date.now(), newChanges());
}

export async function startRoom(room: RoomState): Promise<void> {
  assertStartable(room);
  startGame(room, await randomSelection(room.difficulty), Date.now(), newChanges());
}

// ------------------------------------------------------------ eligibility

async function requireMatchmakingEligibility(me: Identity): Promise<void> {
  // Read current verification state: a connected or queued identity can outlive
  // email changes, and the authentication cache may still hold the old state.
  const user = me.userId
    ? await db('users').where({ id: me.userId }).first('email', 'email_verified_at', 'banned_at', 'matchmaking_restricted')
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

/** Translate a kernel occupancy conflict into the historical 图寻 error code. */
async function occupancyFailure(error: unknown): Promise<never> {
  if (isOccupiedError(error)) {
    throw new HttpError(409, 'LOCATION_ALREADY_IN_ROOM', { occupied: error.occupied });
  }
  throw error;
}

// --------------------------------------------------------------- creation

async function emptyRoom(me: Identity, socketId: string, difficulty: RoomState['difficulty'], duration: number): Promise<RoomState> {
  return {
    id: await allocateRoomCode('location'),
    gameId: randomUUID(),
    host: me.key,
    difficulty,
    duration,
    status: 'waiting',
    players: [newPlayer(me, socketId)],
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

async function commitNew(room: RoomState, previousRevision = 0): Promise<void> {
  room.revision = previousRevision + 1;
  if (room.maps.length) room.mapsHash = mapsHash(room);
  await persist(room, { release: [], outbox: false });
  armTimers(room, false);
}

export async function createLocationRoom(
  socket: Socket,
  me: Identity,
  difficulty: RoomState['difficulty'],
  duration: number,
  protocol: LocationProtocol
): Promise<RoomState> {
  const room = await emptyRoom(me, socket.id, difficulty, duration);
  if (protocol === 1) room.v1Seats = [me.key];
  await claimOccupancyOrThrow(roomRef(room.id), [me.key]).catch(occupancyFailure);
  try {
    await cancelQueues(me.key);
    await commitNew(room);
  } catch (error) {
    await releaseOccupancy(roomRef(room.id), [me.key]);
    throw error;
  }
  await subscribeSocket(socket, room, me.key, protocol);
  return room;
}

// ------------------------------------------------------------ matchmaking

const queueKey = (difficulty: string) => redisKey(`location:queue:${difficulty}`);
const profilePrefix = (difficulty: string) => `location:queue:${difficulty}:`;
interface QueueProfile { identity: Identity; socketId: string; protocol?: LocationProtocol; queuedAt?: number }

const TAKE_OR_QUEUE_SCRIPT = `local entries = redis.call('ZRANGE', KEYS[1], 0, tonumber(ARGV[7]) - 1)
for _, key in ipairs(entries) do
  if key ~= ARGV[1] then
    local raw = redis.call('GET', ARGV[2] .. key)
    local alive = false
    if raw then
      local ok, profile = pcall(cjson.decode, raw)
      alive = ok and type(profile.socketId) == 'string' and redis.call('EXISTS', ARGV[3] .. profile.socketId) == 1
    end
    redis.call('ZREM', KEYS[1], key)
    redis.call('DEL', ARGV[2] .. key)
    if alive then
      redis.call('ZREM', KEYS[1], ARGV[1])
      redis.call('DEL', ARGV[2] .. ARGV[1])
      return raw
    end
  end
end
if ARGV[8] == '1' then
  redis.call('ZADD', KEYS[1], ARGV[5], ARGV[1])
  redis.call('SET', ARGV[2] .. ARGV[1], ARGV[4], 'EX', ARGV[6])
  redis.call('EXPIRE', KEYS[1], 600)
end
return false`;

/**
 * Atomically take the oldest live waiting opponent, or queue `me` when none is
 * left. Liveness uses the shared `connections:socket:` keys (no RPC), and no
 * global lock serialises matchmaking any more.
 */
async function takeOrQueue(difficulty: string, me: Identity, socket: Socket, protocol: LocationProtocol, queue: boolean): Promise<QueueProfile | null> {
  const profile: QueueProfile = { identity: me, socketId: socket.id, protocol, queuedAt: Date.now() };
  const client = redis();
  if (!client) {
    const keys = (await readState<string[]>(`queue-list:${difficulty}`)) || [];
    for (const key of keys) {
      if (key === me.key) continue;
      const candidate = await readState<QueueProfile>(`queue:${difficulty}:${key}`);
      await deleteState(`queue:${difficulty}:${key}`);
      await writeState(`queue-list:${difficulty}`, keys.filter((item) => item !== key), QUEUE_TTL_SECONDS);
      const sockets = candidate ? await locationIo?.in(candidate.socketId).fetchSockets() : [];
      if (candidate && sockets?.length) return candidate;
    }
    if (queue) {
      await writeState(`queue:${difficulty}:${me.key}`, profile, QUEUE_TTL_SECONDS);
      const latest = (await readState<string[]>(`queue-list:${difficulty}`)) || [];
      await writeState(`queue-list:${difficulty}`, [...new Set([...latest, me.key])], QUEUE_TTL_SECONDS);
    }
    return null;
  }
  const raw = await kernelScript('location-queue-take-v1', TAKE_OR_QUEUE_SCRIPT, [queueKey(difficulty)], [
    me.key,
    redisKey(profilePrefix(difficulty)),
    redisKey('connections:socket:'),
    JSON.stringify(profile),
    String(Date.now()),
    String(QUEUE_TTL_SECONDS),
    String(QUEUE_SCAN),
    queue ? '1' : '0',
  ]);
  return typeof raw === 'string' ? JSON.parse(raw) as QueueProfile : null;
}

async function requeue(difficulty: string, profile: QueueProfile): Promise<void> {
  const client = redis();
  if (!client) return;
  await client.multi()
    .zAdd(queueKey(difficulty), { score: profile.queuedAt ?? Date.now(), value: profile.identity.key })
    .set(redisKey(`${profilePrefix(difficulty)}${profile.identity.key}`), JSON.stringify(profile), { EX: QUEUE_TTL_SECONDS })
    .exec();
}

export async function cancelQueues(key: string): Promise<void> {
  const client = redis();
  if (client) {
    const batch = client.multi();
    for (const difficulty of DIFFICULTIES) batch.zRem(queueKey(difficulty), key).del(redisKey(`${profilePrefix(difficulty)}${key}`));
    await batch.exec();
    return;
  }
  for (const difficulty of DIFFICULTIES) {
    await deleteState(`queue:${difficulty}:${key}`);
    const keys = (await readState<string[]>(`queue-list:${difficulty}`)) || [];
    await writeState(`queue-list:${difficulty}`, keys.filter((item) => item !== key), QUEUE_TTL_SECONDS);
  }
}

async function matchmake(io: Server, socket: Socket, me: Identity, difficulty: RoomState['difficulty']): Promise<{ room: RoomView } | { queued: true }> {
  await requireMatchmakingEligibility(me);
  const protocol = socketProtocol(socket);
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await takeOrQueue(difficulty, me, socket, protocol, true);
    if (!candidate) return { queued: true };
    try {
      await requireMatchmakingEligibility(candidate.identity);
    } catch (error) {
      if (error instanceof HttpError && ['EMAIL_VERIFICATION_REQUIRED', 'USER_BANNED', 'MATCHMAKING_RESTRICTED'].includes(error.code)) continue;
      await requeue(difficulty, candidate);
      throw error;
    }
    const room = await emptyRoom(me, socket.id, difficulty, 120);
    room.players.push(newPlayer(candidate.identity, candidate.socketId));
    room.players.forEach((p) => (p.ready = true));
    const claim = await claimOccupancy(roomRef(room.id), [me.key, candidate.identity.key]);
    if (!claim.ok) {
      if (claim.identity === candidate.identity.key) continue;
      await requeue(difficulty, candidate);
      throw await occupiedError(claim.conflict, me.key).then(occupancyFailure);
    }
    try {
      // Draw and validate before joining sockets or announcing the room.
      startGame(room, await randomSelection(difficulty), Date.now(), newChanges());
      room.v1Seats = [me.key, candidate.identity.key].filter((key) => (key === me.key ? protocol : candidate.protocol ?? 1) === 1);
      await commitNew(room);
    } catch (error) {
      await releaseOccupancy(roomRef(room.id), [me.key, candidate.identity.key]);
      await requeue(difficulty, candidate);
      throw error;
    }
    await subscribeSocket(socket, room, me.key, protocol);
    const opponentProtocol = candidate.protocol ?? 1;
    await subscribeRemote(io, candidate.socketId, room, candidate.identity.key, opponentProtocol);
    emitFullView(io, candidate.socketId, room, candidate.identity.key, opponentProtocol);
    countKernel('location.matches');
    return { room: viewFor(room, me.key, protocol) as RoomView };
  }
  return { queued: true };
}

// ---------------------------------------------------------- kernel adapter

const locationAdapter: GameRoomAdapter = {
  game: 'location',
  presence: 'identity',
  protocolVersion: 2,
  async isActiveMember(roomId, identityKey) {
    const room = await readRoom(roomId);
    if (!room || isTerminal(room)) return false;
    return room.players.some((p) => p.identity.key === identityKey && !p.retired) ? 'player' : false;
  },
  async describe(roomId) {
    const room = await readRoom(roomId);
    return room ? { status: room.status, round: room.round, code: room.id } : null;
  },
  async onPresence(change) {
    try {
      await mutateRoom(change.roomId, (room, changes, now) => setPresence(room, change.identityKey, change.online, now, changes));
    } catch (error) {
      if (error instanceof HttpError && error.code === 'LOCATION_ROOM_NOT_FOUND') return;
      throw error;
    }
  },
  cancelQueue: (identityKey) => cancelQueues(identityKey),
  async adopt() {
    // Rooms created before the kernel: claim seats and exact deadlines once.
    const client = redis();
    if (!client) return;
    const ids = await client.zRange(redisKey('location:rooms'), 0, -1);
    for (const id of ids) {
      const room = await readRoom(id);
      if (!room || isTerminal(room)) continue;
      for (const key of occupyingKeys(room)) {
        const result = await claimOccupancy(roomRef(room.id), [key]);
        if (!result.ok) countKernel('occupancy.adoptConflicts');
      }
      await locationSchedules.add(tickMember(room.id), nextDeadline(room) ?? Date.now());
    }
  },
};

/** Safety net: rooms whose exact deadline passed without being processed. */
async function sweepDueRooms(): Promise<void> {
  const client = redis();
  if (!client) return;
  const ids = await client.zRangeByScore(redisKey('location:rooms'), 0, Date.now(), { LIMIT: { offset: 0, count: 50 } });
  for (const id of ids) {
    try {
      await runTick(id);
      countKernel('location.sweptRooms');
    } catch (error) {
      if (!(error instanceof Error && error.message === 'RESOURCE_BUSY')) console.error('[location:sweep]', error);
    }
  }
}

/** Repair presence missed during a deploy or crash, without per-room RPCs. */
async function reconcilePresence(): Promise<void> {
  const client = redis();
  if (!client) return;
  const ids = await client.zRange(redisKey('location:rooms'), 0, -1);
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const raws = await client.mGet(batch.map((id) => redisKey(`location:room:${id}`)));
    const rooms = raws.flatMap((raw) => (raw ? [JSON.parse(raw) as RoomState] : [])).filter((room) => !isTerminal(room));
    const seats = rooms.flatMap((room) => room.players.filter((p) => !p.retired).map((p) => ({ room, p })));
    const live = await onlineIdentities(seats.map(({ p }) => identityScope(p.identity.key)));
    for (const [index, { room, p }] of seats.entries()) {
      const online = live[index].has(p.identity.key);
      if (online === p.connected) continue;
      countKernel('location.reconciled');
      await locationAdapter.onPresence!({ game: 'location', roomId: room.id, identityKey: p.identity.key, online, cause: 'reconcile' })
        .catch((error) => console.error('[location:reconcile]', error));
    }
  }
}

// ------------------------------------------------------------ socket layer

const roomIdSchema = z.object({ roomId: z.string().regex(/^[A-Z0-9]{5}$/) });
const stateSchema = roomIdSchema.extend({ mapsHash: z.string().max(64).nullable().optional() });

function ackView(room: RoomState, me: string, protocol: LocationProtocol): unknown {
  return protocol === 2 ? { revision: room.revision } : roomView(room, me);
}

export function setupLocationSocket(io: Server): () => Promise<void> {
  locationIo = io;
  const inFlight = new Set<Promise<unknown>>();
  const track = (task: Promise<unknown>) => {
    inFlight.add(task);
    void task.catch(() => undefined).finally(() => inFlight.delete(task));
  };
  const unregisterAdapter = activateRoomAdapter(locationAdapter);
  const unregisterSchedules = registerScheduleConsumer({
    name: 'location',
    source: locationSchedules,
    batch: 40,
    concurrency: 8,
    groupKey: (item) => parseScheduleItem(item).roomId,
    handleGroup: async (items) => {
      for (const item of items) {
        const { kind, roomId } = parseScheduleItem(item);
        try {
          if (kind === 'tick') await runTick(roomId);
          else if (kind === 'rematch') await mutateRoom(roomId, (room, changes, now) => updateRematch(room, changes, now));
          else if (kind === 'outbox') await runOutbox(roomId);
          else await locationSchedules.remove(item);
        } catch (error) {
          if (!(error instanceof Error && error.message === 'RESOURCE_BUSY')) console.error('[location:schedule]', error);
        }
      }
    },
  });
  const stops = [
    startLeasedWorker('location-sweep', 10_000, sweepDueRooms),
    startLeasedWorker('location-reconcile', 30_000, reconcilePresence),
    startLeasedWorker('location-outbox', 30_000, flushDueResults),
    startMaintenanceWorkers(),
  ];

  io.on('connection', (socket) => {
    const me = socket.data.identity as Identity;
    if (!me) return;
    // Protocol v1 pages negotiate patches with this flag; turning it off on
    // page exit now also stops room delivery to that socket.
    socket.on('location:room:delta', (enabled) => {
      socket.data.locationDelta = enabled === true;
      if (enabled !== true && socketProtocol(socket) === 1) track(unsubscribeSocket(socket));
    });

    const handle = (event: string, schema: z.ZodTypeAny, action: (data: any) => Promise<unknown>) =>
      registerKernelEvent(socket, {
        event,
        schema,
        ack: 'envelope',
        order: 'pending-then-validate',
        pendingField: 'pendingLocationEvents',
        track,
        before: async () => {
          // Sockets are not PoW-gated by design (HTTP API requests are); identity and rate limits apply.
          if (!(await socketAllowedWithIp(socket, event, me.key, event.endsWith('create') ? 6 : 60, 180, 60)))
            throw new HttpError(429, 'RATE_LIMITED');
          if (me.userId) {
            if ((await authenticateCookie(socket.handshake.headers.cookie))?.id !== me.userId)
              throw new HttpError(401, 'AUTH_EXPIRED');
          } else if (
            getGuestFromCookie(socket.handshake.headers.cookie)?.key !== me.key.slice(2) ||
            (await isGuestBanned(me.key.slice(2)))
          )
            throw new HttpError(403, 'USER_BANNED');
        },
        handler: (data) => action(data),
        mapError: (error) => ({
          ok: false,
          code: error instanceof HttpError
            ? error.code
            : (error as { code?: string })?.code === 'VALIDATION_FAILED'
              ? 'VALIDATION_FAILED'
              : error instanceof Error && error.message === 'RESOURCE_BUSY'
                ? 'LOCATION_BUSY'
                : error instanceof Error && error.message === 'REDIS_UNAVAILABLE'
                  ? 'REDIS_UNAVAILABLE'
                  : 'INTERNAL_ERROR',
          ...(error instanceof HttpError ? error.details ?? {} : {}),
        }),
      });

    const register = (room: RoomState, changes: RoomChanges, protocol: LocationProtocol) => {
      if (protocol !== 1 || room.v1Seats?.includes(me.key)) return;
      room.v1Seats = [...(room.v1Seats ?? []), me.key];
      changes.internal = true;
    };

    /** Mutate as a member and subscribe this page's socket to the room. */
    const memberAction = async (roomId: string, action: (room: RoomState, changes: RoomChanges, now: number) => void | Promise<void>) => {
      const protocol = socketProtocol(socket);
      const { room } = await mutateRoom(roomId, async (room, changes, now) => {
        requirePlayer(room, me.key);
        register(room, changes, protocol);
        await action(room, changes, now);
      });
      await subscribeSocket(socket, room, me.key, protocol);
      return ackView(room, me.key, protocol);
    };

    handle(
      'location:room:create',
      z.object({ difficulty: difficultySchema, duration: z.union([z.literal(60), z.literal(120), z.literal(180)]) }),
      async (data) => {
        const protocol = socketProtocol(socket);
        const room = await createLocationRoom(socket, me, data.difficulty, data.duration, protocol);
        return viewFor(room, me.key, protocol);
      }
    );
    handle('location:room:join', roomIdSchema, async (data) => {
      const protocol = socketProtocol(socket);
      let claimed = false;
      try {
        const { room } = await mutateRoom(data.roomId, async (room, changes) => {
          const existing = room.players.find((p) => p.identity.key === me.key);
          if (!existing) {
            if (room.status !== 'waiting' || room.players.length >= 8) throw new HttpError(409, 'LOCATION_ROOM_UNAVAILABLE');
            await claimOccupancyOrThrow(roomRef(room.id), [me.key]).catch(occupancyFailure);
            claimed = true;
          }
          joinPlayer(room, me, socket.id, changes);
          register(room, changes, protocol);
        });
        if (claimed) await cancelQueues(me.key);
        await subscribeSocket(socket, room, me.key, protocol);
        return viewFor(room, me.key, protocol);
      } catch (error) {
        if (claimed) await releaseOccupancy(roomRef(data.roomId), [me.key]);
        throw error;
      }
    });
    handle('location:room:state', stateSchema, async (data) => {
      const protocol = socketProtocol(socket);
      let room = await getLocationRoom(data.roomId);
      requirePlayer(room, me.key);
      // Subscribe before reading the view so no later revision can be missed.
      await subscribeSocket(socket, room, me.key, protocol);
      if (protocol === 1 && !room.v1Seats?.includes(me.key) && !isTerminal(room)) {
        room = (await mutateRoom(data.roomId, (locked, changes) => register(locked, changes, protocol))).room;
      } else {
        room = await getLocationRoom(data.roomId);
      }
      return viewFor(room, me.key, protocol, data.mapsHash);
    });
    handle('location:room:unsubscribe', roomIdSchema, async () => {
      await unsubscribeSocket(socket);
      return { ok: true };
    });
    handle('location:room:ready', roomIdSchema.extend({ ready: z.boolean() }), (data) =>
      memberAction(data.roomId, (room, changes) => setReady(room, me.key, data.ready, changes)));
    handle('location:room:rematch', roomIdSchema.extend({ gameId: z.string().uuid(), wanted: z.boolean() }), (data) =>
      memberAction(data.roomId, async (room, changes, now) => {
        if (room.status !== 'finished' || room.gameId !== data.gameId) throw new HttpError(409, 'REMATCH_NOT_AVAILABLE');
        await updateRematch(room, changes, now, me.key, data.wanted);
      }));
    handle('location:room:start', roomIdSchema, (data) =>
      memberAction(data.roomId, async (room, changes, now) => {
        if (room.host !== me.key) throw new HttpError(403, 'FORBIDDEN');
        assertStartable(room);
        startGame(room, await randomSelection(room.difficulty), now, changes);
      }));
    handle('location:room:answer', roomIdSchema.merge(answerSchema).extend({ gameId: z.string().uuid() }), (data) =>
      memberAction(data.roomId, (room, changes, now) => {
        if (data.gameId !== room.gameId) throw new HttpError(409, 'LOCATION_ROUND_LOCKED');
        const { roomId: _id, gameId: _gameId, ...input } = data;
        answer(room, me.key, input, now, changes);
      }));
    handle('location:room:leave', roomIdSchema, async (data) => {
      const room = await readRoom(data.roomId);
      if (!room) throw new HttpError(404, 'LOCATION_ROOM_NOT_FOUND');
      requirePlayer(room, me.key);
      // Leaving a finished room only unsubscribes; it never re-queues settlement.
      if (room.status === 'finished') await mutateRoom(data.roomId, (locked, changes) => {
        if (locked.status !== 'finished') throw new HttpError(409, 'REMATCH_NOT_AVAILABLE');
        const votes = locked.rematch ?? { acceptedKeys: [], requiredKeys: locked.players.filter(p => !p.retired && p.connected).map(p => p.identity.key) };
        locked.rematch = {
          ...votes,
          leftKeys: [...new Set([...(votes.leftKeys ?? []), me.key])],
          acceptedKeys: votes.acceptedKeys.filter(key => key !== me.key),
          requiredKeys: votes.requiredKeys.filter(key => key !== me.key),
        };
        changes.sections.add('rematch');
      });
      if (!isTerminal(room)) await mutateRoom(data.roomId, (locked, changes) => leavePlayer(locked, me.key, changes));
      await releaseOccupancy(roomRef(data.roomId), [me.key]);
      await unsubscribeSocket(socket);
      return { ok: true };
    });
    handle('location:match:cancel', z.object({ difficulty: difficultySchema }), async () => {
      await cancelQueues(me.key);
      return { ok: true };
    });
    handle('location:match:join', z.object({ difficulty: difficultySchema }), async (data) => {
      const occupied = await locationOccupancyCheck(me.key);
      if (occupied) throw occupied;
      return matchmake(io, socket, me, data.difficulty);
    });
  });

  return async () => {
    unregisterSchedules();
    unregisterAdapter();
    await Promise.all(stops.map((stop) => stop()));
    await Promise.allSettled([...inFlight]);
    locationIo = null;
  };
}

/** Matchmaking needs a free seat anywhere on the site (including other 图寻 rooms). */
async function locationOccupancyCheck(identity: string): Promise<HttpError | null> {
  const ref = await resolveOccupancy(identity);
  if (!ref) return null;
  const error = await occupiedError(ref, identity);
  return new HttpError(409, 'LOCATION_ALREADY_IN_ROOM', { occupied: error.occupied });
}
