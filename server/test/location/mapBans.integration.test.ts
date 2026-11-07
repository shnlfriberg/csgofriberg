import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { randomUUID, createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import { initDb } from '../../src/db/init';
import { db } from '../../src/db/knex';
import { initRedis } from '../../src/redis';
import { errorHandler } from '../../src/middleware/common';
import locationRoutes from '../../src/location/routes';
import { loadGame } from '../../src/location/store';
import { ensureDaily } from '../../src/location/games';
import { MIX } from '../../src/location/rules';
import { seedLocationFixtures } from './database';
import gameRoutes from '../../src/routes/game';
import statsRoutes from '../../src/routes/stats';
import { testMap, testPool } from './fixtures';

describe('solo map bans', () => {
  let server: http.Server, base: string, clean: () => Promise<void>;
  const owner = { key: `g:location-test-bans-${randomUUID()}`, userId: null, name: 'Guest' };
  const cookie = jwt.sign({ key: owner.key.slice(2), typ: 'guest' }, config.jwtSecret);
  const bans = ['test_location', 'test_ban_blocked'];
  async function req(path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: `csgofriberg_guest=${cookie}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  beforeAll(async () => {
    if (!process.env.DB_URL?.includes('verification')) throw new Error('ISOLATED_DB_REQUIRED');
    await initDb(); await initRedis(); clean = await seedLocationFixtures();
    await ensureDaily();
    for (const mapId of ['test_ban_blocked', 'test_ban_allowed']) {
      await db('location_maps').insert({ id: mapId, payload: JSON.stringify(testMap(mapId)) });
      for (const { question } of testPool(12)) {
        const id = `test_location_ban_${mapId}_${question.id}`;
        const q = { ...question, id, mapId, imageHash: createHash('sha256').update(id).digest('hex') };
        await db('location_questions').insert({ id, image_hash: q.imageHash, payload: JSON.stringify(q) });
      }
    }
    const app = express(); app.use(express.json()); app.use('/game', gameRoutes); app.use('/stats', statsRoutes);
    app.use(locationRoutes); app.use(errorHandler);
    server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await clean();
    await db('location_maps').whereIn('id', ['test_ban_blocked', 'test_ban_allowed']).delete();
  });
  it('rejects more than two, duplicate, unknown and daily bans', async () => {
    for (const bannedMapIds of [[...bans, 'test_ban_allowed'], [bans[0], bans[0]], ['missing_map']])
      expect((await req('/game/start', { variant: 'location', mode: 'normal', bannedMapIds })).status).toBe(400);
    expect((await req('/games', { mode: 'daily', difficulty: 'normal', bannedMapIds: bans })).status).toBe(400);
    const daily = await req('/games', { mode: 'daily', difficulty: 'normal' });
    expect(daily.status).toBe(200); expect(daily.data.bannedMapIds).toBeUndefined();
    expect((await loadGame(daily.data.id, owner))!.questions.every(q => q.map.id === 'test_location')).toBe(true);
  });
  it('filters all five rounds, resumes per difficulty like classic games and preserves bans through replay and restart', async () => {
    let game = (await req('/game/start', { variant: 'location', mode: 'hard', bannedMapIds: bans })).data;
    const id = game.gameId as string;
    const stored = (await loadGame(id, owner))!;
    expect(stored.questions).toHaveLength(5);
    expect(stored.questions.every(q => q.map.id === 'test_ban_allowed')).toBe(true);
    expect(Object.fromEntries(['easy', 'medium', 'hard'].map(t => [t, stored.questions.filter(q => q.question.tier === t).length]))).toEqual(MIX.hard);
    expect(game.maps.map((m: any) => m.id)).toEqual(expect.arrayContaining(bans));
    expect(game.bannedMapIds).toEqual([...bans].sort());
    // One active game per identity and difficulty: other ban lists resume it.
    expect((await req('/game/start', { variant: 'location', mode: 'hard', bannedMapIds: [...bans].reverse() })).data.gameId).toBe(id);
    const noBans = (await req('/game/start', { variant: 'location', mode: 'hard' })).data;
    expect(noBans.gameId).toBe(id); expect(noBans.bannedMapIds).toEqual([...bans].sort());
    const invalid = await req(`/game/${id}/guess`, { mapId: bans[0], floorId: 'upper', u: .5, v: .5, round: 1, version: 0, requestId: randomUUID() });
    expect(invalid.data.code).toBe('LOCATION_MAP_BANNED');
    expect((await req(`/game/${id}/state`)).data.answered).toBe(0);
    for (let i = 0; i < 5; i++) {
      const q = stored.questions[i].question;
      const response = await req(`/game/${id}/guess`, { mapId: q.mapId, floorId: q.floorId, u: q.u, v: q.v, round: i + 1, version: i, requestId: randomUUID() });
      expect(response.status).toBe(200); game = response.data;
    }
    expect(game.status).toBe('finished');
    expect((await req(`/stats/games/${id}/replay?variant=location`)).data.game.bannedMapIds).toEqual([...bans].sort());
    const next = (await req('/game/start', { variant: 'location', mode: 'hard', bannedMapIds: bans })).data;
    expect(next.gameId).not.toBe(id); expect(next.bannedMapIds).toEqual([...bans].sort());
    await req(`/game/${next.gameId}/exit`, {});
    const fresh = (await req('/game/start', { variant: 'location', mode: 'hard' })).data;
    expect(fresh.gameId).not.toBe(next.gameId); expect(fresh.bannedMapIds).toEqual([]);
  });
  it('reports insufficient remaining questions without falling back to banned maps', async () => {
    await db('location_questions').where('id', 'like', 'test_location_ban_test_ban_allowed_%').delete();
    const response = await req('/game/start', { variant: 'location', mode: 'easy', bannedMapIds: bans });
    expect(response.status).toBe(409); expect(response.data.code).toBe('LOCATION_BAN_POOL_INSUFFICIENT');
  });
});
