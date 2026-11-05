import { claimCardResults } from "../../src/card-link/claims";
import { cardDirectory } from '../../src/card-link/directory';
import { beforeAll, afterAll, afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cardStats, cardReplays } from '../../src/card-link/stats';
import { seatId } from '../../src/card-link/views';
import { dailyLeaderboard } from '../../src/card-link/leaderboard';
import { userNameFromUsername } from '../../src/middleware/auth';
import { nextShanghaiMidnight, SOLO_IDLE_MS } from '../../src/card-link/expiry';
import { db } from "../../src/db/knex";
import { ensureSchema } from "../../src/db/schema";
import { CARD_REQUIRED_COLUMNS } from "../../src/card-link/schema";
import { assertDatabaseReady } from "../../src/db/ready";
import {
  submitCareer,
  reviewCareer,
  type Career,
} from "../../src/card-link/careers";
import {
  buildCandidate,
  publishGraph,
  rollbackGraph,
  loadGraph,
  buildGraph,
} from "../../src/card-link/graphs";
import {
  createMatch,
  readView,
  commandMatch,
  controlMatch,
  joinMatch,
  advanceById,
} from "../../src/card-link/matches";
import { settle } from "../../src/card-link/settlement";
import { queueMatch, heartbeatQueue, cancelQueue, QUEUE_LEASE_MS } from "../../src/card-link/matchmaking";
import { setCardPresenceReader, CARD_DISCONNECT_MS } from '../../src/card-link/presence';
import type { Owner } from '../../src/card-link/types';
import { shortestPath } from "@friberg/card-link-core";
import { randomUUID } from "crypto";
import { configureScenes } from '../../src/card-link/operations';
import { updatePlayer, importPlayers, playerImportSchema } from '../../src/services/playerMutations';
const guest = { key: "g:card-fixture", userId: null, name: "Guest" },
  other = { key: "g:card-fixture-2", userId: null, name: "Guest 2" };
let ids: number[] = [],
  version = "";
