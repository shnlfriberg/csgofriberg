import { matchOwner } from "./claims";
import { processBuilds } from "./buildJobs";
import { advanceDueMatches } from './scheduler';
import type { Server } from "socket.io";
import { authenticateCookie, getGuestFromCookie } from "../middleware/auth";
import { isGuestBanned } from "../services/guestAccounts";
import { socketAllowedWithIp } from "../socket/connection";
import { getRequestPow } from "../services/pow";
import { config } from "../config";
import { HttpError } from "../middleware/common";
import {
  readView,
  readSnapshot,
  advanceById,
} from "./matches";
import { db } from '../db/knex';
import { cardChannel, setCardPresenceReader } from './presence';
import { flushSettlements } from "./settlement";
import { loadGraph } from "./graphs";
import { matchView } from "./views";
import type { Owner } from "./types";
import { emitted } from './metrics';
let io: Server | null = null;
const recent = new Map<
  string,
  { phase: number; seats: string; revisions: Map<string, number> }
>();
const channel = cardChannel;
export async function notifyMatch(id: string) {
  if (!io) return;
  const { m, rows } = await readSnapshot(id),
    g = await loadGraph(m.questions[0].graphVersion);
  const views = rows.map((r) => ({
    row: r,
    view: matchView(m, rows, r.identity_key, g),
  }));
  if (!views.length) return;
  const summary = JSON.stringify(views[0].view.players),
    old = recent.get(id),
    phaseChanged = !old || old.phase !== m.revision;
  for (const { row, view } of views) {
    const privateChanged =
      !old || old.revisions.get(row.identity_key) !== Number(row.revision);
    if (phaseChanged) {
      emitted(id, view);
      io.to(channel(id, row.identity_key)).emit("card-link:state", view);
    } else if (privateChanged || old.seats !== summary) {
      const patch = {
        id,
        phaseRevision: m.revision,
        publicRevision: view.publicRevision,
        baseRevision: old.revisions.get(row.identity_key) ?? null,
        revision: Number(row.revision),
        dueAt: view.dueAt,
        expiresAt: view.expiresAt,
        players: view.players,
        ...(privateChanged ? { current: view.current, connections: view.connections } : {}),
      };
      emitted(id, patch);
      io.to(channel(id, row.identity_key)).emit("card-link:patch", patch);
    }
  }
  recent.delete(id);
  recent.set(id, {
    phase: m.revision,
    seats: summary,
    revisions: new Map(rows.map((r) => [r.identity_key, Number(r.revision)])),
  });
  if (recent.size > 1000) recent.delete(recent.keys().next().value!);
}
export function setupCardSocket(server: Server) {
  io = server;
  setCardPresenceReader(async (match, rows) => {
    const channels = rows.map(row => channel(match.id, row.identity_key));
    const sockets = await server.in(channels).fetchSockets();
    return new Set(rows.filter((row, index) => sockets.some(socket => socket.rooms.has(channels[index])))
      .map(row => row.identity_key));
  });
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
    let watchRevision = 0;
    const resync = async (id: string | undefined) => {
      if (!id || stopping) return;
      await advanceById(id);
      await notifyMatch(id);
    };
    socket.on('disconnect', () => { watchRevision++; track(resync(socket.data.cardMatchId)); });
    socket.on("card-link:watch", (raw, ack) => {
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
        const proof = getRequestPow({
          headers: socket.handshake.headers,
          ip: socket.data.ip,
        });
        if (!proof || proof.difficulty < config.powDifficulty)
          throw new HttpError(428, "POW_REQUIRED");
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
        await readView(raw.id, me);
        const nextChannel = channel(raw.id, (await matchOwner(raw.id, me)).key);
        if (!current()) return;
        if (socket.data.cardChannel)
          await socket.leave(socket.data.cardChannel);
        const previousId = socket.data.cardMatchId;
        if (!current()) return;
        socket.data.cardChannel = nextChannel;
        socket.data.cardMatchId = raw.id;
        await socket.join(nextChannel);
        if (!current()) {
          if (socket.data.cardChannel !== nextChannel) await socket.leave(nextChannel);
          return;
        }
        // Read again after subscribing so a concurrent command cannot be missed.
        const view = await readView(raw.id, me);
        if (current()) respond({ ok: true, data: view });
        if (current()) {
          track(notifyMatch(raw.id));
          if (previousId && previousId !== raw.id) track(resync(previousId));
        }
      })().catch((e) => {
        if (current())
          respond({
            ok: false,
            code: e instanceof HttpError ? e.code : "INTERNAL_ERROR",
          });
      }).finally(() => {
        // Even a superseded request must release Socket.IO's client-side ack
        // callback; silently abandoning it leaks one callback per quick switch.
        if (!responded) respond({ ok: false, code: 'CARD_WATCH_SUPERSEDED' });
      });
      track(task);
    });
    socket.on("card-link:unwatch", () => {
      watchRevision++;
      if (socket.data.cardChannel) {
        const previousId = socket.data.cardMatchId;
        const leaving = socket.leave(socket.data.cardChannel);
        socket.data.cardChannel = null;
        socket.data.cardMatchId = null;
        track(Promise.resolve(leaving).then(() => resync(previousId)));
      }
    });
  });
  let running = false;
  let adopted = false;
  const tick = async () => {
    if (running || stopping) return;
    running = true;
    try {
      if (!adopted) {
        // Old active multiplayer payloads remain intact; schedule a first
        // presence check without waiting for their original round deadline.
        await db('card_matches').whereIn('scene', ['friend', 'ranked'])
          .whereIn('status', ['waiting', 'preparing', 'playing', 'roundOver'])
          .where(q => q.where('due_at', '>', Date.now()).orWhereNull('due_at'))
          .update({ due_at: Date.now() });
        adopted = true;
      }
      await advanceDueMatches(notifyMatch);
      await flushSettlements();
      track(processBuilds());
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => track(tick()), 1000);
  timer.unref();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await Promise.allSettled([...pending]);
    io = null;
    setCardPresenceReader(null);
    recent.clear();
  };
}
