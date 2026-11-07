import { matchOwner, identityKeys } from "./claims";
import { processBuilds } from "./buildJobs";
import type { Server } from "socket.io";
import { authenticateCookie, getGuestFromCookie } from "../middleware/auth";
import { isGuestBanned } from "../services/guestAccounts";
import { socketAllowedWithIp } from "../socket/connection";
import { HttpError } from "../middleware/common";
import { readView, readSnapshot, advanceById, needsAdvance, scheduledAt, rematchMatch, createMatch, joinMatch, controlMatch, commandMatch } from "./matches";
import { z } from 'zod';
import { requestId, createMatchSchema, commandSchema, variantSchema } from './validation';
import { queueMatch, cancelQueue, heartbeatQueue, QUEUE_LEASE_MS } from './matchmaking';
import { activeReservation } from './reservations';
import { cardDirectory } from './directory';
import { sceneFlags } from './operations';
import { RULES } from '@friberg/card-link-core';
import { registerKernelEvent } from '../rooms/kernel/events';
import { db } from '../db/knex';
import { redis, redisKey } from '../redis';
import { cardChannel, setCardPresenceReader } from './presence';
import { flushSettlements, settle } from "./settlement";
import { loadGraph } from "./graphs";
import { publicMatchView, seatMatchView } from "./views";
import type { Owner } from "./types";
import { emitted } from './metrics';
import { activeMatchStatuses, advanceDueMatches } from './scheduler';
import { activateRoomAdapter } from '../rooms/kernel';
import { startLeasedWorker } from '../rooms/kernel/lease';
import { countKernel } from '../rooms/kernel/metrics';
import { claimOccupancy } from '../rooms/kernel/occupancy';
import { attachPresence, detachPresence, onlineIdentities, watchScope } from '../rooms/kernel/presence';
import { dispatchPresenceInBackground } from '../rooms/kernel';
import type { GameRoomAdapter } from '../rooms/kernel/registry';
import { registerScheduleConsumer } from '../rooms/kernel/scheduler';
import { parseScheduleItem } from '../rooms/kernel/schedules';
import { cardSchedules, scheduleTick, setCardKernelHandlers } from './kernel';
import { logTransientWarning } from '../services/transientLog';

let io: Server | null = null;
const channel = cardChannel;
const NOTIFIED_TTL_SECONDS = 86_400;
type Notified = { phase: number; seats: string; revisions: Record<string, number> };
/** Single-instance fallback for the shared notification baseline. */
const localNotified = new Map<string, Notified>();

async function readNotified(id: string): Promise<Notified | null> {
  const client = redis();
  if (!client) return localNotified.get(id) ?? null;
  const raw = await client.get(redisKey(`card-link:notified:${id}`));
  return raw ? JSON.parse(raw) as Notified : null;
}

async function writeNotified(id: string, value: Notified): Promise<void> {
  const client = redis();
  if (!client) {
    localNotified.delete(id);
    localNotified.set(id, value);
    if (localNotified.size > 1000) localNotified.delete(localNotified.keys().next().value!);
    return;
  }
  await client.set(redisKey(`card-link:notified:${id}`), JSON.stringify(value), { EX: NOTIFIED_TTL_SECONDS });
}

/**
 * Push the committed state to every seat. The last delivered revisions are
 * shared through Redis, so a patch prepared on any instance carries the base
 * the client actually holds (the old per-instance cache produced stale bases
 * and forced HTTP reloads). Shared view parts are computed once.
 */
export async function notifyMatch(id: string) {
  if (!io) return;
  const { m, rows } = await readSnapshot(id),
    g = await loadGraph(m.questions[0].graphVersion);
  if (!rows.length) return;
  const shared = publicMatchView(m, rows, g);
  const summary = JSON.stringify(shared.players),
    old = await readNotified(id),
    phaseChanged = !old || old.phase !== m.revision;
  for (const row of rows) {
    const key = String(row.identity_key);
    const revision = Number(row.revision);
    const privateChanged = !old || old.revisions[key] !== revision;
    if (!phaseChanged && !privateChanged && old!.seats === summary) continue;
    const view = seatMatchView(m, rows, key, g, shared);
    if (phaseChanged) {
      emitted(id, view);
      io.to(channel(id, key)).emit("card-link:state", view);
    } else {
      const patch = {
        id,
        phaseRevision: m.revision,
        publicRevision: view.publicRevision,
        baseRevision: old!.revisions[key] ?? null,
        revision,
        dueAt: view.dueAt,
        expiresAt: view.expiresAt,
        players: view.players,
        ...(privateChanged ? { current: view.current, connections: view.connections } : {}),
      };
      emitted(id, patch);
      io.to(channel(id, key)).emit("card-link:patch", patch);
    }
  }
  await writeNotified(id, {
    phase: m.revision,
    seats: summary,
    revisions: Object.fromEntries(rows.map((r) => [String(r.identity_key), Number(r.revision)])),
  });
}

