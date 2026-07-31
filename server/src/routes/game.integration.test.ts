import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import gameRoutes from './game';
import { config } from '../config';
import { initDb } from '../db/init';
import { db } from '../db/knex';
import { errorHandler } from '../middleware/common';
import { initRedis, redis, redisKey } from '../redis';
import { initPlayerCache } from '../services/playerCache';
import { shouldPersistSingleSettlement } from '../services/singleSettlementLimit';

let server: http.Server;
let baseUrl: string;

function guestCookie(key: string): string {
  const token = jwt.sign({ key, typ: 'guest' }, config.jwtSecret, {
    expiresIn: '1h',
    algorithm: 'HS256',
  });
  return `csgofriberg_guest=${token}`;
}

async function post(path: string, cookie: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

describe('single-player settlement soft limit', () => {
  beforeAll(async () => {
    await initDb();
    await initRedis();
    await initPlayerCache();
    const app = express();
    app.use(express.json());
    app.use('/api/game', gameRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('shows every result but persists only four settlements per identity per minute', async () => {
    const guestKey = `settlement-limit-${Date.now()}`;
    const cookie = guestCookie(guestKey);
    const gameIds: string[] = [];
    try {
      for (let index = 0; index < 5; index += 1) {
        const started = await post('/api/game/start', cookie, { mode: 'beginner' });
        expect(started.response.status).toBe(200);
        gameIds.push(started.data.gameId);

        const settled = await post(`/api/game/${started.data.gameId}/giveup`, cookie);
        expect(settled.response.status).toBe(200);
        expect(settled.data).toMatchObject({
          status: 'lost',
          answer: { id: expect.any(Number), nickname: expect.any(String) },
          recorded: index < 4,
        });
      }

      const rows = await db('games')
        .where({ guest_key: guestKey })
        .orderBy('created_at', 'asc')
        .select('session_id');
      expect(rows.map((row) => row.session_id)).toEqual(gameIds.slice(0, 4));
      expect(await db('games').where({ session_id: gameIds[4] }).first()).toBeUndefined();
    } finally {
      await db('games').where({ guest_key: guestKey }).del();
      await redis()?.del(redisKey(`single:settlement-limit:g:${guestKey}`));
    }
  });

  it('does not consume settlement capacity twice for a retried game', async () => {
    const identityKey = `g:settlement-idempotent-${Date.now()}`;
    const key = redisKey(`single:settlement-limit:${identityKey}`);
    try {
      expect(await shouldPersistSingleSettlement(identityKey, 'game-1')).toBe(true);
      expect(await shouldPersistSingleSettlement(identityKey, 'game-1')).toBe(true);
      expect(await shouldPersistSingleSettlement(identityKey, 'game-2')).toBe(true);
      expect(await shouldPersistSingleSettlement(identityKey, 'game-3')).toBe(true);
      expect(await shouldPersistSingleSettlement(identityKey, 'game-4')).toBe(true);
      expect(await shouldPersistSingleSettlement(identityKey, 'game-5')).toBe(false);
      expect(await shouldPersistSingleSettlement(identityKey, 'game-5')).toBe(false);
      expect(await redis()!.ttl(key)).toBeGreaterThan(0);
      expect(await redis()!.ttl(key)).toBeLessThanOrEqual(60);
    } finally {
      await redis()?.del(key);
    }
  });

  it('resumes without recording a discarded target and avoids an immediate repeat', async () => {
    const guestKey = `target-history-${Date.now()}`;
    const identityKey = `g:${guestKey}`;
    const cookie = guestCookie(guestKey);
    const historyKey = redisKey(`target-history:beginner:${identityKey}`);
    const first = await post('/api/game/start', cookie, { mode: 'beginner' });
    expect(first.response.status).toBe(200);
    const firstRaw = await redis()!.get(redisKey(`single:game:${first.data.gameId}`));
    const firstTarget = Number(JSON.parse(firstRaw!).targetPlayerId);
    try {
      const resumed = await post('/api/game/start', cookie, { mode: 'beginner' });
      expect(resumed.data.gameId).toBe(first.data.gameId);
      expect(await redis()!.zCard(historyKey)).toBe(1);

      expect((await post(`/api/game/${first.data.gameId}/giveup`, cookie)).response.status).toBe(200);
      const second = await post('/api/game/start', cookie, { mode: 'beginner' });
      const secondRaw = await redis()!.get(redisKey(`single:game:${second.data.gameId}`));
      const secondTarget = Number(JSON.parse(secondRaw!).targetPlayerId);
      expect(secondTarget).not.toBe(firstTarget);
      await post(`/api/game/${second.data.gameId}/giveup`, cookie);
    } finally {
      await db('games').where({ guest_key: guestKey }).del();
      await redis()?.del([
        historyKey,
        redisKey(`single:settlement-limit:${identityKey}`),
      ]);
    }
  });

  it('persists accepted guess times relative to the game start', async () => {
    const guestKey = `guess-times-${Date.now()}`;
    const cookie = guestCookie(guestKey);
    const started = await post('/api/game/start', cookie, { mode: 'beginner' });
    expect(started.response.status).toBe(200);
    const activeRaw = await redis()!.get(redisKey(`single:game:${started.data.gameId}`));
    const targetPlayerId = Number(JSON.parse(activeRaw!).targetPlayerId);
    try {
      const guessed = await post(`/api/game/${started.data.gameId}/guess`, cookie, {
        playerId: targetPlayerId,
      });
      expect(guessed.response.status).toBe(200);
      expect(guessed.data.status).toBe('won');
      expect(guessed.data.answer.region).toEqual(expect.any(String));
      expect(guessed.data).not.toHaveProperty('guessTimes');

      const stored = await db('games').where({ session_id: started.data.gameId }).first();
      const guessTimes = JSON.parse(String(stored.guess_times));
      expect(guessTimes).toHaveLength(1);
      expect(guessTimes[0]).toBeGreaterThanOrEqual(0);
      expect(guessTimes[0]).toBeLessThan(60_000);
    } finally {
      await db('games').where({ session_id: started.data.gameId }).del();
      await redis()?.del(redisKey(`single:settlement-limit:g:${guestKey}`));
    }
  });
});
