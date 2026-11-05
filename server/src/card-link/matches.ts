import { matchOwner, identityKeys } from "./claims";
import { randomBytes, randomInt, randomUUID } from "crypto";
import type { Knex } from "knex";
import {
  applyCommand,
  createRound,
  recoverRound,
  stopRound,
  RuleError,
  type Command,
  type Difficulty,
  type Scene,
  type Variant,
} from "@friberg/card-link-core";
import { db } from "../db/knex";
import { HttpError } from "../middleware/common";
import { activeGraph, loadGraph, selectQuestions } from "./graphs";
import { transaction, lockRow, receipt } from "./transaction";
import { matchView } from "./views";
import type { Match, Owner, Seat, SeatRow } from "./types";
import { needsExpiryPolicy, nextShanghaiMidnight, singleDueAt, singleScene, SOLO_IDLE_MS } from './expiry';
import { activeReservation, clearEndedReservations } from './reservations';
import { requireScene } from './operations';
import { measured, observe } from './metrics';
import { performance } from 'node:perf_hooks';
import { onlineCardPlayers, CARD_DISCONNECT_MS, CARD_PRESENCE_INTERVAL_MS } from './presence';
export type GraphLoaded = Awaited<ReturnType<typeof loadGraph>>;
function scheduledAt(m: Match) {
  if (singleScene(m) || ['finished', 'cancelled'].includes(m.status)) return m.dueAt;
  return Math.min(m.dueAt ?? Infinity, Date.now() + CARD_PRESENCE_INTERVAL_MS);
}
export const today = (now = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
export async function getMatch(id: string) {
  const row = await db("card_matches").where({ id }).first();
  if (!row) throw new HttpError(404, "CARD_MATCH_NOT_FOUND");
  return JSON.parse(row.payload) as Match;
}
export async function saveMatch(trx: Knex.Transaction, m: Match) {
  await trx("card_matches")
    .where({ id: m.id })
    .update({
      status: m.status,
      revision: m.revision,
      due_at: scheduledAt(m),
      payload: JSON.stringify(m),
    });
}
export async function saveSeat(trx: Knex.Transaction, row: SeatRow, s: Seat) {
  const changed = await trx("card_seats")
    .where({
      match_id: row.match_id,
      identity_key: row.identity_key,
      revision: row.revision,
    })
    .update({ revision: Number(row.revision) + 1, payload: JSON.stringify(s) });
  if (changed !== 1) throw new HttpError(409, "CARD_VERSION_CONFLICT");
  row.revision = Number(row.revision) + 1;
  row.payload = JSON.stringify(s);
}
export async function rowsFor(
  trx: Knex | Knex.Transaction,
  id: string,
): Promise<SeatRow[]> {
  return trx("card_seats").where({ match_id: id }).orderBy("identity_key");
}
export async function reserve(trx: Knex.Transaction, owner: Owner, id: string) {
  const keys = await identityKeys(owner, trx);
  await clearEndedReservations(trx, keys);
  const old = await activeReservation(trx, keys);
  if (old && old.match_id !== id)
    throw new HttpError(409, "CARD_ALREADY_PLAYING");
  await trx("card_reservations")
    .insert({ identity_key: owner.key, match_id: id })
    .onConflict("identity_key")
    .ignore();
}
export async function insertSeat(
  trx: Knex.Transaction,
  m: Match,
  o: Owner,
  g: GraphLoaded,
) {
  const s: Seat = {
    owner: o,
    ready: false,
    retired: false,
    current:
      m.status === "playing"
        ? createRound(
            g.index,
            m.questions[0],
            m.variant,
            randomInt(1, 0xffffffff),
            m.createdAt,
            m.duration === 0 ? null : m.duration,
          )
        : null,
    results: [],
  };
  await trx("card_seats").insert({
    match_id: m.id,
    identity_key: o.key,
    revision: 0,
    payload: JSON.stringify(s),
  });
}
export async function createMatchIn(
  trx: Knex.Transaction,
  owners: Owner[],
  scene: Scene,
  variant: Variant,
  difficulty: Difficulty,
  duration: number,
  g: GraphLoaded,
  options: { dailyPractice?: boolean; now?: number } = {},
) {
  const now = options.now ?? Date.now(),
    day = scene === "daily" ? today(now) : null;
  let questions = selectQuestions(
    g,
    difficulty,
    ["friend", "ranked"].includes(scene) ? 3 : 1,
  );
  if (day) {
    const old = await trx("card_daily").where({ day, variant }).first();
    if (old) questions = JSON.parse(old.payload);
    else
      await trx("card_daily").insert({
        day,
        variant,
        payload: JSON.stringify(questions),
      });
  }
  const matchGraph =
    questions[0].graphVersion === g.data.version
      ? g
      : await loadGraph(questions[0].graphVersion, trx);
  const m: Match = {
    id: randomUUID(),
    code:
      scene === "friend" ? randomBytes(4).toString("hex").toUpperCase() : null,
    host: owners[0].key,
    scene,
    variant,
    difficulty,
    status:
      ["friend", "ranked"].includes(scene)
        ? "waiting"
        : "playing",
    revision: 0,
    round: 0,
    questions,
    duration: scene === 'daily' ? 0 : duration,
    dueAt:
      scene === "friend"
        ? now + 1800000
        : scene === "ranked"
          ? now + CARD_DISCONNECT_MS
          : scene === "practice" && duration === 0
            ? null
            : now + duration * 1000,
    day,
    ...(options.dailyPractice ? { dailyPractice: true } : {}),
    createdAt: now,
    rulesVersion: 1,
  };
  if (singleScene(m)) {
    m.expiresAt = scene === 'daily' ? nextShanghaiMidnight(day!) : now + SOLO_IDLE_MS;
    m.dueAt = singleDueAt(m);
  }
  await trx("card_matches").insert({
    id: m.id,
    code: m.code,
    scene,
    variant,
    status: m.status,
    revision: 0,
    due_at: scheduledAt(m),
    payload: JSON.stringify(m),
  });
  if (day && !m.dailyPractice)
    await trx("card_daily_attempts").insert({
      day,
      variant,
      identity_key: owners[0].key,
      match_id: m.id,
    });
  for (const o of owners) {
    if (["friend", "ranked"].includes(scene)) await reserve(trx, o, m.id);
    await insertSeat(trx, m, o, matchGraph);
  }
  return m;
}
export async function createMatch(
  owner: Owner,
  scene: "practice" | "daily" | "friend",
  variant: Variant,
  difficulty: Difficulty,
  duration: number,
  requestId: string,
) {
  const catalog = await db("card_catalog").where({ id: 1 }).first();
  if (!catalog?.graph_version) throw new HttpError(503, "CARD_NOT_READY");
  let g = await loadGraph(catalog.graph_version);
  if (scene === "daily") {
    const daily = await db("card_daily")
      .where({ day: today(), variant })
      .first();
    if (daily) g = await loadGraph(JSON.parse(daily.payload)[0].graphVersion);
  }
  return transaction(async (trx) => {
    const currentCatalog = await lockRow(trx, "card_catalog", { id: 1 });
    return receipt(
      trx,
      `create:${owner.key}`,
      requestId,
      { scene, variant, difficulty, duration },
      async () => {
        const now = Date.now(), day = today(now);
        let dailyPractice = false;
        if (scene === "daily") {
          const previous = await trx("card_daily_attempts")
            .where({ day, variant, identity_key: owner.key })
            .first();
          if (previous) {
            const original = await lockRow(trx, 'card_matches', { id: previous.match_id });
            if (!['finished', 'cancelled'].includes(original.status))
              return { id: String(previous.match_id) };
            dailyPractice = true;
            // The initial-attempt pointer is only a resume anchor, not a ranking
            // eligibility gate. Keep every result immutable. Repeated clicks,
            // tabs and guest claims resume the same still-active daily practice.
            const active = await trx('card_seats as s')
              .join('card_matches as m', 'm.id', 's.match_id')
              .whereIn('s.identity_key', await identityKeys(owner, trx))
              .where({ 'm.scene': 'daily', 'm.variant': variant, 'm.status': 'playing' })
              .select('m.id', 'm.payload');
            const resumed = active.find(row => {
              const match: Match = JSON.parse(row.payload);
              return match.day === day && match.dailyPractice === true &&
                match.dueAt !== null && match.dueAt > now;
            });
            if (resumed) return { id: String(resumed.id) };
          }
        }
        requireScene(currentCatalog, scene);
        // Publication and game creation share the catalog lock. A preload may
        // have raced publication; daily questions keep their already pinned graph.
        if (
          scene !== "daily" &&
          g.data.version !== currentCatalog.graph_version
        )
          g = await loadGraph(currentCatalog.graph_version, trx);
        const m = await createMatchIn(
          trx,
          [owner],
          scene,
          variant,
          scene === "daily" ? "normal" : difficulty,
          scene === "daily" ? 0 : duration,
          g,
          { dailyPractice, now },
        );
        return { id: m.id };
      },
    );
  });
}
export async function readSnapshot(id: string) {
  return transaction(async (trx) => {
    const row = await lockRow(trx, "card_matches", { id });
    if (!row) throw new HttpError(404, "CARD_MATCH_NOT_FOUND");
    return {
      m: JSON.parse(row.payload) as Match,
      rows: await rowsFor(trx, id),
    };
  });
}
export async function readView(id: string, owner: Owner) {
  owner = await matchOwner(id, owner);
  let { m, rows } = await readSnapshot(id);
  if (!rows.some((r) => r.identity_key === owner.key))
    throw new HttpError(403, "FORBIDDEN");
  if (!singleScene(m) && !['finished', 'cancelled'].includes(m.status)) {
    await advanceById(id);
    ({ m, rows } = await readSnapshot(id));
    if (!rows.some(r => r.identity_key === owner.key)) throw new HttpError(403, 'CARD_ROOM_UNAVAILABLE');
  }
  const g = await loadGraph(m.questions[0].graphVersion);
  const seat: Seat = JSON.parse(rows.find(r => r.identity_key === owner.key)!.payload);
  const recover = m.status === 'playing' && m.variant === 'limited' && !seat.retired && seat.current &&
    (m.dueAt === null || m.dueAt > Date.now()) && recoverRound(g.index, m.questions[m.round], seat.current);
  if (recover || (singleScene(m) && m.status === 'playing' &&
      (needsExpiryPolicy(m) || (m.dueAt !== null && Date.now() >= m.dueAt)))) {
    await advanceById(id, recover ? owner.key : undefined);
    ({ m, rows } = await readSnapshot(id));
  }
  return matchView(m, rows, owner.key, g);
}
async function finish(trx: Knex.Transaction, m: Match, now: number) {
  m.status = "finished";
  m.dueAt = null;
  m.revision++;
  await saveMatch(trx, m);
  await trx('card_reservations').where({ match_id: m.id }).delete();
  await trx("card_outbox")
    .insert({ match_id: m.id, attempts: 0, due_at: now })
    .onConflict("match_id")
    .ignore();
}
async function cancelMatch(trx: Knex.Transaction, m: Match) {
  m.status = 'cancelled';
  m.dueAt = null;
  m.revision++;
  await saveMatch(trx, m);
  await trx('card_reservations').where({ match_id: m.id }).delete();
}

async function syncConnections(trx: Knex.Transaction, m: Match, rows: SeatRow[], now: number) {
  const online = await onlineCardPlayers(m, rows);
  if (online === null) return;
  const expired: SeatRow[] = [];
  for (const row of rows) {
    const s: Seat = JSON.parse(row.payload);
    if (s.retired) continue;
    // An expired lease cannot be revived by a late reconnect, including when
    // the scheduler has not visited the room yet.
    if (s.disconnectAt != null && s.disconnectAt <= now) {
      s.retired = true;
      s.connected = false;
      if (s.current) stopRound(s.current, Math.min(now, m.dueAt ?? now));
      s.disconnectAt = null;
      expired.push(row);
      await saveSeat(trx, row, s);
    } else if (online.has(row.identity_key)) {
      if (s.connected !== true || s.disconnectAt != null) {
        s.connected = true;
        s.disconnectAt = null;
        await saveSeat(trx, row, s);
      }
    } else if (s.connected !== false || s.disconnectAt == null) {
      s.connected = false;
      s.disconnectAt = now + CARD_DISCONNECT_MS;
      await saveSeat(trx, row, s);
    }
  }
  if (!expired.length) return;
  if (m.status === 'waiting') {
    if (m.scene === 'ranked') { await cancelMatch(trx, m); return; }
    for (const row of expired) {
      await trx('card_seats').where({ match_id: m.id, identity_key: row.identity_key }).delete();
      await trx('card_reservations').where({ match_id: m.id, identity_key: row.identity_key }).delete();
      rows.splice(rows.indexOf(row), 1);
    }
    if (!rows.length) { await cancelMatch(trx, m); return; }
    if (!rows.some(r => r.identity_key === m.host)) m.host = rows[0].identity_key;
    m.revision++;
    await saveMatch(trx, m);
  } else if (m.scene === 'ranked') {
    for (const row of rows) {
      const s: Seat = JSON.parse(row.payload);
      if (s.current) {
        stopRound(s.current, Math.min(now, m.dueAt ?? now));
        s.results[m.round] = s.current.best;
      }
      await saveSeat(trx, row, s);
    }
    await finish(trx, m, now);
  }
}
export async function advance(
  trx: Knex.Transaction,
  m: Match,
  rows: SeatRow[],
  g: GraphLoaded,
  now: number,
) {
  if (["finished", "cancelled"].includes(m.status)) return;
  if (!singleScene(m)) {
    await syncConnections(trx, m, rows, now);
    if (['finished', 'cancelled'].includes(m.status)) return;
  }
  if (needsExpiryPolicy(m)) {
    // Legacy games have no last-action timestamp: grant one idle grace window
    // instead of guessing activity from creation time. Finished scores stay immutable.
    m.expiresAt = m.scene === 'daily'
      ? nextShanghaiMidnight(m.day!) : now + SOLO_IDLE_MS;
    if (m.scene === 'daily') {
      m.duration = 0;
      for (const row of rows) {
        const seat: Seat = JSON.parse(row.payload);
        if (seat.current) seat.current.deadline = null;
        await saveSeat(trx, row, seat);
      }
    }
    m.dueAt = singleDueAt(m);
    m.revision++;
    await saveMatch(trx, m);
  }
  if (m.status === "waiting") {
    if (m.dueAt !== null && now >= m.dueAt) {
      await cancelMatch(trx, m);
    } else if (m.scene === 'ranked' && rows.length === 2 && rows.every(r => {
      const s: Seat = JSON.parse(r.payload);
      return s.ready && !s.retired && s.connected !== false;
    })) {
      m.status = 'preparing';
      m.dueAt = now + 3000;
      m.revision++;
      await saveMatch(trx, m);
    }
    return;
  }
  if (
    rows.length &&
    rows.every((r) => (JSON.parse(r.payload) as Seat).retired)
  ) {
    for (const row of rows) {
      const s: Seat = JSON.parse(row.payload);
      if (s.current) s.results[m.round] = s.current.best;
      await saveSeat(trx, row, s);
    }
    await finish(trx, m, now);
    return;
  }
  if (m.status === "preparing" && m.dueAt !== null && now >= m.dueAt) {
    const start = m.dueAt;
    m.status = "playing";
    m.dueAt = start + m.duration * 1000;
    m.revision++;
    for (const row of rows) {
      const s: Seat = JSON.parse(row.payload);
      s.current = createRound(
        g.index,
        m.questions[m.round],
        m.variant,
        randomInt(1, 0xffffffff),
        start,
        m.duration,
      );
      if (s.retired) stopRound(s.current, start);
      await saveSeat(trx, row, s);
    }
    await saveMatch(trx, m);
  }
  if (
    m.status === "playing" &&
    ((m.dueAt !== null && now >= m.dueAt) ||
      rows.every((r) => (JSON.parse(r.payload) as Seat).current?.locked))
  ) {
    for (const row of rows) {
      const s: Seat = JSON.parse(row.payload);
      if (s.current) {
        stopRound(s.current, Math.min(now, m.dueAt ?? now));
        s.results[m.round] = s.current.best;
      } else s.results[m.round] = null;
      await saveSeat(trx, row, s);
    }
    if (m.round + 1 >= m.questions.length) await finish(trx, m, now);
    else {
      m.status = "roundOver";
      m.dueAt = now + 8000;
      m.revision++;
      await saveMatch(trx, m);
    }
  }
  if (m.status === "roundOver" && m.dueAt !== null && now >= m.dueAt) {
    m.round++;
    for (const row of rows) {
      const s: Seat = JSON.parse(row.payload);
      s.current = null;
      await saveSeat(trx, row, s);
    }
    m.status = "preparing";
    m.dueAt = now + 3000;
    m.revision++;
    await saveMatch(trx, m);
  }
}
async function executeCommand(
  id: string,
  owner: Owner,
  input: {
    requestId: string;
    revision: number;
    phaseRevision: number;
    command: Command;
  },
) {
  owner = await matchOwner(id, owner);
  const before = await getMatch(id),
    g = await loadGraph(before.questions[0].graphVersion);
  return transaction(async (trx) => {
    const row = await lockRow(trx, "card_matches", { id });
    const m: Match = JSON.parse(row.payload);
    const rows = await rowsFor(trx, id);
    const seatRow = rows.find((r) => r.identity_key === owner.key);
    if (!seatRow) throw new HttpError(403, "FORBIDDEN");
    return receipt(
      trx,
      `command:${id}:${owner.key}`,
      input.requestId,
      input,
      async () => {
        if (m.status !== "playing")
          throw new HttpError(409, "CARD_ROUND_LOCKED");
        // Check the authoritative expiry under the row lock, even if the worker
        // has not settled this room yet. Late commands must never renew a room.
        const now = Date.now();
        const cutoff = needsExpiryPolicy(m) && m.scene === 'daily'
          ? nextShanghaiMidnight(m.day!) : m.dueAt;
        if (cutoff !== null && now >= cutoff)
          throw new HttpError(409, 'CARD_TIME_EXPIRED');
        if (
          Number(seatRow.revision) !== input.revision ||
          m.revision !== input.phaseRevision
        )
          throw new HttpError(409, "CARD_VERSION_CONFLICT");
        const s: Seat = JSON.parse(seatRow.payload);
        if (s.retired || !s.current || (s.disconnectAt != null && s.disconnectAt <= now))
          throw new HttpError(409, "CARD_ROUND_LOCKED");
        const oldBoard = s.current.board;
        if (needsExpiryPolicy(m) && m.scene === 'daily') s.current.deadline = null;
        const oldRefreshes = s.current.refreshes;
        const oldExhausted = s.current.exhausted;
        const began = performance.now();
        try {
          s.current = applyCommand(
            g.index,
            m.questions[m.round],
            m.variant,
            s.current,
            input.command,
            now,
          );
          if (s.current.refreshes > oldRefreshes || (!oldExhausted && s.current.exhausted)) {
            observe('recovery_command_ms', performance.now() - began);
            observe(s.current.exhausted ? 'recovery_exhausted' : 'recovery_success');
          }
        } catch (e) {
          if (e instanceof RuleError) throw new HttpError(409, e.code);
          throw e;
        } finally { observe('engine_ms', performance.now() - began); }
        await saveSeat(trx, seatRow, s);
        if (needsExpiryPolicy(m)) {
          m.revision++;
          m.expiresAt = m.scene === 'daily' ? nextShanghaiMidnight(m.day!) : now + SOLO_IDLE_MS;
          if (m.scene === 'daily') m.duration = 0;
        }
        if (m.scene === 'practice' && (input.command.type !== 'reorder' ||
            oldBoard.some((id, index) => id !== s.current!.board[index]))) {
          m.expiresAt = now + SOLO_IDLE_MS;
        }
        if (singleScene(m)) {
          m.dueAt = singleDueAt(m);
          await saveMatch(trx, m);
        }
        await advance(trx, m, rows, g, now);
        return matchView(m, rows, owner.key, g);
      },
    );
  });
}
export async function commandMatch(...args: Parameters<typeof executeCommand>) {
  return measured('command_ms', async () => {
    try { return await executeCommand(...args); }
    catch (error) {
      observe('command_failure');
      if (error instanceof HttpError && error.code === 'CARD_VERSION_CONFLICT') observe('version_conflict');
      throw error;
    }
  });
}
export async function joinMatch(code: string, owner: Owner) {
  const row = await db("card_matches").where({ code }).first();
  if (!row) throw new HttpError(404, "CARD_MATCH_NOT_FOUND");
  const old: Match = JSON.parse(row.payload);
  owner = await matchOwner(old.id, owner);
  const g = await loadGraph(old.questions[0].graphVersion);
  return transaction(async (trx) => {
    await lockRow(trx, "card_catalog", { id: 1 });
    const row = await lockRow(trx, "card_matches", { id: old.id });
    const m: Match = JSON.parse(row.payload);
    const rows = await rowsFor(trx, m.id);
    if (rows.some((r) => r.identity_key === owner.key)) return { id: m.id };
    if (m.status !== "waiting" || rows.length >= 8 || Date.now() >= m.dueAt!)
      throw new HttpError(409, "CARD_ROOM_UNAVAILABLE");
    await reserve(trx, owner, m.id);
    await insertSeat(trx, m, owner, g);
    m.revision++;
    await saveMatch(trx, m);
    return { id: m.id };
  });
}
export async function controlMatch(
  id: string,
  owner: Owner,
  action: "ready" | "start" | "leave",
  requestId: string,
) {
  owner = await matchOwner(id, owner);
  const before = await getMatch(id),
    g = await loadGraph(before.questions[0].graphVersion);
  return transaction(async (trx) => {
    const raw = await lockRow(trx, "card_matches", { id }),
      m: Match = JSON.parse(raw.payload);
    const rows = await rowsFor(trx, id),
      row = rows.find((r) => r.identity_key === owner.key);
    if (!row) throw new HttpError(403, "FORBIDDEN");
    await advance(trx, m, rows, g, Date.now());
    return receipt(
      trx,
      `control:${id}:${owner.key}`,
      requestId,
      { action },
      async () => {
        const s: Seat = JSON.parse(row.payload);
        if (action === "ready") {
          if (m.status !== "waiting" || s.retired || s.connected === false)
            throw new HttpError(409, "CARD_ROUND_LOCKED");
          s.ready = !s.ready;
          await saveSeat(trx, row, s);
          if (m.scene === 'ranked') await advance(trx, m, rows, g, Date.now());
        }
        if (action === "start") {
          if (m.host !== owner.key) throw new HttpError(403, "FORBIDDEN");
          if (
            m.status !== "waiting" ||
            rows.length < 2 ||
            rows.some((r) => { const s: Seat = JSON.parse(r.payload); return !s.ready || s.retired || s.connected === false; })
          )
            throw new HttpError(409, "CARD_NOT_ALL_READY");
          m.status = "preparing";
          m.dueAt = Date.now() + 3000;
          m.revision++;
          await saveMatch(trx, m);
        }
        if (
          action === "leave" &&
          !["finished", "cancelled"].includes(m.status)
        ) {
          s.retired = true;
          if (s.current) stopRound(s.current, Math.min(Date.now(), m.dueAt ?? Date.now()));
          await saveSeat(trx, row, s);
          if (m.status === "waiting") {
            if (m.scene === 'ranked') {
              await cancelMatch(trx, m);
              return { id };
            }
            await trx("card_seats")
              .where({ match_id: id, identity_key: owner.key })
              .delete();
            await trx("card_reservations")
              .where({ identity_key: owner.key, match_id: id })
              .delete();
            const rest = rows.filter((r) => r !== row);
            if (!rest.length) {
              m.status = "cancelled";
              m.dueAt = null;
            } else if (m.host === owner.key) m.host = rest[0].identity_key;
            m.revision++;
            await saveMatch(trx, m);
          } else if (m.scene === "ranked") {
            for (const r of rows) {
              const p: Seat = JSON.parse(r.payload);
              if (p.current) {
                stopRound(p.current, Math.min(Date.now(), m.dueAt ?? Date.now()));
                p.results[m.round] = p.current.best;
              }
              await saveSeat(trx, r, p);
            }
            await finish(trx, m, Date.now());
          } else await advance(trx, m, rows, g, Date.now());
        }
        return { id };
      },
    );
  });
}
export async function advanceById(id: string, repairKey?: string) {
  const before = await getMatch(id),
    g = await loadGraph(before.questions[0].graphVersion);
  return transaction(async (trx) => {
    const row = await lockRow(trx, "card_matches", { id });
    const m: Match = JSON.parse(row.payload);
    const rows = await rowsFor(trx, id);
    const now = Date.now();
    if (repairKey && m.status === 'playing' && m.variant === 'limited' &&
        (m.dueAt === null || now < m.dueAt)) {
      const seatRow = rows.find(r => r.identity_key === repairKey);
      if (seatRow) {
        const seat: Seat = JSON.parse(seatRow.payload);
        if (!seat.retired && seat.current) {
          const recovered = recoverRound(g.index, m.questions[m.round], seat.current, now);
          if (recovered) { seat.current = recovered; await saveSeat(trx, seatRow, seat); }
        }
      }
    }
    await advance(trx, m, rows, g, now);
    // Only a due inspection needs rescheduling. An ordinary read must not
    // rewrite the full match or keep pushing its presence inspection forward.
    if (!singleScene(m) && !['finished', 'cancelled'].includes(m.status) &&
        m.revision === Number(row.revision) && (row.due_at == null || Number(row.due_at) <= now))
      await trx('card_matches').where({ id }).update({ due_at: scheduledAt(m) });
    return m;
  });
}