async function advanceAndNotify(id: string, presence = false): Promise<void> {
  await advanceById(id, undefined, { presence });
  await notifyMatch(id);
}

/** 卡牌连接 seats are online while any socket watches the match (kernel registry). */
const cardAdapter: GameRoomAdapter = {
  game: 'card-link',
  presence: 'watch',
  async isActiveMember(roomId, identityKey) {
    const row = await db('card_reservations as r')
      .join('card_matches as m', 'm.id', 'r.match_id')
      .where({ 'r.match_id': roomId, 'r.identity_key': identityKey })
      .whereIn('m.status', activeMatchStatuses)
      .first('r.match_id');
    return row ? 'player' : false;
  },
  async describe(roomId) {
    const row = await db('card_matches').where({ id: roomId }).first('status', 'code', 'payload');
    if (!row) return null;
    const round = (JSON.parse(row.payload) as { round?: number }).round;
    return { status: String(row.status), round: typeof round === 'number' ? round + 1 : undefined, code: row.code ?? undefined };
  },
  async onPresence(change) {
    countKernel(`card-link.presence.${change.online ? 'online' : 'offline'}`);
    await advanceAndNotify(change.roomId, true);
  },
  async cancelQueue(identityKey) {
    await db('card_queue').where({ identity_key: identityKey }).delete();
  },
  async adopt() {
    // Matches created before the kernel: claim seats and schedule exact deadlines.
    const rows = await db('card_reservations as r')
      .join('card_matches as m', 'm.id', 'r.match_id')
      .whereIn('m.status', activeMatchStatuses)
      .select('r.identity_key', 'r.match_id', 'm.due_at');
    const scheduled = new Set<string>();
    for (const row of rows) {
      const result = await claimOccupancy({ game: 'card-link', roomId: String(row.match_id) }, [String(row.identity_key)], { staleSameGame: true });
      if (!result.ok) countKernel('occupancy.adoptConflicts');
      if (scheduled.has(String(row.match_id))) continue;
      scheduled.add(String(row.match_id));
      // Spread the first presence inspection instead of a startup thundering herd.
      await cardSchedules.add(`tick|${row.match_id}|0`, Date.now() + 1_000 + Math.floor(Math.random() * 5_000));
    }
  },
};

/** Safety net for deadlines that were not processed on time (and solo games). */
async function sweepDueMatches(): Promise<void> {
  await advanceDueMatches(async (id) => {
    countKernel('card-link.swept');
    await notifyMatch(id);
  });
}

/** Repair presence missed during a deploy or crash (one SQL read, no RPC). */
async function reconcilePresence(): Promise<void> {
  const matches = await db('card_matches').whereIn('scene', ['friend', 'ranked'])
    .whereIn('status', activeMatchStatuses).select('id');
  if (!matches.length) return;
  const ids = matches.map((row) => String(row.id));
  const seats = await db('card_seats').whereIn('match_id', ids).select('match_id', 'identity_key', 'payload');
  const live = await onlineIdentities(ids.map((id) => watchScope('card-link', id)));
  const online = new Map(ids.map((id, index) => [id, live[index]]));
  const stale = new Set<string>();
  for (const seat of seats) {
    const payload = JSON.parse(seat.payload) as { retired?: boolean; connected?: boolean };
    if (payload.retired) continue;
    const isOnline = online.get(String(seat.match_id))?.has(String(seat.identity_key)) ?? false;
    if (isOnline !== (payload.connected !== false)) stale.add(String(seat.match_id));
  }
  for (const id of stale) {
    countKernel('card-link.reconciled');
    await advanceAndNotify(id, true).catch((error) => logTransientWarning('[card-link:reconcile]', error instanceof Error ? error.message : 'FAILED'));
  }
}

