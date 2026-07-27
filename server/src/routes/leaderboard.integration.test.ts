import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import leaderboardRoutes from './leaderboard';
import { errorHandler } from '../middleware/common';
import { db } from '../db/knex';
import { initDb } from '../db/init';
import { initRedis } from '../redis';
import { initPlayerCache } from '../services/playerCache';
import { invalidateCached } from '../services/queryCache';
import { signToken, userNameFromUsername } from '../middleware/auth';
import { config } from '../config';

let server: http.Server;
let baseUrl: string;

describe('leaderboard', () => {
  beforeAll(async () => {
    await initDb();
    await initRedis();
    await initPlayerCache();
    const app = express();
    app.use('/api/leaderboard', leaderboardRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns at most 50 users with anonymous display IDs', async () => {
    const stamp = Date.now();
    const users = Array.from({ length: 51 }, (_, index) => ({
      username: `leaderboard-${stamp}-${index}`,
      password_hash: 'not-used',
      role: 'user',
      token_version: 0,
    }));
    const inserted = await db('users').insert(users).returning(['id', 'username']);
    const userIds = inserted.map((row: any) => Number(row.id));
    const [target] = await db('players').select('id').limit(1);
    await db('games').insert(inserted.map((row: any, index: number) => ({
      session_id: `leaderboard-${stamp}-${index}`,
      user_id: Number(row.id),
      target_player_id: Number(target.id),
      mode: 'easy',
      guesses: '[]',
      status: 'won',
      guess_count: 1,
      finished_at: db.fn.now(),
    })));
    await db('games').insert([
      {
        session_id: `leaderboard-${stamp}-beginner-win`,
        user_id: userIds[0],
        target_player_id: Number(target.id),
        mode: 'beginner',
        guesses: '[]',
        status: 'won',
        guess_count: 1,
        finished_at: db.fn.now(),
      },
      {
        session_id: `leaderboard-${stamp}-easy-extra`,
        user_id: userIds[0],
        target_player_id: Number(target.id),
        mode: 'easy',
        guesses: '[]',
        status: 'won',
        guess_count: 1,
        finished_at: db.fn.now(),
      },
      {
        session_id: `leaderboard-${stamp}-normal-a-win`,
        user_id: userIds[0],
        target_player_id: Number(target.id),
        mode: 'normal',
        guesses: '[]',
        status: 'won',
        guess_count: 2,
        finished_at: db.fn.now(),
      },
      {
        session_id: `leaderboard-${stamp}-normal-a-loss`,
        user_id: userIds[0],
        target_player_id: Number(target.id),
        mode: 'normal',
        guesses: '[]',
        status: 'lost',
        guess_count: 8,
        finished_at: db.fn.now(),
      },
      {
        session_id: `leaderboard-${stamp}-normal-b-win`,
        user_id: userIds[1],
        target_player_id: Number(target.id),
        mode: 'normal',
        guesses: '[]',
        status: 'won',
        guess_count: 3,
        finished_at: db.fn.now(),
      },
      {
        session_id: `leaderboard-${stamp}-normal-a-second-win`,
        user_id: userIds[0],
        target_player_id: Number(target.id),
        mode: 'normal',
        guesses: '[]',
        status: 'won',
        guess_count: 4,
        finished_at: db.fn.now(),
      },
    ]);
    const matchRows = await db('match_records')
      .insert([0, 1, 2, 3].map((index) => ({
        room_id: `leaderboard-${stamp}-${index}`,
        db_type: 'easy',
        bo_type: 1,
        replay: '[]',
      })))
      .returning('id');
    const matchIds = matchRows.map((row: any) => Number(typeof row === 'object' ? row.id : row));
    await db('match_players').insert([
      { match_id: matchIds[0], user_id: userIds[0], player_key: `u:${userIds[0]}`, player_name: '', score: 1, is_winner: true },
      { match_id: matchIds[0], player_key: `g:leaderboard-${stamp}-0`, player_name: '', score: 0, is_winner: false },
      { match_id: matchIds[1], user_id: userIds[0], player_key: `u:${userIds[0]}`, player_name: '', score: 0, is_winner: false },
      { match_id: matchIds[1], player_key: `g:leaderboard-${stamp}-1`, player_name: '', score: 1, is_winner: true },
      { match_id: matchIds[2], user_id: userIds[1], player_key: `u:${userIds[1]}`, player_name: '', score: 1, is_winner: true },
      { match_id: matchIds[2], player_key: `g:leaderboard-${stamp}-2`, player_name: '', score: 0, is_winner: false },
      { match_id: matchIds[3], user_id: userIds[0], player_key: `u:${userIds[0]}`, player_name: '', score: 1, is_winner: true },
      { match_id: matchIds[3], player_key: `g:leaderboard-${stamp}-3`, player_name: '', score: 0, is_winner: false },
    ]);
    await invalidateCached('leaderboard:beginner', 'leaderboard:easy', 'leaderboard:normal', 'leaderboard:multi');

    try {
      const beginnerResponse = await fetch(`${baseUrl}/api/leaderboard?type=beginner`);
      const beginnerData = await beginnerResponse.json();
      expect(beginnerResponse.status).toBe(200);
      expect(beginnerData.type).toBe('beginner');
      expect(beginnerData.items[0]).toMatchObject({ id: userIds[0], wins: 1, total: 1 });

      const response = await fetch(`${baseUrl}/api/leaderboard?type=easy`);
      const data = await response.json();
      expect(response.status).toBe(200);
      expect(data.type).toBe('easy');
      expect(data.items).toHaveLength(50);
      expect(data.items[0]).toMatchObject({ id: userIds[0], wins: 2, total: 2, winRate: 1 });
      expect(data.items.every((row: any) => /^用户#[0-9A-Z]{5}$/.test(row.displayId))).toBe(true);
      expect(data.items.every((row: any) => !Object.hasOwn(row, 'username'))).toBe(true);
      expect(data.currentUser).toBeNull();

      const normalResponse = await fetch(`${baseUrl}/api/leaderboard?type=normal`);
      const normalData = await normalResponse.json();
      expect(normalResponse.status).toBe(200);
      expect(normalData.type).toBe('normal');
      expect(normalData.items[0]).toMatchObject({ id: userIds[0], wins: 2, total: 3, winRate: 2 / 3 });
      expect(normalData.items.find((row: any) => row.id === userIds[0])).toMatchObject({
        wins: 2,
        total: 3,
        winRate: 2 / 3,
      });

      const multiResponse = await fetch(`${baseUrl}/api/leaderboard?type=multi`);
      const multiData = await multiResponse.json();
      expect(multiResponse.status).toBe(200);
      expect(multiData.type).toBe('multi');
      const multiUserRows = multiData.items.filter((row: any) => userIds.includes(row.id));
      expect(multiUserRows).toHaveLength(2);
      expect(multiData.items.findIndex((row: any) => row.id === userIds[0]))
        .toBeLessThan(multiData.items.findIndex((row: any) => row.id === userIds[1]));
      expect(multiData.items.find((row: any) => row.id === userIds[1])).toMatchObject({
        wins: 1,
        total: 1,
        winRate: 1,
      });
      expect(multiData.items.find((row: any) => row.id === userIds[0])).toMatchObject({
        wins: 2,
        total: 3,
        winRate: 2 / 3,
        avgGuesses: null,
      });

      const token = signToken({ id: userIds[0], token_version: 0 });
      const ownResponse = await fetch(`${baseUrl}/api/leaderboard?type=normal`, {
        headers: { Cookie: `csgofriberg_session=${token}` },
      });
      const ownData = await ownResponse.json();
      expect(ownResponse.status).toBe(200);
      expect(ownData.currentUser).toEqual({
        displayId: userNameFromUsername(users[0].username),
        rank: expect.any(Number),
      });

      await db('users').where({ id: userIds[0] }).update({ leaderboard_hidden: true });
      await invalidateCached('leaderboard:beginner', 'leaderboard:easy', 'leaderboard:normal', 'leaderboard:multi');
      for (const hiddenType of ['beginner', 'easy', 'normal', 'multi']) {
        const hiddenResponse = await fetch(`${baseUrl}/api/leaderboard?type=${hiddenType}`, {
          headers: { Cookie: `csgofriberg_session=${token}` },
        });
        const hiddenData = await hiddenResponse.json();
        expect(hiddenResponse.status).toBe(200);
        expect(hiddenData.items.some((row: any) => row.id === userIds[0])).toBe(false);
        expect(hiddenData.currentUser).toEqual({
          displayId: userNameFromUsername(users[0].username),
          rank: null,
        });
      }

      const invalidResponse = await fetch(`${baseUrl}/api/leaderboard?type=unknown`);
      expect(invalidResponse.status).toBe(400);
    } finally {
      await db('match_records').whereIn('id', matchIds).del();
      await db('games').whereIn('user_id', userIds).del();
      await db('users').whereIn('id', userIds).del();
      await invalidateCached('leaderboard:beginner', 'leaderboard:easy', 'leaderboard:normal', 'leaderboard:multi');
    }
  });
});
