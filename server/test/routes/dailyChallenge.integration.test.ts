import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import dailyChallengeRoutes from '../../src/routes/dailyChallenge';
import gameRoutes from '../../src/routes/game';
import { config } from '../../src/config';
import { initDb } from '../../src/db/init';
import { db } from '../../src/db/knex';
import { errorHandler } from '../../src/middleware/common';
import { initRedis, redis, redisKey } from '../../src/redis';
import { initPlayerCache } from '../../src/services/playerCache';
import {
  dailyChallengeWindow,
  dailyLeaderboardCacheKey,
} from '../../src/services/dailyChallenge';
import { invalidateCached } from '../../src/services/queryCache';

let server: http.Server;
let baseUrl: string;

function guestCookie(key: string): string {
  const token = jwt.sign({ key, typ: 'guest' }, config.jwtSecret, {
    expiresIn: '1h',
    algorithm: 'HS256',
  });
  return `csgofriberg_guest=${token}`;
}

async function request(path: string, cookie: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

describe('daily challenge routes', () => {
  beforeAll(async () => {
    await initDb();
    await initRedis();
    await initPlayerCache();
    const app = express();
    app.use(express.json());
    app.use('/api/daily-challenge', dailyChallengeRoutes);
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

  it('runs one fixed challenge per difficulty and ranks wins by guess count', async () => {
    const stamp = Date.now();
    const guestKey = `daily-route-${stamp}`;
    const secondGuestKey = `daily-route-second-${stamp}`;
    const cookie = guestCookie(guestKey);
    const secondCookie = guestCookie(secondGuestKey);
    const extraIdentityPrefix = `g:daily-board-${stamp}-`;
    const { date } = dailyChallengeWindow();
    const overview = await request('/api/daily-challenge/overview', cookie);
    expect(overview.response.status).toBe(200);
    expect(overview.data).toMatchObject({
      date,
      timeZone: 'Asia/Shanghai',
      serverNow: expect.any(Number),
    });
    expect(overview.data.nextRefreshAt - overview.data.serverNow).toBeGreaterThan(0);
    expect(overview.data.challenges).toHaveLength(3);
    expect(overview.data.challenges.every((item: any) => (
      Object.keys(item).sort().join(',') === 'difficulty,status'
    ))).toBe(true);

    const hiddenLeaderboard = await request('/api/daily-challenge/beginner/leaderboard', cookie);
    expect(hiddenLeaderboard.response.status).toBe(409);
    expect(hiddenLeaderboard.data).toEqual({ code: 'DAILY_CHALLENGE_INCOMPLETE' });

    const challenge = await db('daily_challenges')
      .where({ challenge_date: date, difficulty_key: 'beginner' })
      .first('id', 'solved_count as solvedCount');
    const challengeId = Number(challenge.id);
    const initialSolvedCount = Number(challenge.solvedCount);
    let firstGameId: string | null = null;
    let secondGameId: string | null = null;

    try {
      const [started, secondStarted] = await Promise.all([
        request('/api/daily-challenge/start', cookie, 'POST', { difficulty: 'beginner' }),
        request('/api/daily-challenge/start', secondCookie, 'POST', { difficulty: 'beginner' }),
      ]);
      expect(started.response.status).toBe(200);
      expect(secondStarted.response.status).toBe(200);
      expect(started.data).toMatchObject({ difficulty: 'beginner', status: 'playing' });
      firstGameId = String(started.data.gameId);
      secondGameId = String(secondStarted.data.gameId);
      const gameKey = redisKey(`single:game:${firstGameId}`);
      const secondGameKey = redisKey(`single:game:${secondGameId}`);
      const stored = JSON.parse((await redis()!.get(gameKey))!);
      const secondStored = JSON.parse((await redis()!.get(secondGameKey))!);
      expect(stored).toMatchObject({ kind: 'daily', targetPlayerId: expect.any(Number) });
      expect(secondStored.targetPlayerId).toBe(stored.targetPlayerId);

      const playingDetail = await request('/api/daily-challenge/beginner', cookie);
      expect(playingDetail.response.status).toBe(200);
      expect(playingDetail.data.serverNow).toEqual(expect.any(Number));
      expect(playingDetail.data.nextRefreshAt - playingDetail.data.serverNow).toBeGreaterThan(0);
      expect(playingDetail.data.challenge).toMatchObject({
        difficulty: 'beginner',
        status: 'playing',
        gameId: firstGameId,
      });
      expect(playingDetail.data).not.toHaveProperty('challenges');

      const normalGiveup = await request(`/api/game/${firstGameId}/giveup`, cookie, 'POST');
      expect(normalGiveup.response.status).toBe(404);

      const [solved, secondSolved] = await Promise.all([
        request(`/api/daily-challenge/${firstGameId}/guess`, cookie, 'POST', {
          playerId: stored.targetPlayerId,
        }),
        request(`/api/daily-challenge/${secondGameId}/guess`, secondCookie, 'POST', {
          playerId: stored.targetPlayerId,
        }),
      ]);
      expect(solved.response.status).toBe(200);
      expect(secondSolved.response.status).toBe(200);
      expect(solved.data).toMatchObject({ status: 'won', guessCount: 1 });
      expect(secondSolved.data).toMatchObject({ status: 'won', guessCount: 1 });
      expect([solved.data.solveOrder, secondSolved.data.solveOrder].sort((a, b) => a - b)).toEqual([
        initialSolvedCount + 1,
        initialSolvedCount + 2,
      ]);
      expect(await redis()!.get(gameKey)).toBeNull();
      expect(await redis()!.get(secondGameKey)).toBeNull();

      const restarted = await request('/api/daily-challenge/start', cookie, 'POST', {
        difficulty: 'beginner',
      });
      expect(restarted.response.status).toBe(409);
      expect(restarted.data).toEqual({ code: 'DAILY_CHALLENGE_COMPLETED' });

      const extraRows = Array.from({ length: 11 }, (_, index) => ({
        challenge_id: challengeId,
        identity_key: `${extraIdentityPrefix}${index}`,
        guest_key: `daily-board-${stamp}-${index}`,
        display_name: `访客#D${String(index).padStart(4, '0')}`,
        status: 'won',
        guess_count: 2 + (index % 7),
        solve_order: initialSolvedCount + 3 + index,
        guesses: '[]',
        guess_times: '[]',
        finished_at: new Date(Date.now() + index),
      }));
      await db('daily_challenge_attempts').insert(extraRows);
      await db('daily_challenges')
        .where({ id: challengeId })
        .update({ solved_count: initialSolvedCount + 2 + extraRows.length });

      const refreshedOverview = await request('/api/daily-challenge/overview', cookie);
      const beginnerStatus = refreshedOverview.data.challenges.find(
        (item: any) => item.difficulty === 'beginner'
      );
      expect(beginnerStatus).toEqual({ difficulty: 'beginner', status: 'won' });

      const completedDetail = await request('/api/daily-challenge/beginner', cookie);
      expect(completedDetail.response.status).toBe(200);
      expect(completedDetail.data.challenge.status).toBe('won');
      expect(completedDetail.data.challenge.answer).toMatchObject({ id: stored.targetPlayerId });
      expect(completedDetail.data.challenge.solveOrder).toBe(solved.data.solveOrder);
      expect(completedDetail.data.challenge).not.toHaveProperty('leaderboard');

      const leaderboard = await request('/api/daily-challenge/beginner/leaderboard', cookie);
      expect(leaderboard.response.status).toBe(200);
      expect(leaderboard.data).toMatchObject({ difficulty: 'beginner' });
      expect(leaderboard.data.leaderboard).toHaveLength(10);
      expect(leaderboard.data.leaderboard.find((row: any) => row.isCurrent)).toMatchObject({
        guessCount: 1,
      });
      expect(leaderboard.data.leaderboard.map((row: any) => row.guessCount)).toEqual(
        [...leaderboard.data.leaderboard.map((row: any) => row.guessCount)].sort((a, b) => a - b)
      );
    } finally {
      await db('daily_challenge_attempts')
        .whereIn('identity_key', [`g:${guestKey}`, `g:${secondGuestKey}`])
        .orWhere('identity_key', 'like', `${extraIdentityPrefix}%`)
        .del();
      await db('daily_challenges')
        .where({ id: challengeId })
        .update({ solved_count: initialSolvedCount });
      await invalidateCached(dailyLeaderboardCacheKey(date, 'beginner'));
      await redis()?.del(redisKey(`single:active:g:${guestKey}:daily:${date}:beginner`));
      await redis()?.del(redisKey(`single:active:g:${secondGuestKey}:daily:${date}:beginner`));
      if (firstGameId) await redis()?.del(redisKey(`single:game:${firstGameId}`));
      if (secondGameId) await redis()?.del(redisKey(`single:game:${secondGameId}`));
    }
  });
});
