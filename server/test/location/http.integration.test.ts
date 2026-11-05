import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import { initDb } from '../../src/db/init';
import { db } from '../../src/db/knex';
import { initRedis } from '../../src/redis';
import { errorHandler } from '../../src/middleware/common';
import locationRoutes from '../../src/location/routes';
import { loadGame, saveGame } from '../../src/location/store';
import { ensureDaily } from '../../src/location/games';
import { startLocationDailyScheduler } from '../../src/location/dailyScheduler';
import { MIX } from '../../src/location/rules';
import type { Difficulty, Identity } from '../../src/location/types';
import { seedLocationFixtures } from './database';

describe('location HTTP lifecycle', () => {
  let server: http.Server; let base = ''; let clean: () => Promise<void>;
  const identity: Identity = { key: `g:location-test-http-${randomUUID()}`, userId: null, name: 'Guest' };
  const cookie = jwt.sign({ key: identity.key.slice(2), typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
  async function req(path: string, body?: unknown, other = false) {
    const response = await fetch(`${base}/api/location${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: `csgofriberg_guest=${other ? jwt.sign({ key: 'location-test-other', typ: 'guest' }, config.jwtSecret) : cookie}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  beforeAll(async () => {
    await initDb(); await initRedis(); clean = await seedLocationFixtures();
    const app = express(); app.use(express.json()); app.use('/api/location', locationRoutes); app.use(errorHandler);
    server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await clean(); });
  it('fixes three disjoint daily decks and excludes their capture points from random games', async () => {
    // Two server instances start without any player/admin generation request.
    const stops = [startLocationDailyScheduler(), startLocationDailyScheduler()];
    await Promise.all(stops.map((stop) => stop()));
    const rows = await db('location_daily').select();
    expect(rows).toHaveLength(1);
    const generated = JSON.parse(rows[0].payload);
    expect(await ensureDaily()).toEqual(generated);
    const daily = await ensureDaily(); const items = Object.values(daily.decks).flat(); expect(new Set(items.map(q => q.question.capturePointId)).size).toBe(15);
    for (const difficulty of ['easy', 'normal', 'hard'] as Difficulty[]) {
      expect(Object.fromEntries(['easy', 'medium', 'hard'].map(t => [t, daily.decks[difficulty].filter(q => q.question.tier === t).length]))).toEqual(MIX[difficulty]);
      const created = await req('/games', { mode: 'random', difficulty }); expect(created.status).toBe(200);
      const stored = (await loadGame(created.data.id, identity))!;
      expect(stored.questions.every(q => !items.some(d => d.question.capturePointId === q.question.capturePointId))).toBe(true);
      const resume = await req('/games', { mode: 'random', difficulty }); expect(resume.data.id).toBe(stored.id);
      const input = { mapId: 'test_location', floorId: 'upper', u: .4, v: .5, round: 1, version: 0, requestId: randomUUID() };
      const answered = await req(`/games/${stored.id}/answers`, input); expect(answered.data.answered).toBe(1);
      expect((await req(`/games/${stored.id}/answers`, input)).data).toEqual(answered.data);
      expect((await req(`/games/${stored.id}/answers`, { ...input, u: .6 })).status).toBe(409);
      expect((await req(`/games/${stored.id}/answers`, { ...input, requestId: randomUUID() })).data.code).toBe('LOCATION_STALE_STATE');
      expect((await req(`/games/${stored.id}`, undefined, true)).status).toBe(404);
    }
  });
  it('resumes daily progress, abandons without consuming submission, and hides every result until final submit', async () => {
    let game = (await req('/games', { mode: 'daily', difficulty: 'normal' })).data;
    await req(`/games/${game.id}/answers`, { mapId: 'test_location', floorId: 'upper', u: .5, v: .5, round: 1, version: 0, requestId: randomUUID() });
    expect((await req('/games', { mode: 'daily', difficulty: 'normal' })).data.answered).toBe(1);
    expect((await req(`/games/${game.id}/abandon`, {})).status).toBe(200);
    const oldId = game.id; game = (await req('/games', { mode: 'daily', difficulty: 'normal' })).data; expect(game.id).not.toBe(oldId);
    const snapshots = (await loadGame(game.id, identity))!.questions;
    for (let round = 1; round <= 5; round++) {
      const q = snapshots[round - 1].question;
      const answer = await req(`/games/${game.id}/answers`, { mapId: q.mapId, floorId: q.floorId, u: q.u, v: q.v, round, version: round - 1, requestId: randomUUID() });
      expect(answer.status).toBe(200); game = answer.data; expect(game.results).toEqual([]); expect(game.totalScore).toBeNull(); expect(game).not.toHaveProperty('questions');
      expect((await req(`/games/${game.id}`)).data.results).toEqual([]);
      expect((await req(`/games/${game.id}/replay`)).status).toBe(404);
    }
    expect(game.status).toBe('ready');
    const submissions = await Promise.all([req(`/games/${game.id}/submit`, {}), req(`/games/${game.id}/submit`, {})]);
    expect(submissions.map(s => s.status)).toEqual([200, 200]); expect(submissions.every(s => s.data.totalScore === 25000)).toBe(true);
    expect(Number((await db('location_daily_attempts').where({ identity_key: identity.key, difficulty: 'normal' }).count('* as count').first())!.count)).toBe(1);
    expect(Number((await db('location_results').where({ identity_key: identity.key, game_id: game.id }).count('* as count').first())!.count)).toBe(1);
    expect((await req('/games', { mode: 'daily', difficulty: 'normal' })).data.status).toBe('finished');
    expect((await req(`/games/${game.id}/abandon`, {})).status).toBe(409);
    expect((await req(`/games/${game.id}/replay`)).data.totalScore).toBe(25000);
  });
  it('expires unfinished games and keeps scores independent of catalog edits', async () => {
    const created = await req('/games', { mode: 'daily', difficulty: 'easy' }); const game = (await loadGame(created.data.id, identity))!;
    const map = game.maps.find(m => m.id === 'test_location')!;
    const fixed = await ensureDaily();
    await db('location_maps').where({ id: map.id }).update({ payload: JSON.stringify({ ...map, enabled: false, version: 2, width: 2000 }) });
    const stop = startLocationDailyScheduler(); await stop();
    expect(await ensureDaily()).toEqual(fixed);
    expect((await loadGame(game.id, identity))!.questions[0].map.version).toBe(1);
    expect((await ensureDaily()).decks.easy[0].map.version).toBe(1);
    game.expiresAt = Date.now() - 1; await saveGame(game);
    expect((await req(`/games/${game.id}`)).status).toBe(410);
    const previous = config.showLeaderboard; config.showLeaderboard = false;
    try { expect((await req('/leaderboard')).status).toBe(403); } finally { config.showLeaderboard = previous; }
  });
  it('hides banned and opted-out accounts, restores unbanned entries, and preserves historical results', async () => {
    const date = '2001-01-02', ids: number[] = [];
    const previous = config.showLeaderboard; config.showLeaderboard = true;
    try {
      for (let i = 0; i < 3; i++) {
        const [user] = await db('users').insert({ username: `board_${randomUUID().slice(0, 16)}`, password_hash: 'unused',
          banned_at: i === 1 ? new Date().toISOString() : null, leaderboard_hidden: i === 2 }).returning('id');
        const id = Number(user.id); ids.push(id);
        await db('location_results').insert({ game_id: randomUUID(), identity_key: `u:${id}`, user_id: id, mode: 'daily',
          difficulty: 'normal', date, score: (i + 1) * 5000, finished_at: Date.now(), payload: '{}' });
      }
      const before = await db('location_results').whereIn('user_id', ids).orderBy('user_id');
      expect((await req(`/leaderboard?date=${date}`)).data.items.map((p: any) => p.score)).toEqual([5000]);
      await db('users').where({ id: ids[1] }).update({ banned_at: null });
      expect((await req(`/leaderboard?date=${date}`)).data.items.map((p: any) => [p.score, p.rank])).toEqual([[10000, 1], [5000, 2]]);
      expect(await db('location_results').whereIn('user_id', ids).orderBy('user_id')).toEqual(before);
    } finally {
      config.showLeaderboard = previous;
      await db('location_results').whereIn('user_id', ids).delete();
      await db('users').whereIn('id', ids).delete();
    }
  });
});