/** Builds are rare: check without the catalog lock before taking it. */
async function maybeProcessBuilds(): Promise<void> {
  const pending = await db('card_build_jobs').whereIn('status', ['pending', 'running'])
    .where('due_at', '<=', Date.now()).first('id');
  if (pending) await processBuilds();
}

export function setupCardSocket(server: Server) {
  io = server;
  // Online seats come from the kernel watch registry: one Redis script, no
  // cluster-wide fetchSockets and never inside a SQL transaction.
  setCardPresenceReader(async (match) => (await onlineIdentities([watchScope('card-link', match.id)]))[0]);
  setCardKernelHandlers({
    tick: async (id) => {
      const after = await advanceById(id, undefined, { presence: true });
      await notifyMatch(id);
      await scheduleTick(id, ['finished', 'cancelled'].includes(after.status) ? null : scheduledAt(after));
    },
    settle: async (id) => { await settle(id).catch(() => undefined); await cardSchedules.remove(`settle|${id}|0`); },
  });
  const unregisterAdapter = activateRoomAdapter(cardAdapter);
  const unregisterSchedules = registerScheduleConsumer({
    name: 'card-link',
    source: cardSchedules,
    batch: 40,
    concurrency: 8,
    groupKey: (item) => parseScheduleItem(item).roomId,
    handleGroup: async (items) => {
      for (const item of items) {
        const { kind, roomId } = parseScheduleItem(item);
        try {
          if (kind === 'tick') {
            const after = await advanceById(roomId, undefined, { presence: true });
            await notifyMatch(roomId);
            // Re-arm the exact deadline (a tick that changed nothing still holds its lease).
            await scheduleTick(roomId, ['finished', 'cancelled'].includes(after.status) ? null : scheduledAt(after));
          } else if (kind === 'rematch') {
            await rematchMatch(roomId, null);
            await notifyMatch(roomId);
          } else if (kind === 'settle') {
            await settle(roomId).catch(() => undefined);
            await cardSchedules.remove(item);
          } else await cardSchedules.remove(item);
        } catch (error) {
          if (error instanceof HttpError && error.code === 'CARD_MATCH_NOT_FOUND') await cardSchedules.remove(item);
          else logTransientWarning('[card-link:schedule]', `${roomId}: ${error instanceof Error ? error.message : 'FAILED'}`);
        }
      }
    },
  });
  const stops = [
    startLeasedWorker('card-link-sweep', 10_000, sweepDueMatches),
    startLeasedWorker('card-link-reconcile', 30_000, reconcilePresence),
    startLeasedWorker('card-link-settle', 30_000, flushSettlements),
    startLeasedWorker('card-link-builds', 5_000, maybeProcessBuilds),
  ];
  let stopping = false;
  const pending = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    pending.add(p);
    void p
      .catch((e) =>
        console.error("[card-link]", e instanceof Error ? e.message : "ERROR"),
      )
      .finally(() => pending.delete(p));
  };
  server.on("connection", (socket) => {
    const owner = () => socket.data.identity as Owner;
    const handle = (event: string, schema: z.ZodTypeAny, handler: (data: any) => Promise<unknown>) => registerKernelEvent(socket, {
      event, schema,
      ack: 'envelope', order: 'pending-then-validate', pendingField: 'pendingCardEvents', track,
      before: async () => {
        const me = socket.data.identity as Owner | undefined;
        if (!me) throw new HttpError(401, 'IDENTITY_REQUIRED');
        const limit = event === 'card-link:create' ? 6 : event === 'card-link:rematch' ? 8 : 60;
        if (!(await socketAllowedWithIp(socket, event, me.key, limit, 180, 60))) throw new HttpError(429, 'RATE_LIMITED');
        if (me.userId) {
          if ((await authenticateCookie(socket.handshake.headers.cookie))?.id !== me.userId) throw new HttpError(401, 'AUTH_EXPIRED');
        } else if (getGuestFromCookie(socket.handshake.headers.cookie)?.key !== me.key.slice(2) || await isGuestBanned(me.key.slice(2)))
          throw new HttpError(403, 'USER_BANNED');
      },
      handler,
      mapError: error => ({ ok: false,
        code: error instanceof HttpError ? error.code : (error as { code?: string })?.code === 'VALIDATION_FAILED'
          ? 'VALIDATION_FAILED' : error instanceof Error && error.message === 'REDIS_UNAVAILABLE' ? 'REDIS_UNAVAILABLE' : 'INTERNAL_ERROR',
        ...(error instanceof HttpError ? error.details ?? {} : {}),
      }),
    });
    const idSchema = z.object({ id: z.string().uuid() });
    const multiplayer = async (id: string, subscribed = false) => {
      const { m, rows } = await readSnapshot(id);
      const me = await matchOwner(id, owner());
      if (!rows.some(row => row.identity_key === me.key)) throw new HttpError(403, 'FORBIDDEN');
      if (!['friend', 'ranked'].includes(m.scene)) throw new HttpError(409, 'CARD_ROOM_UNAVAILABLE');
      if (subscribed && socket.data.cardMatchId !== id) throw new HttpError(409, 'CARD_ROOM_UNAVAILABLE');
      return m;
    };
    handle('card-link:config', z.object({}).strict(), async () => {
      const catalog = await db('card_catalog').where({ id: 1 }).first();
      return { enabled: Boolean(catalog?.enabled && catalog.graph_version), scenes: sceneFlags(catalog ?? {}), rules: RULES };
    });
    handle('card-link:active', z.object({}).strict(), async () => {
      const me = owner(), keys = await identityKeys(me);
      const reserved = await activeReservation(db, keys);
      const row = await db('card_queue').where({ identity_key: me.key }).first();
      const queue = row && JSON.parse(row.payload);
      const queued = Boolean(queue?.heartbeatAt && queue.heartbeatAt > Date.now() - QUEUE_LEASE_MS);
      return { id: reserved?.match_id ?? null, queued, ticket: queued ? queue.ticket : null };
    });
    handle('card-link:create', createMatchSchema.refine(data => data.scene === 'friend').strict(), async data =>
      createMatch(owner(), 'friend', data.variant, data.difficulty, data.duration, data.requestId));
    handle('card-link:join', z.object({ code: z.string().regex(/^[A-F0-9]{8}$/) }).strict(), async data => {
      const result = await joinMatch(data.code, owner());
      await notifyMatch(result.id);
      return result;
    });
    handle('card-link:state', idSchema.strict(), async data => {
      await multiplayer(data.id);
      return readView(data.id, owner());
    });
    handle('card-link:directory', idSchema.strict(), async data => {
      const m = await multiplayer(data.id), graph = await loadGraph(m.questions[0].graphVersion);
      return { version: graph.data.version, players: await cardDirectory(graph.data.players, m.variant) };
    });
    handle('card-link:command', idSchema.extend(commandSchema.shape).strict(), async data => {
      await multiplayer(data.id, true);
      const { id, ...input } = data;
      const result = await commandMatch(id, owner(), input, { compact: true });
      await notifyMatch(id);
      return result;
    });
    handle('card-link:control', idSchema.extend({ action: z.enum(['ready', 'start', 'leave']), requestId }).strict(), async data => {
      await multiplayer(data.id);
      const result = await controlMatch(data.id, owner(), data.action, data.requestId);
      await notifyMatch(data.id);
      return result;
    });
    handle('card-link:rematch', idSchema.extend({ wanted: z.boolean(), requestId }).strict(), async data => {
      await multiplayer(data.id, true);
      const result = await rematchMatch(data.id, owner(), data.wanted, data.requestId);
      await notifyMatch(data.id);
      return result;
    });
    handle('card-link:queue:join', z.object({ variant: variantSchema }).strict(), data => queueMatch(owner(), data.variant));
    handle('card-link:queue:heartbeat', z.object({ ticket: requestId }).strict(), data => heartbeatQueue(owner(), data.ticket));
    handle('card-link:queue:cancel', z.object({ ticket: requestId.optional() }).strict(), data => cancelQueue(owner(), data.ticket));
    let watchRevision = 0;
    let pendingWatches = 0;
    let leaving: Promise<void> | null = null;
    /** Leave the watched match: presence detaches; the kernel reports offline transitions. */
    const unwatch = async () => {
      const previousId = socket.data.cardMatchId as string | undefined;
      const previousChannel = socket.data.cardChannel as string | undefined;
      socket.data.cardChannel = null;
      socket.data.cardMatchId = null;
      if (previousChannel) await socket.leave(previousChannel);
      if (previousId) {
        const transition = await detachPresence(socket.id, watchScope('card-link', previousId));
        if (transition && !stopping) dispatchPresenceInBackground([transition], 'unwatch');
      }
    };
    socket.on("card-link:watch", (raw, ack) => {
      if (pendingWatches >= 8) {
        if (typeof ack === 'function') ack({ ok: false, code: 'RATE_LIMITED' });
        return;
      }
      pendingWatches++;
      const revision = ++watchRevision;
      const current = () => revision === watchRevision && socket.connected;
      let responded = false;
      const respond = (value: unknown) => {
        if (responded) return;
        responded = true;
        if (typeof ack === 'function') ack(value);
      };
      const task = (async () => {
        const me = socket.data.identity as Owner;
        if (!me) throw new HttpError(401, "IDENTITY_REQUIRED");
        if (
          !(await socketAllowedWithIp(
            socket,
            "card-link:watch",
            me.key,
            60,
            180,
            60,
          ))
        )
          throw new HttpError(429, "RATE_LIMITED");
        if (!current()) return;
        if (me.userId) {
          if (
            (await authenticateCookie(socket.handshake.headers.cookie))?.id !==
            me.userId
          )
            throw new HttpError(401, "AUTH_EXPIRED");
        } else if (
          getGuestFromCookie(socket.handshake.headers.cookie)?.key !==
            me.key.slice(2) ||
          (await isGuestBanned(me.key.slice(2)))
        )
          throw new HttpError(403, "USER_BANNED");
        if (typeof raw?.id !== "string" || raw.id.length !== 36)
          throw new HttpError(400, "VALIDATION_FAILED");
        const seatKey = (await matchOwner(raw.id, me)).key;
        // Membership check without advancing (cheap, read-only).
        const snapshot = await readSnapshot(raw.id);
        if (!snapshot.rows.some((r) => r.identity_key === seatKey)) throw new HttpError(403, 'FORBIDDEN');
        if (!current()) return;
        if (socket.data.cardMatchId && socket.data.cardMatchId !== raw.id) await unwatch();
        if (!current()) return;
        const nextChannel = channel(raw.id, seatKey);
        socket.data.cardChannel = nextChannel;
        socket.data.cardMatchId = raw.id;
        await socket.join(nextChannel);
        if (!current()) {
          if (socket.data.cardChannel !== nextChannel) await socket.leave(nextChannel);
          return;
        }
        // Attach only a still-current watch; superseded watches never leave presence behind.
        const cameOnline = await attachPresence(socket.id, seatKey, watchScope('card-link', raw.id));
        // Subscribed before reading, so a concurrent command cannot be missed.
        const disconnected = snapshot.rows.some((r) => r.identity_key === seatKey &&
          (JSON.parse(r.payload) as { connected?: boolean }).connected === false);
        if (cameOnline && (disconnected || needsAdvance(snapshot.m, snapshot.rows))) await advanceAndNotify(raw.id, true);
        const view = await readView(raw.id, me);
        if (current()) respond({ ok: true, data: view });
      })().catch((e) => {
        if (current())
          respond({
            ok: false,
            code: e instanceof HttpError ? e.code : "INTERNAL_ERROR",
          });
      }).finally(() => {
        pendingWatches--;
        // Even a superseded request must release Socket.IO's client-side ack
        // callback; silently abandoning it leaks one callback per quick switch.
        if (!responded) respond({ ok: false, code: 'CARD_WATCH_SUPERSEDED' });
      });
      track(task);
    });
    socket.on("card-link:unwatch", () => {
      watchRevision++;
      if (!leaving) {
        leaving = unwatch().finally(() => { leaving = null; });
        track(leaving);
      }
    });
    socket.on('disconnect', () => { watchRevision++; });
  });
  return async () => {
    stopping = true;
    unregisterSchedules();
    unregisterAdapter();
    await Promise.all(stops.map((stop) => stop()));
    await Promise.allSettled([...pending]);
    io = null;
    setCardPresenceReader(null);
    setCardKernelHandlers({ tick: null, settle: null });
    localNotified.clear();
  };
}