const career = (i: number): Career => ({
  personKey: `person:${i}`,
  page: `https://example.com/${i}`,
  sourceRevision: "fixture",
  observedAt: "2026-10-24",
  aliases: [],
  locked: false,
  tenures: [i - 1, i]
    .filter((x) => x >= 0 && x < 11)
    .map((t) => ({
      teamId: `team:${t}`,
      team: `T${t}`,
      game: "csgo",
      start: `${2000 + t}-01-01`,
      end: `${2001 + t}-01-01`,
      precision: "day",
      status: "active",
      rawDates: "2019-01-01 — 2020-01-01",
      source: `https://example.com/${i}`,
      verified: false,
    })),
});
beforeAll(async () => {
  if (!process.env.DB_URL?.includes("verification"))
    throw new Error("ISOLATED_DB_REQUIRED");
  await ensureSchema();
  for (let i = 0; i < 12; i++) {
    const [row] = await db("players")
      .insert({ nickname: `card-fixture-${i}`, nationality: "Sweden", age: 25 })
      .returning("id");
    ids.push(Number(row.id));
  }
  for (let i = 0; i < ids.length; i++) {
    const r = await submitCareer(
      { playerId: ids[i], expectedRevision: 0, career: career(i) },
      "test",
      randomUUID(),
    );
    await reviewCareer(r.id, true, 1);
  }
  const candidate = await buildCandidate();
  version = candidate.version;
  await publishGraph(version);
});
it('adds current champion cosmetics to legacy limited directories without mutating frozen graphs', async () => {
  const graph = await loadGraph(version);
  const before = JSON.stringify(graph.data);
  await db('players').where({ id: ids[0] }).update({ major_championships: 1 });
  try {
    const directory = await cardDirectory(graph.data.players, 'limited');
    expect(directory.find(p => p.id === ids[0])?.majorChampion).toBe(true);
    expect(directory.find(p => p.id === ids[1])?.majorChampion).toBe(false);
    expect(JSON.stringify(graph.data)).toBe(before);
    expect(await cardDirectory(graph.data.players, 'unlimited')).toBe(graph.data.players);
    await db('players').where({ id: ids[0] }).update({ major_championships: 0 });
    expect((await cardDirectory(graph.data.players, 'limited')).find(p => p.id === ids[0])?.majorChampion).toBe(false);
  } finally {
    await db('players').where({ id: ids[0] }).update({ major_championships: 0 });
  }
});
afterAll(async () => {
  for (const table of [
    "card_admin_events",
    "card_daily_attempts",
    "card_claims",
    "card_rating_ledger",
    "card_ratings",
    "card_participants",
    "card_results",
    "card_outbox",
    "card_requests",
    "card_seats",
    "card_matches",
    "card_daily",
    "card_queue",
    "card_reservations",
    "card_career_reviews",
    "card_career_tenures",
    "card_careers",
    "card_graphs",
  ])
    await db(table).delete();
  await db("card_catalog")
    .where({ id: 1 })
    .update({ graph_version: null, enabled: false, revision: 0 });
  await db("players").whereIn("id", ids).delete();
  await db("users").where("username", "like", "card-fixture-%").delete();
  await db.destroy();
});
afterEach(() => { setCardPresenceReader(null); vi.restoreAllMocks(); });
async function rankedOwners(): Promise<Owner[]> {
  const result: Owner[] = [];
  for (let i = 0; i < 2; i++) {
    const suffix = randomUUID();
    const [u] = await db('users').insert({ username: `card-fixture-${suffix}`, email: `${suffix}@example.com`,
      password_hash: 'unused', email_verified_at: db.fn.now() }).returning('id');
    result.push({ key: `u:${u.id}`, userId: Number(u.id), name: `R${i}` });
  }
  return result;
}
describe("card link durable application", () => {
  it('quarantines reversed exact dates without altering approved facts or rejecting conservative uncertain intervals', async () => {
    const current = await db('card_careers').where({ player_id: ids[0] }).first();
    const bad = JSON.parse(current.payload); bad.tenures[0].start = '2025-01-01'; bad.tenures[0].end = '2024-01-01';
    const review = await submitCareer({ playerId: ids[0], expectedRevision: current.revision, career: bad }, 'admin:1', randomUUID());
    expect(review.status).toBe('conflict');
    await expect(reviewCareer(review.id, true, 1)).rejects.toMatchObject({ code: 'CARD_CAREER_DATES' });
    expect(await db('card_careers').where({ player_id: ids[0] }).first()).toEqual(current);
    bad.tenures[0].precision = 'month';
    const uncertain = await submitCareer({ playerId: ids[0], expectedRevision: current.revision, career: bad }, 'admin:1', randomUUID());
    expect(uncertain.status).toBe('pending');
    await reviewCareer(review.id, false, 1); await reviewCareer(uncertain.id, false, 1);
  });
  it('blocks only the pending ranked variant, including exhausted retries and stale queued candidates', async () => {
    const [a, b] = await rankedOwners();
    await queueMatch(a, 'limited'); const first = await queueMatch(b, 'limited');
    await controlMatch(first.id!, a, 'ready', randomUUID()); await controlMatch(first.id!, b, 'ready', randomUUID());
    await controlMatch(first.id!, a, 'leave', randomUUID());
    await db('card_outbox').where({ match_id: first.id }).update({ attempts: 10 });
    await expect(queueMatch(a, 'limited')).rejects.toMatchObject({ code: 'CARD_SETTLEMENT_PENDING' });
    expect(await queueMatch(a, 'unlimited')).toMatchObject({ queued: true }); await cancelQueue(a);
    const friend = await createMatch(a, 'friend', 'limited', 'easy', 120, randomUUID());
    await controlMatch(friend.id, a, 'leave', randomUUID());
    const [c] = await rankedOwners();
    const ticket = randomUUID();
    const rogue = () => db('card_queue').insert({ identity_key: a.key, variant: 'limited', queued_at: Date.now(), payload: JSON.stringify({ ...a, ticket, heartbeatAt: Date.now() }) });
    await rogue(); expect(await heartbeatQueue(a, ticket)).toEqual({ queued: false });
    await rogue(); expect(await queueMatch(c, 'limited')).toMatchObject({ queued: true });
    expect(await db('card_queue').where({ identity_key: a.key }).first()).toBeUndefined(); await cancelQueue(c);
    await Promise.all([settle(first.id!), settle(first.id!)]);
    expect(await db('card_rating_ledger').where({ match_id: first.id })).toHaveLength(2);
    expect(await queueMatch(a, 'limited')).toMatchObject({ queued: true }); await cancelQueue(a);
  });
  it('invalidates graph candidates after player updates and legacy JSON imports, even if revision is unchanged', async () => {
    const original = await db('players').where({ id: ids[0] }).first();
    for (const change of [{ age: original.age + 1 }, { nickname: original.nickname + '-renamed' }, { nationality: 'Denmark' }, { is_enabled: false }]) {
      const candidate = await buildCandidate();
      await updatePlayer(ids[0], change);
      await expect(publishGraph(candidate.version)).rejects.toMatchObject({ code: 'CARD_GRAPH_STALE' });
      // Legacy writers cannot bypass the complete source fingerprint either.
      await db('card_catalog').where({ id: 1 }).update({ revision: candidate.revision });
      await expect(publishGraph(candidate.version)).rejects.toMatchObject({ code: 'CARD_GRAPH_STALE' });
      await updatePlayer(ids[0], { age: original.age, nickname: original.nickname, nationality: original.nationality, is_enabled: Boolean(original.is_enabled) });
    }
    const candidate = await buildCandidate();
    await importPlayers(playerImportSchema.parse({ players: [{ nickname: original.nickname, age: original.age, nationality: original.nationality, team: 'Changed team' }] }).players);
    await expect(publishGraph(candidate.version)).rejects.toMatchObject({ code: 'CARD_GRAPH_STALE' });
    await updatePlayer(ids[0], { team: original.team });
    version = (await buildCandidate()).version; await publishGraph(version);
  });
  it('disables new scenes independently, drains queue and preserves existing rooms, receipts and daily resumes', async () => {
    const a = { ...guest, key: `g:flags-${randomUUID()}` }, b = { ...other, key: `g:flags-${randomUUID()}` };
    const dailyRequest = randomUUID();
    const daily = await createMatch(a, 'daily', 'limited', 'normal', 0, dailyRequest);
    const room = await createMatch(a, 'friend', 'limited', 'easy', 120, randomUUID());
    const [ranked] = await rankedOwners(); await queueMatch(ranked, 'limited');
    try {
      await configureScenes({ scenes: { ranked: false, friend: false, daily: false } }, 1);
      expect(await db('card_queue')).toHaveLength(0);
      await expect(queueMatch(ranked, 'limited')).rejects.toMatchObject({ code: 'CARD_SCENE_DISABLED' });
      await expect(createMatch(b, 'friend', 'limited', 'easy', 120, randomUUID())).rejects.toMatchObject({ code: 'CARD_SCENE_DISABLED' });
      expect(await createMatch(a, 'daily', 'limited', 'normal', 0, randomUUID())).toEqual(daily);
      expect(await createMatch(a, 'daily', 'limited', 'normal', 0, dailyRequest)).toEqual(daily);
      await joinMatch((await readView(room.id, a)).code!, b);
      expect((await readView(room.id, b)).players).toHaveLength(2);
      expect(await createMatch(b, 'practice', 'limited', 'easy', 0, randomUUID())).toHaveProperty('id');
    } finally { await configureScenes({ enabled: true, scenes: { practice: true, daily: true, friend: true, ranked: true } }, 1); }
  });
  it('rolls back only published intact graphs with an optimistic pointer and immutable history', async () => {
    const oldVersion = (await buildCandidate()).version; await publishGraph(oldVersion);
    const original = await db('players').where({ id: ids[0] }).first();
    const history = await db('card_results'); const daily = await db('card_daily');
    await updatePlayer(ids[0], { age: original.age + 1 }); const next = await buildCandidate();
    await expect(rollbackGraph(next.version, oldVersion, 'Unpublished candidate', 1)).rejects.toMatchObject({ code: 'CARD_GRAPH_NOT_PUBLISHED' });
    await publishGraph(next.version);
    await configureScenes({ enabled: false }, 1);
    await expect(rollbackGraph(oldVersion, oldVersion, 'Stale admin', 1)).rejects.toMatchObject({ code: 'CARD_VERSION_CONFLICT' });
    const stored = await db('card_graphs').where({ version: oldVersion }).first();
    await db('card_graphs').where({ version: oldVersion }).update({ payload: '{}' });
    await expect(rollbackGraph(oldVersion, next.version, 'Damaged graph', 1)).rejects.toMatchObject({ code: 'CARD_GRAPH_INVALID' });
    await db('card_graphs').where({ version: oldVersion }).update({ payload: stored.payload });
    await rollbackGraph(oldVersion, next.version, 'Restore verified graph', 1);
    expect(Boolean((await db('card_catalog').where({ id: 1 }).first()).enabled)).toBe(false);
    expect(await db('card_results')).toEqual(history); expect(await db('card_daily')).toEqual(daily);
    expect(await db('card_admin_events').where({ action: 'rollback', actor: 1 })).toHaveLength(1);
    await updatePlayer(ids[0], { age: original.age }); version = (await buildCandidate()).version; await publishGraph(version);
  });
  it('expires abandoned queue leases and ignores cancellation or heartbeat from an old ticket', async () => {
    const [a, b] = await rankedOwners();
    const first = await queueMatch(a, 'unlimited');
    expect(first.ticket).toBeTypeOf('string');
    expect(await heartbeatQueue(a, first.ticket!)).toMatchObject({ queued: true });
    const row = await db('card_queue').where({ identity_key: a.key }).first();
    await db('card_queue').where({ identity_key: a.key }).update({ payload: JSON.stringify({ ...JSON.parse(row.payload), heartbeatAt: Date.now() - QUEUE_LEASE_MS - 1 }) });
    expect(await queueMatch(b, 'unlimited')).toMatchObject({ queued: true });
    expect(await heartbeatQueue(a, first.ticket!)).toEqual({ queued: false });
    await cancelQueue(b);
    const next = await queueMatch(a, 'unlimited');
    expect(next.ticket).not.toBe(first.ticket);
    await cancelQueue(a, first.ticket);
    expect(await heartbeatQueue(a, first.ticket!)).toEqual({ queued: false });
    expect(await heartbeatQueue(a, next.ticket!)).toMatchObject({ queued: true });
    await cancelQueue(a, next.ticket);
  });
  it('requires both ranked players to confirm and cancels an unconfirmed match without Elo', async () => {
    const [a, b] = await rankedOwners();
    await queueMatch(a, 'limited');
    const { id } = await queueMatch(b, 'limited');
    expect((await readView(id!, a)).status).toBe('waiting');
    await controlMatch(id!, a, 'ready', randomUUID());
    expect((await readView(id!, a)).status).toBe('waiting');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CARD_DISCONNECT_MS + 1);
    await advanceById(id!);
    expect((await readView(id!, a)).status).toBe('cancelled');
    expect(await db('card_reservations').where({ match_id: id })).toHaveLength(0);
    expect(await db('card_outbox').where({ match_id: id })).toHaveLength(0);
    expect(await db('card_rating_ledger').where({ match_id: id })).toHaveLength(0);
    clock.mockRestore();
  });
  it('restores a friend within 30 seconds, rejects a late return, and keeps other players in the game', async () => {
    const owners = [0, 1, 2].map(i => ({ key: `g:grace-${randomUUID()}`, userId: null, name: `G${i}` }));
    let online = new Set(owners.map(o => o.key));
    setCardPresenceReader(async () => online);
    const { id } = await createMatch(owners[0], 'friend', 'unlimited', 'easy', 120, randomUUID());
    const code = (await readView(id, owners[0])).code!;
    for (const owner of owners.slice(1)) await joinMatch(code, owner);
    for (const owner of owners) await controlMatch(id, owner, 'ready', randomUUID());
    await controlMatch(id, owners[0], 'start', randomUUID());
    let now = Date.now() + 3001;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await advanceById(id);
    const original = await readView(id, owners[0]);
    online.delete(owners[0].key);
    await advanceById(id);
    expect((await readView(id, owners[1])).players.find(p => p.id === original.me)).toMatchObject({ connected: false, retired: false, disconnectAt: now + CARD_DISCONNECT_MS });
    now += CARD_DISCONNECT_MS - 1;
    online.add(owners[0].key);
    expect((await readView(id, owners[0])).players.find(p => p.id === original.me)).toMatchObject({ connected: true, disconnectAt: null, retired: false });
    online.delete(owners[0].key);
    await advanceById(id);
    now += CARD_DISCONNECT_MS;
    online.add(owners[0].key);
    const late = await readView(id, owners[0]);
    expect(late.status).toBe('playing');
    expect(late.dueAt).toBe(original.dueAt);
    expect(late.players.find(p => p.id === original.me)).toMatchObject({ retired: true, connected: false });
    await expect(commandMatch(id, owners[0], { requestId: randomUUID(), revision: late.revision,
      phaseRevision: late.phaseRevision, command: { type: 'lock' } })).rejects.toMatchObject({ code: 'CARD_ROUND_LOCKED' });
  });
  it('removes an offline waiting host and transfers the friend room without deleting the remaining seat', async () => {
    const owners = [0, 1].map(i => ({ key: `g:host-${randomUUID()}`, userId: null, name: `H${i}` }));
    const online = new Set(owners.map(o => o.key));
    setCardPresenceReader(async () => online);
    const { id } = await createMatch(owners[0], 'friend', 'limited', 'easy', 120, randomUUID());
    await joinMatch((await readView(id, owners[0])).code!, owners[1]);
    online.delete(owners[0].key);
    await advanceById(id);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CARD_DISCONNECT_MS + 1);
    await advanceById(id);
    const view = await readView(id, owners[1]);
    expect(view.host).toBe(true);
    expect(view.players).toHaveLength(1);
    expect(view.status).toBe('waiting');
    expect(await db('card_reservations').where({ identity_key: owners[0].key })).toHaveLength(0);
  });
  it('finishes ranked disconnects and frees seats before settlement; late settlement cannot free a new game', async () => {
    const [a, b] = await rankedOwners();
    const online = new Set([a.key, b.key]);
    setCardPresenceReader(async () => online);
    await queueMatch(a, 'unlimited');
    const { id } = await queueMatch(b, 'unlimited');
    for (const owner of [a, b]) await controlMatch(id!, owner, 'ready', randomUUID());
    let now = Date.now() + 3001;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await advanceById(id!);
    online.delete(a.key);
    await advanceById(id!);
    now += CARD_DISCONNECT_MS;
    await advanceById(id!);
    expect((await readView(id!, b)).status).toBe('finished');
    expect(await db('card_reservations').where({ match_id: id })).toHaveLength(0);
    // Also recover old-version reservations stranded by a failed outbox.
    await db('card_reservations').insert({ identity_key: a.key, match_id: id });
    await db('card_outbox').where({ match_id: id }).update({ attempts: 10 });
    const next = await createMatch(a, 'friend', 'limited', 'easy', 120, randomUUID());
    await settle(id!);
    await settle(id!);
    expect(await db('card_rating_ledger').where({ match_id: id })).toHaveLength(2);
    expect((await db('card_reservations').where({ identity_key: a.key }).first()).match_id).toBe(next.id);
    const ledger = await db('card_rating_ledger').where({ match_id: id, user_id: a.userId }).first();
    expect(Number(ledger.after)).toBeLessThan(Number(ledger.before));
  });
  it('persists two credits and replays commands without earning or spending twice', async () => {
    const { id } = await createMatch(guest, 'practice', 'limited', 'normal', 0, randomUUID());
    let v = await readView(id, guest);
    const graph = await loadGraph(v.graphVersion);
    const path = shortestPath(graph.index, v.question!.start, v.question!.end,
      new Set([v.question!.start, v.question!.end, ...v.current!.hand]))!;
    expect(path.length).toBeGreaterThanOrEqual(4);
    for (const [index, playerId] of path.slice(1, 3).entries()) {
      const input = { requestId: randomUUID(), revision: v.revision, phaseRevision: v.phaseRevision,
        command: { type: 'play' as const, playerId, index } };
      v = await commandMatch(id, guest, input);
      expect(v.current!.token).toBe(index + 1);
      expect(await commandMatch(id, guest, input)).toEqual(v);
    }
    expect((await readView(id, guest)).current!.token).toBe(2);
    const input = { requestId: randomUUID(), revision: v.revision, phaseRevision: v.phaseRevision,
      command: { type: 'refresh' as const } };
    v = await commandMatch(id, guest, input);
    expect(v.current!.token).toBe(1);
    expect(await commandMatch(id, guest, input)).toEqual(v);
    expect((await readView(id, guest)).current!.token).toBe(1);
  });
  it('ranks one actual best attempt per account across retries and guest claims without a pre-deduplication limit', async () => {
    const day = '2040-01-01';
    const users = [];
    for (const name of ['a', 'b', 'claim', 'hidden', 'banned']) {
      const [user] = await db('users').insert({ username: `card-fixture-best-${name}`, password_hash: 'unused',
        leaderboard_hidden: name === 'hidden', banned_at: name === 'banned' ? new Date() : null }).returning('id');
      users.push(Number(user.id));
    }
    const add = async (userId: number | null, hops: number, elapsed: number, extra: Record<string, unknown> = {}) => {
      const id = randomUUID();
      await db('card_results').insert({ match_id: id, payload: '{}', created_at: Date.now() });
      await db('card_participants').insert({ match_id: id, identity_key: userId ? `u:${userId}` : 'g:best-guest', user_id: userId,
        scene: 'daily', day, variant: 'limited', solved: 1, hops, elapsed, ...extra });
    };
    await add(users[0], 4, 1000); await add(users[0], 3, 9000); await add(users[0], 3, 6000);
    await add(users[0], 2, 20000); await add(users[0], 2, 25000); await add(users[0], 0, 0, { solved: 0 });
    await add(users[1], 3, 3000); await add(users[3], 1, 1); await add(users[4], 1, 1);
    await add(users[0], 1, 1, { day: '2040-01-02' }); await add(users[0], 1, 1, { variant: 'unlimited' });
    // More than the old 500-row cap must not crowd other accounts out of the board.
    for (let i = 0; i < 501; i++) await add(users[0], 2, 30000 + i);
    const names = ['a', 'b', 'claim'].map(name => userNameFromUsername(`card-fixture-best-${name}`));
    expect(await dailyLeaderboard('limited', day)).toEqual([
      { username: names[0], hops: 2, elapsed: 20000 }, { username: names[1], hops: 3, elapsed: 3000 },
    ]);
    await add(users[0], 2, 15000); // Same hops, faster retry replaces the older best.
    await add(users[0], 3, 1); // Faster but longer must not replace it.
    await add(null, 2, 14000); await claimCardResults('best-guest', users[2]);
    await add(users[2], 2, 16000); // Claimed guest and account are one leaderboard entry.
    expect(await dailyLeaderboard('limited', day)).toEqual([
      { username: names[2], hops: 2, elapsed: 14000 }, { username: names[0], hops: 2, elapsed: 15000 },
      { username: names[1], hops: 3, elapsed: 3000 },
    ]);
  });
  it.each(['read', 'command'] as const)('atomically repairs an old unsolvable daily hand through %s without renewing expiry', async via => {
    const owner = { key: `g:daily-recovery-${via}`, userId: null, name: 'Recovery' };
    const { id } = await createMatch(owner, 'daily', 'limited', 'normal', 0, randomUUID());
    const before = await readView(id, owner);
    const match = JSON.parse((await db('card_matches').where({ id }).first()).payload);
    const question = match.questions[0], graph = await loadGraph(before.graphVersion);
    const raw = await db('card_seats').where({ match_id: id }).first();
    const seat = JSON.parse(raw.payload);
    const blocked = question.pool.find((pid: number) => !graph.index.get(question.start)?.has(pid) && !graph.index.get(question.end)?.has(pid));
    expect(blocked).toBeDefined();
    seat.current.board = []; seat.current.hand = [blocked]; seat.current.deck = question.pool.filter((pid: number) => pid !== blocked);
    seat.current.discarded = []; seat.current.token = 0;
    await db('card_seats').where({ match_id: id }).update({ payload: JSON.stringify(seat) });
    const input = { requestId: randomUUID(), revision: before.revision, phaseRevision: before.phaseRevision,
      command: { type: 'play' as const, playerId: blocked, index: 0 } };
    const results = await Promise.all([0, 1].map(() => via === 'read' ? readView(id, owner) : commandMatch(id, owner, input)));
    const fixed = await readView(id, owner);
    expect(fixed.current).toMatchObject({ refreshes: 1, token: 0, locked: false, discarded: [blocked], board: [] });
    expect(fixed.expiresAt).toBe(before.expiresAt);
    expect(fixed.revision).toBe(before.revision + 1);
    expect(shortestPath(graph.index, question.start, question.end, new Set([question.start, question.end, ...fixed.current!.hand]))).not.toBeNull();
    expect(results[0].current).toEqual(results[1].current);
    expect((await readView(id, owner)).current).toEqual(fixed.current);
    if (via === 'command') expect(await commandMatch(id, owner, input)).toEqual(results[0]);
  });
  it.each([
    ['limited', 'leave'], ['limited', 'lock'], ['unlimited', 'leave'], ['unlimited', 'lock'],
  ] as const)('can play daily %s again after %s without replacing the formal attempt', async (variant, ending) => {
    const [user] = await db('users').insert({ username: `card-fixture-retry-${variant}-${ending}`, password_hash: 'unused' }).returning('id');
    const owner = { key: `u:${user.id}`, userId: Number(user.id), name: 'Daily retry' };
    const formal = await createMatch(owner, 'daily', variant, 'normal', 0, randomUUID());
    expect((await createMatch(owner, 'daily', variant, 'normal', 0, randomUUID())).id).toBe(formal.id);
    const solve = async (id: string) => {
      let v = await readView(id, owner);
      const graph = await loadGraph(v.graphVersion);
      const allowed = variant === 'limited' ? new Set([v.question!.start, v.question!.end, ...v.current!.hand]) : undefined;
      const route = shortestPath(graph.index, v.question!.start, v.question!.end, allowed)!;
      expect(route).not.toBeNull();
      for (const playerId of route.slice(1, -1)) {
        v = await commandMatch(id, owner, { requestId: randomUUID(), revision: v.revision, phaseRevision: v.phaseRevision,
          command: { type: 'play', playerId, index: v.current!.board.length } });
      }
      expect(v.current!.best).not.toBeNull();
      return commandMatch(id, owner, { requestId: randomUUID(), revision: v.revision, phaseRevision: v.phaseRevision, command: { type: 'lock' } });
    };
    if (ending === 'lock') await solve(formal.id);
    else await controlMatch(formal.id, owner, 'leave', randomUUID());
    await settle(formal.id);
    const original = await db('card_matches').where({ id: formal.id }).first();
    const originalResult = await db('card_results').where({ match_id: formal.id }).first();
    const originalView = await readView(formal.id, owner);
    const [a, b] = await Promise.all([
      createMatch(owner, 'daily', variant, 'normal', 0, randomUUID()),
      createMatch(owner, 'daily', variant, 'normal', 0, randomUUID()),
    ]);
    expect(a.id).not.toBe(formal.id); expect(a.id).toBe(b.id);
    const practice = await readView(a.id, owner);
    expect(practice).toMatchObject({ status: 'playing', dailyPractice: true, duration: 0, question: originalView.question,
      graphVersion: originalView.graphVersion, expiresAt: originalView.expiresAt });
    expect(practice.current!.locked).toBe(false); expect(practice.current!.deadline).toBeNull();
    if (variant === 'limited') expect(practice.current!.hand).toHaveLength(7);
    await solve(a.id); await settle(a.id);
    const best = await db('card_participants').where({ user_id: owner.userId, scene: 'daily', day: practice.day, variant })
      .where('solved', '>', 0).orderBy('hops').orderBy('elapsed').first();
    expect(await dailyLeaderboard(variant, practice.day!)).toContainEqual({
      username: userNameFromUsername(`card-fixture-retry-${variant}-${ending}`), hops: best.hops, elapsed: Number(best.elapsed),
    });
    expect((await db('card_daily_attempts').where({ day: practice.day, variant, identity_key: owner.key }).first()).match_id).toBe(formal.id);
    expect((await db('card_matches').where({ id: formal.id }).first()).payload).toBe(original.payload);
    expect((await db('card_results').where({ match_id: formal.id }).first()).payload).toBe(originalResult.payload);
    const list = await cardReplays(owner, { variant, scene: 'daily', page: 1 });
    expect(list.items.find(item => item.id === a.id)?.dailyPractice).toBe(true);
    expect(list.items.find(item => item.id === formal.id)?.dailyPractice).toBe(false);
    expect((await createMatch(owner, 'daily', variant, 'normal', 0, randomUUID())).id).not.toBe(a.id);
  });
  it('resumes an active daily retry after guest claim while keeping the original resume anchor', async () => {
    const owner = { key: 'g:daily-practice-claim', userId: null, name: 'Guest retry' };
    const original = await createMatch(owner, 'daily', 'limited', 'normal', 0, randomUUID());
    await controlMatch(original.id, owner, 'leave', randomUUID());
    const practice = await createMatch(owner, 'daily', 'limited', 'normal', 0, randomUUID());
    const [user] = await db('users').insert({ username: 'card-fixture-practice-claim', password_hash: 'unused' }).returning('id');
    await claimCardResults('daily-practice-claim', Number(user.id));
    const account = { key: `u:${user.id}`, userId: Number(user.id), name: 'Claimed' };
    expect((await createMatch(account, 'daily', 'limited', 'normal', 0, randomUUID())).id).toBe(practice.id);
    expect((await readView(practice.id, account)).dailyPractice).toBe(true);
    expect((await db('card_daily_attempts').where({ identity_key: account.key, variant: 'limited' }).first()).match_id).toBe(original.id);
  });
  it.each(['lock', 'leave', 'expiry'] as const)('keeps the persisted stop time stable after %s and repeated reads', async ending => {
    const base = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    try {
      const owner = { key: `g:clock-${ending}`, name: 'Clock fixture', userId: null };
      const { id } = await createMatch(owner, 'practice', 'unlimited', 'easy', 0, randomUUID());
      const v = await readView(id, owner);
      const stoppedAt = ending === 'expiry' ? v.expiresAt! : base + 5000;
      clock.mockReturnValue(stoppedAt + (ending === 'expiry' ? 10000 : 0));
      if (ending === 'lock') await commandMatch(id, owner, { requestId: randomUUID(), revision: v.revision, phaseRevision: v.phaseRevision, command: { type: 'lock' } });
      else if (ending === 'leave') await controlMatch(id, owner, 'leave', randomUUID());
      else await advanceById(id);
      expect((await readView(id, owner)).current!.stoppedAt).toBe(stoppedAt);
      clock.mockReturnValue(stoppedAt + 60000);
      expect((await readView(id, owner)).current!.stoppedAt).toBe(stoppedAt);
    } finally { clock.mockRestore(); }
  });
  it('renews idle expiry only for effective actions, rejects late commands and settles once', async () => {
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    try {
      const { id } = await createMatch(guest, 'practice', 'unlimited', 'easy', 0, randomUUID());
      let v = await readView(id, guest);
      const command = (command: any, requestId = randomUUID()) => ({ requestId, revision: v.revision, phaseRevision: v.phaseRevision, command });
      clock.mockReturnValue(base + 60000);
      expect((await readView(id, guest)).expiresAt).toBe(base + SOLO_IDLE_MS);
      v = await commandMatch(id, guest, command({ type: 'reorder', board: [] }));
      expect(v.expiresAt).toBe(base + SOLO_IDLE_MS);
      const graph = await loadGraph(v.graphVersion);
      const path = shortestPath(graph.index, v.question!.start, v.question!.end)!;
      const input = command({ type: 'play', playerId: path[1], index: 0 });
      v = await commandMatch(id, guest, input);
      expect(v.expiresAt).toBe(base + 60000 + SOLO_IDLE_MS);
      clock.mockReturnValue(base + 120000);
      expect(await commandMatch(id, guest, input)).toEqual(v);
      await expect(commandMatch(id, guest, command({ type: 'play', playerId: path[1], index: 0 }))).rejects.toThrow();
      expect((await readView(id, guest)).expiresAt).toBe(v.expiresAt);
      clock.mockReturnValue(v.expiresAt!);
      await expect(commandMatch(id, guest, command({ type: 'remove', playerId: path[1] }))).rejects.toMatchObject({ code: 'CARD_TIME_EXPIRED' });
      const finished = await readView(id, guest);
      expect(finished.status).toBe('finished');
      expect(finished.current!.board).toEqual([path[1]]);
      await advanceById(id);
      expect(await db('card_outbox').where({ match_id: id })).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });
  it('keeps daily rounds untimed beyond 180 seconds, closes at Shanghai midnight and allows the next day', async () => {
    const base = Date.parse('2026-11-01T23:50:00+08:00');
    const midnight = Date.parse('2026-11-02T00:00:00+08:00');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    // today() must use the same injectable clock as expiry and gameplay.
    const owner = { key: 'g:midnight-fixture', userId: null, name: 'Midnight' };
    try {
      for (const variant of ['limited', 'unlimited'] as const) {
        const { id } = await createMatch(owner, 'daily', variant, 'normal', 180, randomUUID());
        let v = await readView(id, owner);
        expect(v).toMatchObject({ duration: 0, dueAt: midnight, expiresAt: midnight, day: '2026-11-01' });
        expect(v.current!.deadline).toBeNull();
        clock.mockReturnValue(base + 240000);
        expect((await advanceById(id)).status).toBe('playing');
        v = await commandMatch(id, owner, { requestId: randomUUID(), revision: v.revision, phaseRevision: v.phaseRevision, command: { type: 'reorder', board: [] } });
        expect(v.expiresAt).toBe(midnight);
        clock.mockReturnValue(midnight);
        await expect(commandMatch(id, owner, { requestId: randomUUID(), revision: v.revision, phaseRevision: v.phaseRevision, command: { type: 'lock' } })).rejects.toMatchObject({ code: 'CARD_TIME_EXPIRED' });
        expect((await readView(id, owner)).status).toBe('finished');
        expect((await createMatch(owner, 'daily', variant, 'normal', 0, randomUUID())).id).not.toBe(id);
        clock.mockReturnValue(base);
      }
    } finally { clock.mockRestore(); }
  });
  it('adopts expiry for legacy active games without rewriting finished records', async () => {
    const { id } = await createMatch(guest, 'practice', 'unlimited', 'easy', 0, randomUUID());
    const row = await db('card_matches').where({ id }).first();
    const m = JSON.parse(row.payload);
    delete m.expiresAt; m.dueAt = null; m.createdAt -= 86400000;
    await db('card_matches').where({ id }).update({ due_at: null, payload: JSON.stringify(m) });
    const now = Date.now();
    const v = await readView(id, guest);
    expect(v.status).toBe('playing');
    expect(v.expiresAt).toBeGreaterThanOrEqual(now + SOLO_IDLE_MS);
    expect((await readView(id, guest)).expiresAt).toBe(v.expiresAt);
    await controlMatch(id, guest, 'leave', randomUUID());
    const finished = await db('card_matches').where({ id }).first();
    await readView(id, guest); await advanceById(id);
    expect((await db('card_matches').where({ id }).first()).payload).toBe(finished.payload);

    const daily = await createMatch({ ...guest, key: 'g:legacy-daily' }, 'daily', 'unlimited', 'normal', 0, randomUUID());
    const dailyRow = await db('card_matches').where({ id: daily.id }).first();
    const old = JSON.parse(dailyRow.payload); delete old.expiresAt; old.duration = 180; old.dueAt = old.createdAt + 180000;
    await db('card_matches').where({ id: daily.id }).update({ due_at: old.dueAt, payload: JSON.stringify(old) });
    const seat = await db('card_seats').where({ match_id: daily.id }).first();
    const state = JSON.parse(seat.payload); state.current.deadline = old.dueAt;
    await db('card_seats').where({ match_id: daily.id }).update({ payload: JSON.stringify(state) });
    const restored = await readView(daily.id, { ...guest, key: 'g:legacy-daily' });
    expect(restored.duration).toBe(0); expect(restored.current!.deadline).toBeNull();
    expect(restored.expiresAt).toBe(nextShanghaiMidnight(old.day));
  });
  it('ranks daily results by hops then exact elapsed time, retaining the earliest same-hop score', async () => {
    const base = Date.parse('2026-11-03T12:00:00+08:00');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    try {
      for (const [index, elapsed] of [5001, 3001, 1001].entries()) {
        clock.mockReturnValue(base);
        const [user] = await db('users').insert({ username: `card-fixture-daily-rank-${index}`, password_hash: 'unused' }).returning('id');
        const owner = { key: `u:${user.id}`, userId: Number(user.id), name: `Rank ${index}` };
        const { id } = await createMatch(owner, 'daily', 'unlimited', 'normal', 0, randomUUID());
        let v = await readView(id, owner);
        const graph = await loadGraph(v.graphVersion);
        const path = shortestPath(graph.index, v.question!.start, v.question!.end)!;
        clock.mockReturnValue(base + elapsed);
        for (const playerId of path.slice(1, -1)) v = await commandMatch(id, owner, { requestId: randomUUID(), revision: v.revision, phaseRevision: v.phaseRevision, command: { type: 'play', playerId, index: v.current!.board.length } });
        clock.mockReturnValue(base + elapsed + 5000);
        v = await commandMatch(id, owner, { requestId: randomUUID(), revision: v.revision, phaseRevision: v.phaseRevision, command: { type: 'reorder', board: v.current!.board } });
        expect(v.current!.best!.elapsed).toBe(elapsed);
        await commandMatch(id, owner, { requestId: randomUUID(), revision: v.revision, phaseRevision: v.phaseRevision, command: { type: 'lock' } });
        await settle(id);
        if (index === 2) await db('card_participants').where({ match_id: id }).increment('hops', 1);
      }
      const ranks = await dailyLeaderboard('unlimited', '2026-11-03');
      expect(ranks.map(row => row.elapsed)).toEqual([3001, 5001, 1001]);
      expect(ranks[0].hops).toBe(ranks[1].hops);
      expect(Number(ranks[2].hops)).toBe(Number(ranks[0].hops) + 1);
    } finally { clock.mockRestore(); }
  });
  it('persists solo timers and expires idle rounds for both hand variants', async () => {
    for (const variant of ['limited', 'unlimited'] as const) for (const duration of [0, 120]) {
      const { id } = await createMatch(guest, 'practice', variant, 'easy', duration, randomUUID());
      const view = await readView(id, guest);
      expect(view.duration).toBe(duration);
      expect(view.current?.deadline).toBe(duration === 0 ? null : view.current!.startedAt + duration * 1000);
      expect(view.expiresAt).toBe(view.current!.startedAt + SOLO_IDLE_MS);
      expect(view.dueAt).toBe(view.current?.deadline ?? view.expiresAt);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(view.current!.startedAt + 86400000);
      try { expect((await advanceById(id)).status).toBe('finished'); }
      finally { clock.mockRestore(); }
    }
  });
  it('aggregates settled career data, paginates privately and includes claimed guest history', async () => {
    const owner = { key: 'g:card-stats', userId: null, name: 'Stats' };
    const [user] = await db('users').insert({ username: 'card-fixture-stats', password_hash: 'unused' }).returning('id');
    for (let index = 0; index < 16; index++) {
      const id = randomUUID(), scene = index === 15 ? 'friend' : 'practice';
      const results = [{ path: ids.slice(0, 3), elapsed: 1000 }];
      const payload = { storageVersion: 1, match: { id, variant: 'limited', scene, day: null, rulesVersion: 1, graphVersion: version,
        questions: Array.from({ length: scene === 'friend' ? 3 : 1 }, () => ({ start: ids[0], end: ids[2] })) },
        players: [{ id: seatId(owner.key), name: 'Stats', retired: false, results },
          ...(scene === 'friend' ? [{ id: seatId(other.key), name: 'Other', retired: true, results }] : [])] };
      await db('card_results').insert({ match_id: id, created_at: Date.now() + index, payload: JSON.stringify(payload) });
      await db('card_participants').insert({ match_id: id, identity_key: owner.key, user_id: null, variant: 'limited', scene, day: null, solved: 1, hops: 2, elapsed: 1000 });
    }
    const stats = await cardStats(owner, 'limited');
    expect(stats.personal).toMatchObject({ games: 16, rounds: 18, solved: 16, averageHops: 2, averageElapsed: 1000 });
    const options = { variant: 'limited' as const, scene: 'all' as const, page: 1 };
    const first = await cardReplays(owner, options);
    expect(first.items).toHaveLength(15); expect(first.hasNext).toBe(true);
    expect(first.items[0].rank).toBe(1);
    expect(JSON.stringify(first)).not.toContain(owner.key);
    expect((await cardReplays(owner, { ...options, page: 2 })).items).toHaveLength(1);
    expect((await cardReplays(other, options)).items.every(item => !first.items.some(own => own.id === item.id))).toBe(true);
    await claimCardResults('card-stats', Number(user.id));
    expect((await cardStats({ key: `u:${user.id}`, userId: Number(user.id), name: 'Stats' }, 'limited')).personal.games).toBe(16);
    expect((await cardStats(owner, 'unlimited')).personal.games).toBe(0);
  });
  it("migrates twice and readiness verifies new tables without erasing players", async () => {
    await ensureSchema();
    await assertDatabaseReady();
    expect(await db("players").whereIn("id", ids)).toHaveLength(12);
    for (const table of Object.keys(CARD_REQUIRED_COLUMNS))
      expect(await db.schema.hasTable(table)).toBe(true);
  });
  it("keeps old history unchanged and detects review conflicts", async () => {
    const old = await db("players").where({ id: ids[0] }).first();
    const r = await submitCareer(
      { playerId: ids[0], expectedRevision: 0, career: career(0) },
      "test",
      randomUUID(),
    );
    expect(r.status).toBe("conflict");
    expect((await reviewCareer(r.id, true, 1)).status).toBe("conflict");
    expect(
      (await db("players").where({ id: ids[0] }).first()).team_history,
    ).toBe(old.team_history);
  });
  it("reuses daily assignment and attempt across different request ids", async () => {
    const a = await createMatch(
        guest,
        "daily",
        "limited",
        "easy",
        180,
        randomUUID(),
      ),
      b = await createMatch(
        guest,
        "daily",
        "limited",
        "hard",
        180,
        randomUUID(),
      );
    expect(a.id).toBe(b.id);
    expect((await readView(a.id, guest)).current).toEqual(
      (await readView(b.id, guest)).current,
    );
    await db("card_catalog").where({ id: 1 }).update({ enabled: false });
    try {
      expect(
        (
          await createMatch(
            guest,
            "daily",
            "limited",
            "normal",
            180,
            randomUUID(),
          )
        ).id,
      ).toBe(a.id);
      await expect(
        createMatch(other, "practice", "limited", "normal", 180, randomUUID()),
      ).rejects.toMatchObject({ code: "CARD_NOT_READY" });
    } finally {
      await db("card_catalog").where({ id: 1 }).update({ enabled: true });
    }
  });
  it("validates ownership and returns an immutable receipt after retries", async () => {
    const { id } = await createMatch(
      guest,
      "practice",
      "unlimited",
      "easy",
      180,
      randomUUID(),
    );
    let view = await readView(id, guest);
    await expect(readView(id, other)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const g = await loadGraph(version);
    const path = shortestPath(
      g.index,
      view.question!.start,
      view.question!.end,
    )!;
    const input = {
      requestId: randomUUID(),
      revision: view.revision,
      phaseRevision: view.phaseRevision,
      command: { type: "play" as const, playerId: path[1], index: 0 },
    };
    const result = await commandMatch(id, guest, input);
    expect(result.current?.best).not.toBeNull();
    expect(await commandMatch(id, guest, input)).toEqual(result);
    await expect(
      commandMatch(id, guest, {
        ...input,
        command: { ...input.command, index: 1 },
      }),
    ).rejects.toMatchObject({ code: "CARD_REQUEST_CONFLICT" });
    await expect(
      commandMatch(id, guest, { ...input, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "CARD_VERSION_CONFLICT" });
  });
  it("settles exactly once and preserves the graph reference", async () => {
    const { id } = await createMatch(
      guest,
      "practice",
      "unlimited",
      "easy",
      180,
      randomUUID(),
    );
    const v = await readView(id, guest);
    await commandMatch(id, guest, {
      requestId: randomUUID(),
      revision: v.revision,
      phaseRevision: v.phaseRevision,
      command: { type: "lock" },
    });
    await settle(id);
    await settle(id);
    expect(await db("card_participants").where({ match_id: id })).toHaveLength(
      1,
    );
    expect(
      JSON.parse(
        (await db("card_results").where({ match_id: id }).first()).payload,
      ).match.graphVersion,
    ).toBe(version);
  });
  it("coordinates friend phases and does not leak the other hand", async () => {
    const { id } = await createMatch(
      guest,
      "friend",
      "limited",
      "easy",
      120,
      randomUUID(),
    );
    let v = await readView(id, guest);
    await joinMatch(v.code!, other);
    for (const o of [guest, other])
      await controlMatch(id, o, "ready", randomUUID());
    await controlMatch(id, guest, "start", randomUUID());
    const raw = await db("card_matches").where({ id }).first(),
      m = JSON.parse(raw.payload);
    m.dueAt = Date.now() - 1;
    await db("card_matches")
      .where({ id })
      .update({ payload: JSON.stringify(m), due_at: m.dueAt });
    await advanceById(id);
    v = await readView(id, guest);
    expect(v.status).toBe("playing");
    expect(v.players[1]).not.toHaveProperty("hand");
    expect(JSON.stringify(v)).not.toContain(other.key);
    expect(v.current?.hand.length).toBe(7);
    await controlMatch(id, guest, "leave", randomUUID());
    await controlMatch(id, other, "leave", randomUUID());
  });
  it("requires verified email before creating ranked queues", async () => {
    await expect(queueMatch(other, "unlimited")).rejects.toMatchObject({
      code: "EMAIL_VERIFICATION_REQUIRED",
    });
  });
  it("excludes inactive and same-day-only overlap", () => {
    const a = career(0),
      b = career(1);
    a.tenures = [{ ...a.tenures[0], end: "2019-02-01" }];
    b.tenures = [{ ...a.tenures[0], start: "2019-02-01", end: "2020-01-01" }];
    expect(
      buildGraph([
        { id: 1, nickname: "a", team: "", nationality: "", career: a },
        { id: 2, nickname: "b", team: "", nationality: "", career: b },
      ]).edges,
    ).toEqual([]);
    b.tenures = [{ ...a.tenures[0], status: "inactive" }];
    expect(
      buildGraph([
        { id: 1, nickname: "a", team: "", nationality: "", career: a },
        { id: 2, nickname: "b", team: "", nationality: "", career: b },
      ]).edges,
    ).toEqual([]);
  });
  it("deduplicates concurrent command submissions", async () => {
    const { id } = await createMatch(
      guest,
      "practice",
      "limited",
      "easy",
      180,
      randomUUID(),
    );
    const v = await readView(id, guest);
    const input = {
      requestId: randomUUID(),
      revision: v.revision,
      phaseRevision: v.phaseRevision,
      command: { type: "lock" as const },
    };
    const results = await Promise.all([
      commandMatch(id, guest, input),
      commandMatch(id, guest, input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await db("card_outbox").where({ match_id: id })).toHaveLength(1);
  });
  it("claims an ongoing guest daily without renaming its seat or allowing a second attempt", async () => {
    const o = { key: "g:card-claim", userId: null, name: "Claim" };
    const [u] = await db("users")
      .insert({ username: "card-fixture-claim", password_hash: "unused" })
      .returning("id");
    const account = { key: `u:${u.id}`, userId: Number(u.id), name: "Account" };
    const { id } = await createMatch(
      o,
      "daily",
      "unlimited",
      "normal",
      180,
      randomUUID(),
    );
    await claimCardResults("card-claim", account.userId);
    const restored = await createMatch(
      account,
      "daily",
      "unlimited",
      "normal",
      180,
      randomUUID(),
    );
    expect(restored.id).toBe(id);
    const v = await readView(id, account);
    await commandMatch(id, account, {
      requestId: randomUUID(),
      revision: v.revision,
      phaseRevision: v.phaseRevision,
      command: { type: "lock" },
    });
    await settle(id);
    expect(
      (await db("card_participants").where({ match_id: id }).first()).user_id,
    ).toBe(account.userId);
    expect(
      (await db("card_seats").where({ match_id: id }).first()).identity_key,
    ).toBe(o.key);
  });
  it("plays three ranked rounds and settles Elo once", async () => {
    const owners = [];
    for (let i = 0; i < 2; i++) {
      const [u] = await db("users")
        .insert({
          username: `card-fixture-ranked-${i}`,
          email: `card-${i}@example.com`,
          password_hash: "unused",
          email_verified_at: db.fn.now(),
        })
        .returning("id");
      owners.push({ key: `u:${u.id}`, userId: Number(u.id), name: `R${i}` });
    }
    expect(await queueMatch(owners[0], "unlimited")).toMatchObject({ queued: true });
    const joined = await queueMatch(owners[1], "unlimited");
    expect(joined).toHaveProperty("id");
    const id = joined.id!;
    expect((await readView(id, owners[0])).status).toBe('waiting');
    for (const owner of owners) await controlMatch(id, owner, 'ready', randomUUID());
    expect((await readView(id, owners[0])).status).toBe('preparing');
    const expire = async () => {
      const row = await db("card_matches").where({ id }).first(),
        m = JSON.parse(row.payload);
      m.dueAt = Date.now() - 1;
      await db("card_matches")
        .where({ id })
        .update({ payload: JSON.stringify(m), due_at: m.dueAt });
      await advanceById(id);
    };
    for (let round = 0; round < 3; round++) {
      await expire();
      let v = await readView(id, owners[0]);
      expect(v.round).toBe(round);
      expect(v.status).toBe("playing");
      const graph = await loadGraph(v.graphVersion),
        path = shortestPath(graph.index, v.question!.start, v.question!.end)!;
      for (const playerId of path.slice(1, -1))
        v = await commandMatch(id, owners[0], {
          requestId: randomUUID(),
          revision: v.revision,
          phaseRevision: v.phaseRevision,
          command: { type: "play", playerId, index: v.current!.board.length },
        });
      for (const o of owners) {
        const current = await readView(id, o);
        await commandMatch(id, o, {
          requestId: randomUUID(),
          revision: current.revision,
          phaseRevision: current.phaseRevision,
          command: { type: "lock" },
        });
      }
      if (round < 2) {
        await expire();
        expect((await readView(id, owners[0])).current).toBeNull();
      }
    }
    await Promise.all([settle(id), settle(id)]);
    expect(await db("card_rating_ledger").where({ match_id: id })).toHaveLength(
      2,
    );
    expect(
      (
        await db("card_ratings")
          .where({ user_id: owners[0].userId, variant: "unlimited" })
          .first()
      ).rating,
    ).toBe(1016);
    expect(await db("card_reservations").where({ match_id: id })).toHaveLength(
      0,
    );
  });
});
