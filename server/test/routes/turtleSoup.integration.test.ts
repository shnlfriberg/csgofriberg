import http from 'http';
import { randomUUID } from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import gameRoutes from '../../src/routes/game';
import statsRoutes from '../../src/routes/stats';
import leaderboardRoutes from '../../src/routes/leaderboard';
import authRoutes from '../../src/routes/auth';
import { errorHandler } from '../../src/middleware/common';
import { signToken } from '../../src/middleware/auth';
import { config } from '../../src/config';
import { db } from '../../src/db/knex';
import { initDb } from '../../src/db/init';
import { initRedis, redis, redisKey } from '../../src/redis';
import { getEnabledPlayers, initPlayerCache } from '../../src/services/playerCache';
import { getPlayerPerformance } from '../../src/services/playerPerformance';
import { invalidateCached } from '../../src/services/queryCache';
import { allGlobalStatsCacheKeys } from '../../src/services/statsCache';
import { allLeaderboardCacheKeys } from '../../src/services/leaderboardCache';

let server: http.Server;
let baseUrl: string;
const owners: string[] = [];
const users: number[] = [];
const ids: string[] = [];
function guest() {
  const key = `soup-${randomUUID()}`;
  owners.push(key);
  const cookie = `csgofriberg_guest=${jwt.sign({ key, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' })}`;
  return { key, cookie };
}
async function request(path: string, cookie: string, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function start(cookie: string, variant = 'turtle-soup') {
  const result = await request('/game/start', cookie, { mode: 'beginner', variant });
  expect(result.status).toBe(200);
  ids.push(result.data.gameId);
  return result.data;
}
const mutation = (version: number, extra: Record<string, unknown> = {}) => ({ version, requestId: randomUUID(), ...extra });
async function state(gameId: string) {
  return JSON.parse((await redis()!.get(redisKey(`single:game:${gameId}`)))!);
}

describe('turtle soup API, persistence and isolation', () => {
  beforeAll(async () => {
    await initDb(); await initRedis(); await initPlayerCache();
    const app = express();
    app.use(express.json());
    app.use('/api/game', gameRoutes); app.use('/api/stats', statsRoutes);
    app.use('/api/leaderboard', leaderboardRoutes); app.use('/api/auth', authRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await db('games').whereIn('session_id', ids).orWhereIn('guest_key', owners).orWhereIn('user_id', users).del();
    await db('users').whereIn('id', users).del();
    await invalidateCached(...allGlobalStatsCacheKeys(), ...allLeaderboardCacheKeys());
  });

  it('resumes without leaking targets and keeps classic/soup sessions independent', async () => {
    const { cookie } = guest();
    const soup = await start(cookie);
    const classic = await start(cookie, 'classic');
    expect(soup.gameId).not.toBe(classic.gameId);
    expect(await start(cookie)).toEqual(soup);
    expect(await start(cookie, 'classic')).toEqual(classic);
    expect(soup).toMatchObject({ maxQuestions: 24, remainingQuestions: 24, guessUnlocked: true, events: [], version: 0 });
    expect(soup).not.toHaveProperty('target'); expect(soup).not.toHaveProperty('answer');
    const options = await request(`/game/${soup.gameId}/question-options`, cookie);
    expect(options.status).toBe(200); expect(options.data.teams.length).toBeGreaterThan(0);
    expect((await request(`/game/${soup.gameId}/state`, guest().cookie)).status).toBe(404);
    expect((await request(`/game/${soup.gameId}/question-options`, guest().cookie)).status).toBe(404);
    expect((await request(`/game/${classic.gameId}/question`, cookie, mutation(0, { field: 'age', value: 25 }))).status).toBe(400);
  });

  it('does not spend attempts on invalid requests, and allows consecutive guesses', async () => {
    const { cookie } = guest(); const game = await start(cookie); const stored = await state(game.gameId);
    for (const question of [{ field: 'age', value: 1.5 }, { field: 'team', value: 'not-a-real-team' }, { field: 'nationality', value: 'not-a-country' }]) {
      expect((await request(`/game/${game.gameId}/question`, cookie, mutation(0, question))).status).toBe(400);
    }
    expect((await request(`/game/${game.gameId}/state`, cookie)).data.version).toBe(0);
    const asked = await request(`/game/${game.gameId}/question`, cookie, mutation(0, { field: 'age', value: stored.soup.target.age }));
    expect(asked.data.events[0]).toMatchObject({ level: 'correct', type: 'question' });
    expect(asked.data.events[0]).not.toHaveProperty('hint');
    expect((await request(`/game/${game.gameId}/guess`, cookie, { playerId: stored.targetPlayerId })).data.code).toBe('VALIDATION_FAILED');
    const otherId = getEnabledPlayers().find((p) => p.id !== stored.targetPlayerId)!.id;
    const wrong = await request(`/game/${game.gameId}/guess`, cookie, mutation(1, { playerId: otherId }));
    expect(wrong.data).toMatchObject({ status: 'playing', guessUnlocked: true, remainingQuestions: 22, questionCount: 1, guessCount: 1 });
    expect((await request(`/game/${game.gameId}/guess`, cookie, mutation(2, { playerId: stored.targetPlayerId }))).data).toMatchObject({ status: 'won', questionCount: 1, guessCount: 2, remainingQuestions: 21 });
  });

  it('serializes simultaneous actions and safely replays duplicate request IDs', async () => {
    const { cookie } = guest(); const game = await start(cookie);
    const first = mutation(0, { field: 'age', value: 25 });
    const results = await Promise.all([request(`/game/${game.gameId}/question`, cookie, first), request(`/game/${game.gameId}/question`, cookie, first)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0].data.remainingQuestions).toBe(23);
    expect(results[1].data.remainingQuestions).toBe(23);
    const conflict = await request(`/game/${game.gameId}/question`, cookie, { ...first, value: 26 });
    expect(conflict.status).toBe(409);
    const competing = await Promise.all([24, 30].map((value) => request(`/game/${game.gameId}/question`, cookie, mutation(1, { field: 'age', value }))));
    expect(competing.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await request(`/game/${game.gameId}/state`, cookie)).data).toMatchObject({ remainingQuestions: 22, version: 2 });
  });

  it('allows a first-action win and counts it as one attempt in statistics', async () => {
    const { cookie } = guest(); const game = await start(cookie); const stored = await state(game.gameId);
    const body = mutation(0, { playerId: stored.targetPlayerId });
    const result = await request(`/game/${game.gameId}/guess`, cookie, body);
    expect(result.data).toMatchObject({ status: 'won', questionCount: 0, guessCount: 1, remainingQuestions: 23 });
    expect((await request(`/game/${game.gameId}/guess`, cookie, body)).data).toEqual(result.data);
    const stats = await request('/stats/me?variant=turtle-soup', cookie);
    expect(stats.data.countMetric).toBe('attempts');
    expect(stats.data.personal).toMatchObject({ wins: 1, avgGuesses: 1, bestGuesses: 1 });
  });

  it('deduplicates consecutive guesses and settles when the last attempt is a question', async () => {
    const { cookie } = guest(); const game = await start(cookie); const stored = await state(game.gameId);
    const playerId = getEnabledPlayers().find((p) => p.id !== stored.targetPlayerId)!.id;
    const first = mutation(0, { playerId });
    const results = await Promise.all([request(`/game/${game.gameId}/guess`, cookie, first), request(`/game/${game.gameId}/guess`, cookie, first)]);
    for (const result of results) expect(result.data).toMatchObject({ guessCount: 1, questionCount: 0, remainingQuestions: 23 });
    for (let version = 1; version < 23; version++) {
      const result = await request(`/game/${game.gameId}/guess`, cookie, mutation(version, { playerId }));
      expect(result.status).toBe(200);
      expect(result.data.status).toBe('playing');
    }
    const finalQuestion = mutation(23, { field: 'age', value: stored.soup.target.age });
    const final = await request(`/game/${game.gameId}/question`, cookie, finalQuestion);
    expect(final.data).toMatchObject({ status: 'lost', questionCount: 1, guessCount: 23, remainingQuestions: 0, recorded: true });
    expect(final.data.answer.id).toBe(stored.targetPlayerId);
    expect((await request(`/game/${game.gameId}/question`, cookie, finalQuestion)).data).toEqual(final.data);
    expect((await request(`/game/${game.gameId}/guess`, cookie, mutation(24, { playerId: stored.targetPlayerId }))).data.code).toBe('GAME_FINISHED');
    expect(await db('games').where({ session_id: game.gameId })).toHaveLength(1);
  });

  it.each([true, false])('leaves the 24th attempt playable and settles a final correct=%s exactly once', async (correct) => {
    const { cookie } = guest(); const game = await start(cookie); const stored = await state(game.gameId);
    for (let version = 0; version < 23; version++) {
      const result = await request(`/game/${game.gameId}/question`, cookie, mutation(version, { field: 'age', value: 25 }));
      expect(result.status).toBe(200); expect(result.data.status).toBe('playing');
    }
    const playerId = correct ? stored.targetPlayerId : getEnabledPlayers().find((p) => p.id !== stored.targetPlayerId)!.id;
    const body = mutation(23, { playerId });
    const final = await request(`/game/${game.gameId}/guess`, cookie, body);
    expect(final.data).toMatchObject({ status: correct ? 'won' : 'lost', remainingQuestions: 0, questionCount: 23, guessCount: 1, recorded: true });
    expect(final.data.answer.nickname).toBe(stored.soup.target.nickname);
    expect((await request(`/game/${game.gameId}/guess`, cookie, body)).data).toEqual(final.data);
    expect((await request(`/game/${game.gameId}/state`, cookie)).data).toEqual(final.data);
    expect((await request(`/game/${game.gameId}/guess`, guest().cookie, body)).status).toBe(404);
    const rows = await db('games').where({ session_id: game.gameId });
    expect(rows).toHaveLength(1); expect(rows[0].question_count).toBe(23); expect(rows[0].guess_count).toBe(1);
    expect(await redis()!.get(redisKey(`single:game:${game.gameId}`))).toBeNull();
  });

  it('freezes feedback and replays, allows immediate giveup, and isolates statistics', async () => {
    const { cookie, key } = guest(); const game = await start(cookie); const stored = await state(game.gameId);
    const player = getEnabledPlayers().find((p) => p.id === stored.targetPlayerId)!;
    const originalAge = player.age;
    try {
      player.age += 40;
      const asked = await request(`/game/${game.gameId}/question`, cookie, mutation(0, { field: 'age', value: originalAge - 1 }));
      expect(asked.data.events[0]).toMatchObject({ level: 'close', hint: 'higher' });
      const win = await request(`/game/${game.gameId}/guess`, cookie, mutation(1, { playerId: player.id }));
      expect(win.data.answer.age).toBe(originalAge);
      const row = await db('games').where({ session_id: game.gameId }).first();
      const replay = await request(`/stats/games/${row.id}/replay`, cookie);
      expect(replay.data.answer.age).toBe(originalAge);
      expect(replay.data.events).toEqual(win.data.events);
      expect((await request(`/stats/games/${row.id}/replay`, guest().cookie)).status).toBe(404);
      const stats = await request('/stats/me?variant=turtle-soup&difficulties=beginner', cookie);
      expect(stats.data.personal).toMatchObject({ totalGames: 1, wins: 1, avgGuesses: 2, bestGuesses: 2 });
      const classicStats = await request('/stats/me?difficulties=beginner', cookie);
      expect(classicStats.data.personal.totalGames).toBe(0);
      expect((await getPlayerPerformance({ key: `g:${key}`, userId: null })).single.games).toBe(0);
      expect((await request('/stats/replays?variant=turtle-soup', cookie)).data.items).toHaveLength(1);
      expect((await request('/stats/replays', cookie)).data.items).toHaveLength(0);
    } finally { player.age = originalAge; }
    const next = await start(cookie);
    expect((await request(`/game/${next.gameId}/giveup`, cookie, mutation(0))).data).toMatchObject({ status: 'lost', questionCount: 0, recorded: true });
  });

  it('expires inactive games without extending TTL on reads, and never records discarded games', async () => {
    const { cookie } = guest(); const game = await start(cookie); const key = redisKey(`single:game:${game.gameId}`);
    await redis()!.expire(key, 30);
    await request(`/game/${game.gameId}/state`, cookie);
    expect(await redis()!.ttl(key)).toBeLessThanOrEqual(30);
    const raw = await state(game.gameId); raw.lastActiveAt = Date.now() - 1801_000;
    await redis()!.set(key, JSON.stringify(raw));
    expect((await request(`/game/${game.gameId}/state`, cookie)).status).toBe(404);
    const next = await start(cookie);
    expect((await request(`/game/${next.gameId}/exit`, cookie, {})).status).toBe(200);
    expect((await request(`/game/${next.gameId}/state`, cookie)).status).toBe(404);
    expect(await db('games').whereIn('session_id', [game.gameId, next.gameId])).toHaveLength(0);
  });

  it('claims guest soup records and invalidates the independently cached leaderboard', async () => {
    const { cookie, key } = guest(); const game = await start(cookie); const stored = await state(game.gameId);
    const [user] = await db('users').insert({ username: `soup-user-${randomUUID()}`, password_hash: 'unused', role: 'user', token_version: 0 }).returning('id');
    users.push(Number(user.id));
    const authCookie = `csgofriberg_session=${signToken({ id: Number(user.id), token_version: 0 })}; ${cookie}`;
    const before = await request('/leaderboard?mode=turtle-soup&difficulty=beginner', authCookie);
    expect(before.status).toBe(200); expect(before.data.currentUser.rank).toBeNull();
    await request(`/game/${game.gameId}/question`, cookie, mutation(0, { field: 'age', value: 25 }));
    await request(`/game/${game.gameId}/question`, cookie, mutation(1, { field: 'age', value: 25 }));
    await request(`/game/${game.gameId}/guess`, cookie, mutation(2, { playerId: stored.targetPlayerId }));
    expect((await request('/auth/claim', authCookie, {})).data.claimed).toBe(1);
    const board = await request('/leaderboard?mode=turtle-soup&difficulty=beginner', authCookie);
    expect(board.data.items.find((entry: { id: number }) => entry.id === Number(user.id))).toMatchObject({ wins: 1, total: 1, avgGuesses: 3 });
    expect((await request('/leaderboard?mode=single&difficulty=beginner', authCookie)).data.items.find((entry: { id: number }) => entry.id === Number(user.id))).toBeUndefined();
    const row = await db('games').where({ session_id: game.gameId }).first();
    expect(row.guest_key).toBeNull(); expect(row.user_id).toBe(Number(user.id));
    expect((await request(`/stats/games/${row.id}/replay`, cookie)).status).toBe(404);
    expect((await request(`/stats/games/${row.id}/replay`, authCookie)).status).toBe(200);
    expect((await request('/stats/me?variant=turtle-soup', authCookie)).data.personal.totalGames).toBe(1);
  });

  it('honors the shared settlement soft limit without losing final receipts', async () => {
    const { cookie, key } = guest();
    for (let index = 0; index < 5; index++) {
      const game = await start(cookie);
      const body = mutation(0);
      const result = await request(`/game/${game.gameId}/giveup`, cookie, body);
      expect(result.data).toMatchObject({ status: 'lost', recorded: index < 4 });
      expect((await request(`/game/${game.gameId}/giveup`, cookie, body)).data).toEqual(result.data);
    }
    expect(await db('games').where({ guest_key: key })).toHaveLength(4);
  });

  it('sorts soup rankings like classic and respects hidden accounts and difficulty', async () => {
    const inserted = await db('users').insert(Array.from({ length: 5 }, (_, index) => ({
      username: `soup-rank-${index}-${randomUUID()}`, password_hash: 'unused',
      role: 'user', token_version: 0, leaderboard_hidden: index === 4,
    }))).returning('id');
    const player = getEnabledPlayers()[0];
    const userIds = inserted.map((u) => Number(u.id)); users.push(...userIds);
    const records = userIds.flatMap((userId, index) => {
      const outcomes = index === 0 ? ['won', 'lost'] : index === 4 ? ['won', 'won', 'won'] : ['won'];
      return outcomes.map((status) => ({
        session_id: randomUUID(), user_id: userId, target_player_id: player.id,
        mode: index === 3 ? 'easy' : 'beginner', variant: 'turtle-soup',
        status, question_count: status === 'won' ? 7 : 18, guess_count: 1, finished_at: db.fn.now(),
      }));
    });
    await db('games').insert(records);
    await invalidateCached(...allLeaderboardCacheKeys());
    const board = await request('/leaderboard?mode=turtle-soup&difficulty=beginner', guest().cookie);
    expect(board.status).toBe(200);
    const own = board.data.items.filter((entry: { id: number }) => userIds.includes(entry.id));
    expect(own.map((entry: { id: number }) => entry.id)).toEqual([userIds[1], userIds[2], userIds[0]]);
    expect(own[2]).toMatchObject({ avgGuesses: 8, wins: 1, total: 2, winRate: 0.5 });
    expect(board.data.countMetric).toBe('attempts');
  });
});
