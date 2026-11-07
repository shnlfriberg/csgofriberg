import http from 'http';
import { randomUUID } from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import gameRoutes from '../../src/routes/game';
import { errorHandler } from '../../src/middleware/common';
import { config } from '../../src/config';
import { initDb } from '../../src/db/init';
import { initRedis } from '../../src/redis';
import { initPlayerCache } from '../../src/services/playerCache';
import { ensureDaily, startGame } from '../../src/location/games';
import { loadGame } from '../../src/location/store';
import { seedLocationFixtures } from '../location/database';

/**
 * 图寻 单人 and 海龟汤 on the shared single-player API: classic-style start
 * (create or resume per identity, mode and variant), dispatch of /:id routes by
 * the owning variant, and the compact response formats.
 */
let server: http.Server;
let baseUrl: string;
let clean: () => Promise<void>;

function guest() {
  const key = `location-test-solo-${randomUUID()}`;
  return {
    owner: { key: `g:${key}`, userId: null, name: 'Guest' },
    cookie: `csgofriberg_guest=${jwt.sign({ key, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' })}`,
  };
}
async function request(cookie: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

describe('single-player API for entertainment variants', () => {
  beforeAll(async () => {
    if (!process.env.DB_URL?.includes('verification')) throw new Error('ISOLATED_DB_REQUIRED');
    await initDb(); await initRedis(); await initPlayerCache();
    clean = await seedLocationFixtures();
    await ensureDaily();
    const app = express();
    app.use(express.json());
    app.use('/api/game', gameRoutes);
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await clean();
  });

  it('starts or resumes 图寻 单人 like classic games and answers guesses with compact deltas', async () => {
    const { owner, cookie } = guest();
    const first = await request(cookie, '/game/start', { variant: 'location', mode: 'hard' });
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ variant: 'location', mode: 'hard', status: 'playing', version: 0, answered: 0, round: 1 });
    expect(first.data.id).toBeUndefined();
    expect(first.data.difficulty).toBeUndefined();
    expect(first.data.maps.some((map: { id: string }) => map.id === 'test_location')).toBe(true);
    const gameId = first.data.gameId as string;
    const hash = first.data.mapsHash as string;

    // Another tab or device: the same identity and difficulty resume the game,
    // whatever bans it asks for; maps it already holds are not sent again.
    const again = await request(cookie, '/game/start', { variant: 'location', mode: 'hard', bannedMapIds: ['test_location'] },
      { 'X-Location-Maps': hash });
    expect(again.data.gameId).toBe(gameId);
    expect(again.data.bannedMapIds).toEqual([]);
    expect(again.data.maps).toBeUndefined();
    const easy = await request(cookie, '/game/start', { variant: 'location', mode: 'easy' });
    expect(easy.data.gameId).not.toBe(gameId);

    const stored = (await loadGame(gameId, owner))!;
    for (let index = 0; index < 5; index++) {
      const { question } = stored.questions[index];
      const body = { mapId: question.mapId, floorId: question.floorId, u: question.u, v: question.v,
        round: index + 1, version: index, requestId: randomUUID() };
      const answered = await request(cookie, `/game/${gameId}/guess`, body);
      expect(answered.status).toBe(200);
      expect(answered.data).toMatchObject({ gameId, variant: 'location', base: index, version: index + 1, answered: index + 1 });
      expect(answered.data.guess).toEqual({ mapId: question.mapId, floorId: question.floorId, u: question.u, v: question.v });
      expect(answered.data.result).toMatchObject({ round: index + 1, score: 5000, questionId: question.id });
      expect(answered.data.result.map).toBeUndefined();
      expect(answered.data.maps).toBeUndefined();
      if (index === 0) {
        // A replayed request has no base: it answers with the current view.
        const replay = await request(cookie, `/game/${gameId}/guess`, body, { 'X-Location-Maps': hash });
        expect(replay.data.base).toBeUndefined();
        expect(replay.data).toMatchObject({ gameId, version: 1, results: [expect.objectContaining({ round: 1 })] });
        expect(replay.data.results[0].map).toBeUndefined();
      }
      if (index === 4) expect(answered.data).toMatchObject({ status: 'finished', question: null, totalScore: 25000 });
    }
    const finished = await request(cookie, `/game/${gameId}/state`, undefined, { 'X-Location-Maps': hash });
    expect(finished.data).toMatchObject({ gameId, variant: 'location', mode: 'hard', status: 'finished', totalScore: 25000 });
    expect(finished.data.results).toHaveLength(5);
    expect(finished.data.maps).toBeUndefined();

    // A finished game is not resumed; exit abandons the next one.
    const next = await request(cookie, '/game/start', { variant: 'location', mode: 'hard' });
    expect(next.data.gameId).not.toBe(gameId);
    expect((await request(cookie, `/game/${next.data.gameId}/exit`, {})).data).toEqual({ ok: true });
    expect((await request(cookie, `/game/${next.data.gameId}/state`)).data.code).toBe('LOCATION_GAME_NOT_FOUND');
    expect((await request(cookie, '/game/start', { variant: 'location', mode: 'hard' })).data.gameId).not.toBe(next.data.gameId);

    // Other identities and moves of other variants are rejected.
    expect((await request(guest().cookie, `/game/${gameId}/state`)).data.code).toBe('GAME_NOT_FOUND');
    expect((await request(cookie, `/game/${easy.data.gameId}/command`, {})).data.code).toBe('GAME_VARIANT_UNAVAILABLE');
    expect((await request(cookie, `/game/${easy.data.gameId}/giveup`, {})).data.code).toBe('GAME_VARIANT_UNAVAILABLE');
  });

  it('validates 图寻 options and keeps daily games off the single-player routes', async () => {
    const { owner, cookie } = guest();
    expect((await request(cookie, '/game/start', { variant: 'location', mode: 'beginner' })).status).toBe(400);
    expect((await request(cookie, '/game/start', { variant: 'location', mode: 'normal', bannedMapIds: ['a', 'b', 'c'] })).status).toBe(400);
    expect((await request(cookie, '/game/start', { variant: 'unknown', mode: 'normal' })).status).toBe(400);
    const daily = await startGame(owner, 'daily', 'normal');
    expect((await request(cookie, `/game/${daily.id}/state`)).data.code).toBe('GAME_NOT_FOUND');
    const started = await request(cookie, '/game/start', { variant: 'location', mode: 'normal' });
    expect((await request(cookie, `/game/${started.data.gameId}/guess`, { playerId: 1 })).status).toBe(400);
  });

  it('answers every new 海龟汤 write with a delta and replays with the full view', async () => {
    const { cookie } = guest();
    const game = (await request(cookie, '/game/start', { mode: 'beginner', variant: 'turtle-soup' })).data;
    const body = { field: 'age', value: 25, version: 0, requestId: randomUUID() };
    const delta = await request(cookie, `/game/${game.gameId}/question`, body);
    expect(delta.data).toMatchObject({ gameId: game.gameId, variant: 'turtle-soup', base: 0, version: 1, questionCount: 1,
      remainingQuestions: 23, event: { type: 'question', field: 'age', requestId: body.requestId } });
    expect(delta.data.events).toBeUndefined();
    const replay = await request(cookie, `/game/${game.gameId}/question`, body);
    expect(replay.data.base).toBeUndefined();
    expect(replay.data.events).toHaveLength(1);
    const next = await request(cookie, `/game/${game.gameId}/question`, { field: 'age', value: 30, version: 1, requestId: randomUUID() });
    expect(next.data).toMatchObject({ gameId: game.gameId, base: 1, version: 2, event: { value: 30 } });
    const state = await request(cookie, `/game/${game.gameId}/state`);
    expect(state.data.events).toHaveLength(2);
    await request(cookie, `/game/${game.gameId}/exit`, {});
  });

});
