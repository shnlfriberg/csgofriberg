import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import adminRoutes from './admin';
import { config } from '../config';
import { db } from '../db/knex';
import { initDb } from '../db/init';
import { errorHandler } from '../middleware/common';
import { guestNameFromKey, signToken, userNameFromUsername } from '../middleware/auth';
import { initRedis } from '../redis';
import { initPlayerCache } from '../services/playerCache';
import { playerImportSchema } from '../services/playerMutations';

let server: http.Server;
let baseUrl: string;

function authCookie(user: { id: number; token_version: number }): string {
  return `csgofriberg_session=${signToken(user)}`;
}

async function request(
  path: string,
  cookie: string,
  options: { method?: string; body?: unknown } = {}
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: {
      Cookie: cookie,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, data: await response.json() };
}

describe('admin user management', () => {
  beforeAll(async () => {
    await initDb();
    await initRedis();
    await initPlayerCache();
    const app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('lists registered users and returns protected performance details', async () => {
    const stamp = Date.now();
    const adminUsername = `admin-users-admin-${stamp}`;
    const username = `admin-users-target-${stamp}`;
    const displayId = userNameFromUsername(username);
    const sessionPrefix = `admin-users-game-${stamp}`;
    const matchPrefix = `admin-users-match-${stamp}`;
    const opponentKey = `admin-users-opponent-${stamp}`;
    const insertedUsers = await db('users')
      .insert([
        {
          username: adminUsername,
          display_id: userNameFromUsername(adminUsername),
          password_hash: 'test',
          role: 'admin',
          token_version: 0,
        },
        {
          username,
          display_id: displayId,
          password_hash: 'test',
          role: 'user',
          token_version: 0,
        },
      ])
      .returning(['id', 'username', 'token_version']);
    const admin = insertedUsers.find((user) => user.username === adminUsername)!;
    const targetUser = insertedUsers.find((user) => user.username === username)!;
    const [targetPlayer, analysisGuess] = await db('players').select('id').limit(2);
    try {
      await db('games').insert([
        {
          session_id: `${sessionPrefix}-won`,
          user_id: targetUser.id,
          target_player_id: targetPlayer.id,
          mode: 'easy',
          guesses: JSON.stringify([analysisGuess.id, targetPlayer.id]),
          first_guess_player_id: analysisGuess.id,
          status: 'won',
          guess_count: 2,
          finished_at: db.fn.now(),
        },
        {
          session_id: `${sessionPrefix}-lost`,
          user_id: targetUser.id,
          target_player_id: targetPlayer.id,
          mode: 'normal',
          guesses: JSON.stringify([analysisGuess.id, targetPlayer.id]),
          first_guess_player_id: analysisGuess.id,
          status: 'lost',
          guess_count: 6,
          finished_at: db.fn.now(),
        },
      ]);
      for (const [index, won] of [true, false].entries()) {
        const [inserted] = await db('match_records')
          .insert({
            room_id: `${matchPrefix}-${index}`,
            db_type: 'easy',
            bo_type: 3,
            winner_id: won ? targetUser.id : null,
            winner_key: won ? `u:${targetUser.id}` : null,
            finish_reason: 'score',
            replay: JSON.stringify([{
              round: 1,
              targetPlayerId: targetPlayer.id,
              winnerKey: won ? `u:${targetUser.id}` : `g:${opponentKey}`,
              reason: 'guessed',
              guessesByPlayer: {
                [`u:${targetUser.id}`]: [analysisGuess.id, targetPlayer.id],
                [`g:${opponentKey}`]: [targetPlayer.id],
              },
            }]),
          })
          .returning('id');
        const matchId = typeof inserted === 'object' ? inserted.id : inserted;
        await db('match_players').insert([
          {
            match_id: matchId,
            user_id: targetUser.id,
            player_key: `u:${targetUser.id}`,
            player_name: username,
            score: won ? 2 : 1,
            is_winner: won,
          },
          {
            match_id: matchId,
            player_key: `g:${opponentKey}`,
            player_name: guestNameFromKey(opponentKey),
            score: won ? 1 : 2,
            is_winner: !won,
          },
        ]);
      }

      const adminSession = authCookie(admin);
      const list = await request(`/api/admin/users?search=${encodeURIComponent(displayId)}`, adminSession);
      expect(list.response.status).toBe(200);
      expect(list.data.users).toEqual([
        expect.objectContaining({
          id: Number(targetUser.id),
          username,
          displayId,
          role: 'user',
          leaderboardHidden: false,
          createdAt: expect.any(String),
        }),
      ]);

      const hidden = await request(
        `/api/admin/users/${targetUser.id}/leaderboard-visibility`,
        adminSession,
        { method: 'PATCH', body: { hidden: true } }
      );
      expect(hidden.response.status).toBe(200);
      expect(hidden.data).toEqual({ id: Number(targetUser.id), leaderboardHidden: true });
      expect(Boolean((await db('users').where({ id: targetUser.id }).first()).leaderboard_hidden)).toBe(true);

      const leaderboards = await request(`/api/admin/users/${targetUser.id}/leaderboards`, adminSession);
      expect(leaderboards.response.status).toBe(200);
      expect(leaderboards.data).toMatchObject({ leaderboardHidden: true, entries: expect.any(Array) });
      expect(leaderboards.data.entries).toHaveLength(6);
      expect(leaderboards.data.entries.find((entry: { mode: string; difficulty: string }) => entry.mode === 'single' && entry.difficulty === 'easy')).toMatchObject({
        total: 1,
        wins: 1,
        winRate: 1,
        rank: expect.any(Number),
      });
      expect(leaderboards.data.entries.find((entry: { mode: string; difficulty: string }) => entry.mode === 'multi' && entry.difficulty === 'easy')).toMatchObject({
        total: 2,
        wins: 1,
        winRate: 0.5,
        rank: expect.any(Number),
      });

      const analysis = await request(`/api/admin/users/${targetUser.id}/analysis`, adminSession);
      expect(analysis.response.status).toBe(200);
      expect(analysis.data).toMatchObject({
        summary: expect.objectContaining({ sampleSize: 2 }),
        limitations: expect.objectContaining({ hasGuessTiming: false }),
      });
      expect(analysis.data).not.toHaveProperty('trajectories');

      const invalidVisibility = await request(
        `/api/admin/users/${targetUser.id}/leaderboard-visibility`,
        adminSession,
        { method: 'PATCH', body: { hidden: 'yes' } }
      );
      expect(invalidVisibility.response.status).toBe(400);
      expect(invalidVisibility.data).toEqual({ code: 'VALIDATION_FAILED' });

      const stats = await request(`/api/admin/users/${targetUser.id}/stats`, adminSession);
      expect(stats.response.status).toBe(200);
      expect(stats.data).toMatchObject({
        user: { username, displayId },
        stats: {
          single: { games: 2, wins: 1, losses: 1, winRate: 0.5, avgGuesses: 2, bestGuesses: 2 },
          multi: { games: 2, wins: 1, losses: 1, winRate: 0.5 },
        },
      });

      const singleGames = await request(
        `/api/admin/users/${targetUser.id}/games?type=single&page=1&pageSize=10`,
        adminSession
      );
      expect(singleGames.response.status).toBe(200);
      expect(singleGames.data.items).toHaveLength(2);
      expect(singleGames.data.items[0]).toMatchObject({
        type: 'single',
        answer: expect.any(String),
        guessCount: expect.any(Number),
      });

      const multiGames = await request(
        `/api/admin/users/${targetUser.id}/games?type=multi&page=1&pageSize=10`,
        adminSession
      );
      expect(multiGames.response.status).toBe(200);
      expect(multiGames.data.items).toHaveLength(2);
      expect(multiGames.data.items[0]).toMatchObject({
        type: 'multi',
        opponent: { displayId: guestNameFromKey(opponentKey), score: expect.any(Number) },
        me: { score: expect.any(Number) },
      });

      const singleReplay = await request(
        `/api/admin/users/${targetUser.id}/games/${singleGames.data.items[0].id}/replay`,
        adminSession
      );
      expect(singleReplay.response.status).toBe(200);
      expect(singleReplay.data.guesses[0]).toMatchObject({
        playerId: analysisGuess.id,
        nickname: expect.any(String),
      });

      const multiReplay = await request(
        `/api/admin/users/${targetUser.id}/matches/${multiGames.data.items[0].id}/replay`,
        adminSession
      );
      expect(multiReplay.response.status).toBe(200);
      expect(multiReplay.data.rounds[0]).toMatchObject({
        answer: { id: targetPlayer.id },
        me: { guesses: [{ playerId: analysisGuess.id }, { playerId: targetPlayer.id }] },
        opponent: { guesses: [{ playerId: targetPlayer.id }] },
      });

      const forbidden = await request(`/api/admin/users/${targetUser.id}/stats`, authCookie(targetUser));
      expect(forbidden.response.status).toBe(403);
      expect(forbidden.data).toEqual({ code: 'FORBIDDEN' });
      const forbiddenAnalysis = await request(`/api/admin/users/${targetUser.id}/analysis`, authCookie(targetUser));
      expect(forbiddenAnalysis.response.status).toBe(403);
      expect(forbiddenAnalysis.data).toEqual({ code: 'FORBIDDEN' });

      const restored = await request(
        `/api/admin/users/${targetUser.id}/leaderboard-visibility`,
        adminSession,
        { method: 'PATCH', body: { hidden: false } }
      );
      expect(restored.data.leaderboardHidden).toBe(false);
    } finally {
      await db('games').where('session_id', 'like', `${sessionPrefix}%`).del();
      await db('match_records').where('room_id', 'like', `${matchPrefix}%`).del();
      await db('users').whereIn('username', [adminUsername, username]).del();
    }
  });

  it('exports all player fields in the JSON import format for admins only', async () => {
    const stamp = Date.now();
    const adminUsername = `admin-export-admin-${stamp}`;
    const userUsername = `admin-export-user-${stamp}`;
    const nickname = `export-player-${stamp}`;
    const insertedUsers = await db('users')
      .insert([
        {
          username: adminUsername,
          display_id: userNameFromUsername(adminUsername),
          password_hash: 'test',
          role: 'admin',
          token_version: 0,
        },
        {
          username: userUsername,
          display_id: userNameFromUsername(userUsername),
          password_hash: 'test',
          role: 'user',
          token_version: 0,
        },
      ])
      .returning(['id', 'username', 'token_version']);
    const admin = insertedUsers.find((user) => user.username === adminUsername)!;
    const user = insertedUsers.find((item) => item.username === userUsername)!;
    const [insertedPlayer] = await db('players')
      .insert({
        nickname,
        nationality: 'China',
        region: 'Asia',
        team: 'Export Test',
        age: 24,
        role: 'Rifler',
        major_championships: 0,
        major_appearances: 2,
        is_active: false,
        is_enabled: true,
      })
      .returning('id');
    const playerId = Number(typeof insertedPlayer === 'object' ? insertedPlayer.id : insertedPlayer);
    try {
      await db('player_difficulties').insert([
        { player_id: playerId, difficulty_key: 'normal' },
        { player_id: playerId, difficulty_key: 'easy' },
      ]);

      const exported = await request('/api/admin/players/export', authCookie(admin));
      expect(exported.response.status).toBe(200);
      expect(exported.response.headers.get('content-disposition')).toContain('players.json');
      expect(() => playerImportSchema.parse({ players: exported.data })).not.toThrow();
      expect(exported.data.find((player: { nickname: string }) => player.nickname === nickname)).toEqual({
        nickname,
        nationality: 'China',
        region: 'Asia',
        team: 'Export Test',
        age: 24,
        role: 'Rifler',
        major_championships: 0,
        major_appearances: 2,
        difficulties: ['easy', 'normal'],
        is_active: false,
        is_enabled: true,
      });

      const forbidden = await request('/api/admin/players/export', authCookie(user));
      expect(forbidden.response.status).toBe(403);
      expect(forbidden.data).toEqual({ code: 'FORBIDDEN' });
    } finally {
      await db('player_difficulties').where({ player_id: playerId }).del();
      await db('players').where({ id: playerId }).del();
      await db('users').whereIn('username', [adminUsername, userUsername]).del();
    }
  });
});
