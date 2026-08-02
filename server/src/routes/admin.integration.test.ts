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
import { isMatchmakingRestricted } from '../services/matchmakingRestriction';
import { recordGuestSeen } from '../services/guestAccounts';

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
              guessTimesByPlayer: {
                [`u:${targetUser.id}`]: [1_200, 4_200],
                [`g:${opponentKey}`]: [3_000],
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
          matchmakingRestricted: false,
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

      const restricted = await request(
        `/api/admin/users/${targetUser.id}/matchmaking-restriction`,
        adminSession,
        { method: 'PATCH', body: { restricted: true } }
      );
      expect(restricted.response.status).toBe(200);
      expect(restricted.data).toEqual({ id: Number(targetUser.id), matchmakingRestricted: true });
      expect(Boolean((await db('users').where({ id: targetUser.id }).first()).matchmaking_restricted)).toBe(true);
      expect(await isMatchmakingRestricted(Number(targetUser.id))).toBe(true);

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

      const invalidRestriction = await request(
        `/api/admin/users/${targetUser.id}/matchmaking-restriction`,
        adminSession,
        { method: 'PATCH', body: { restricted: 'yes' } }
      );
      expect(invalidRestriction.response.status).toBe(400);
      expect(invalidRestriction.data).toEqual({ code: 'VALIDATION_FAILED' });

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
        me: { guesses: [{ playerId: analysisGuess.id }, { playerId: targetPlayer.id }], guessTimes: [1_200, 3_000] },
        opponent: { guesses: [{ playerId: targetPlayer.id }], guessTimes: [3_000] },
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

  it('lists and processes match reports', async () => {
    const stamp = Date.now();
    const adminUsername = `admin-reports-${stamp}`;
    const reporterUsername = `reporter-${stamp}`;
    const reportedGuestKey = `reported-${stamp}`;
    const insertedUsers = await db('users').insert([
      {
        username: adminUsername,
        display_id: userNameFromUsername(adminUsername),
        password_hash: 'test',
        role: 'admin',
        token_version: 0,
      },
      {
        username: reporterUsername,
        display_id: userNameFromUsername(reporterUsername),
        password_hash: 'test',
        role: 'user',
        token_version: 0,
      },
    ]).returning(['id', 'username', 'token_version']);
    const admin = insertedUsers.find((user) => user.username === adminUsername)!;
    const reporter = insertedUsers.find((user) => user.username === reporterUsername)!;
    const roomId = `admin-report-room-${stamp}`;
    const [insertedMatch] = await db('match_records').insert({
      room_id: roomId,
      db_type: 'easy',
      bo_type: 3,
      replay: '[]',
    }).returning('id');
    const matchId = Number(typeof insertedMatch === 'object' ? insertedMatch.id : insertedMatch);
    try {
      await recordGuestSeen(reportedGuestKey, guestNameFromKey(reportedGuestKey));
      await db('match_players').insert([
        {
          match_id: matchId,
          user_id: reporter.id,
          player_key: `u:${reporter.id}`,
          player_name: reporterUsername,
        },
        {
          match_id: matchId,
          player_key: `g:${reportedGuestKey}`,
          player_name: guestNameFromKey(reportedGuestKey),
        },
      ]);
      const [insertedReport] = await db('match_reports').insert({
        match_id: matchId,
        reporter_key: `u:${reporter.id}`,
        reported_key: `g:${reportedGuestKey}`,
        description: 'suspected automation',
      }).returning('id');
      const reportId = Number(typeof insertedReport === 'object' ? insertedReport.id : insertedReport);
      const cookie = authCookie(admin);

      const listed = await request(
        `/api/admin/reports?status=pending&page=1&pageSize=10&search=${encodeURIComponent(reporterUsername)}`,
        cookie
      );
      expect(listed.response.status).toBe(200);
      expect(listed.data).toMatchObject({ total: 1, page: 1, totalPages: 1 });
      expect(listed.data.reports).toEqual([
        expect.objectContaining({
          id: reportId,
          matchId,
          roomId,
          mode: 'easy',
          boType: 3,
          reporter: userNameFromUsername(reporterUsername),
          reported: guestNameFromKey(reportedGuestKey),
          description: 'suspected automation',
          status: 'pending',
        }),
      ]);

      const foundByReported = await request(
        `/api/admin/reports?status=pending&page=1&pageSize=10&search=${encodeURIComponent(reportedGuestKey)}`,
        cookie
      );
      expect(foundByReported.data).toMatchObject({ total: 1 });
      expect(foundByReported.data.reports).toEqual([expect.objectContaining({ id: reportId })]);

      const reportedIdentity = await request(`/api/admin/reports/${reportId}/reported-identity`, cookie);
      expect(reportedIdentity.response.status).toBe(200);
      expect(reportedIdentity.data).toEqual({
        type: 'guest',
        guest: expect.objectContaining({
          displayId: guestNameFromKey(reportedGuestKey),
          banned: false,
          matchmakingRestricted: false,
        }),
      });

      const [reportedUserReport] = await db('match_reports').insert({
        match_id: matchId,
        reporter_key: `g:reporter-${stamp}`,
        reported_key: `u:${reporter.id}`,
        description: 'user identity lookup',
      }).returning('id');
      const reportedUserReportId = Number(typeof reportedUserReport === 'object' ? reportedUserReport.id : reportedUserReport);
      const reportedUserIdentity = await request(`/api/admin/reports/${reportedUserReportId}/reported-identity`, cookie);
      expect(reportedUserIdentity.response.status).toBe(200);
      expect(reportedUserIdentity.data).toEqual({
        type: 'user',
        user: expect.objectContaining({
          id: reporter.id,
          username: reporterUsername,
          displayId: userNameFromUsername(reporterUsername),
        }),
      });

      const updated = await request(`/api/admin/reports/${reportId}`, cookie, {
        method: 'PATCH',
        body: { status: 'resolved', adminNote: 'reviewed' },
      });
      expect(updated.response.status).toBe(200);
      expect(updated.data).toEqual({ ok: true, id: reportId, status: 'resolved', adminNote: 'reviewed' });
      expect(await db('match_reports').where({ id: reportId }).first())
        .toMatchObject({ status: 'resolved', admin_note: 'reviewed', handled_by_user_id: admin.id });

      const invalid = await request(`/api/admin/reports/${reportId}`, cookie, {
        method: 'PATCH',
        body: { status: 'closed', adminNote: '' },
      });
      expect(invalid.response.status).toBe(400);
      expect(invalid.data).toEqual({ code: 'VALIDATION_FAILED' });
    } finally {
      await db('match_records').where({ id: matchId }).del();
      await db('guest_accounts').where({ guest_key: reportedGuestKey }).del();
      await db('users').whereIn('username', [adminUsername, reporterUsername]).del();
    }
  });

  it('batch processes duplicate reports and whitelists reported identities', async () => {
    const stamp = Date.now();
    const adminUsername = `admin-report-batch-${stamp}`;
    const reporterAUsername = `reporter-a-${stamp}`;
    const reporterBUsername = `reporter-b-${stamp}`;
    const reportedGuestKey = `trusted-${stamp}`;
    const insertedUsers = await db('users').insert([
      {
        username: adminUsername,
        display_id: userNameFromUsername(adminUsername),
        password_hash: 'test',
        role: 'admin',
        token_version: 0,
      },
      {
        username: reporterAUsername,
        display_id: userNameFromUsername(reporterAUsername),
        password_hash: 'test',
        role: 'user',
        token_version: 0,
      },
      {
        username: reporterBUsername,
        display_id: userNameFromUsername(reporterBUsername),
        password_hash: 'test',
        role: 'user',
        token_version: 0,
      },
    ]).returning(['id', 'username', 'token_version']);
    const admin = insertedUsers.find((user) => user.username === adminUsername)!;
    const reporterA = insertedUsers.find((user) => user.username === reporterAUsername)!;
    const reporterB = insertedUsers.find((user) => user.username === reporterBUsername)!;
    const reportedKey = `g:${reportedGuestKey}`;
    const roomA = `admin-report-batch-a-${stamp}`;
    const roomB = `admin-report-batch-b-${stamp}`;
    const roomC = `admin-report-batch-c-${stamp}`;
    const matchIds: number[] = [];
    const cookie = authCookie(admin);
    try {
      for (const roomId of [roomA, roomB, roomC]) {
        const [insertedMatch] = await db('match_records').insert({
          room_id: roomId,
          db_type: 'easy',
          bo_type: 3,
          replay: '[]',
        }).returning('id');
        matchIds.push(Number(typeof insertedMatch === 'object' ? insertedMatch.id : insertedMatch));
      }
      await db('match_players').insert([
        { match_id: matchIds[0], user_id: reporterA.id, player_key: `u:${reporterA.id}`, player_name: reporterAUsername },
        { match_id: matchIds[0], player_key: reportedKey, player_name: guestNameFromKey(reportedGuestKey) },
        { match_id: matchIds[1], user_id: reporterB.id, player_key: `u:${reporterB.id}`, player_name: reporterBUsername },
        { match_id: matchIds[1], player_key: reportedKey, player_name: guestNameFromKey(reportedGuestKey) },
        { match_id: matchIds[2], user_id: reporterA.id, player_key: `u:${reporterA.id}`, player_name: reporterAUsername },
        { match_id: matchIds[2], player_key: reportedKey, player_name: guestNameFromKey(reportedGuestKey) },
      ]);
      await db('match_reports').insert([
        { match_id: matchIds[0], reporter_key: `u:${reporterA.id}`, reported_key: reportedKey, description: 'same target 1' },
        { match_id: matchIds[1], reporter_key: `u:${reporterB.id}`, reported_key: reportedKey, description: 'same target 2' },
      ]);

      const listed = await request(
        `/api/admin/reports?status=pending&page=1&pageSize=10&search=${encodeURIComponent(reportedGuestKey)}`,
        cookie
      );
      expect(listed.response.status).toBe(200);
      expect(listed.data).toMatchObject({ total: 2 });
      expect(listed.data.reports[0]).toEqual(expect.objectContaining({
        reportedKey,
        pendingForReported: 2,
        whitelisted: false,
      }));

      const batch = await request('/api/admin/reports/batch', cookie, {
        method: 'PATCH',
        body: { reportedKey, status: 'resolved', adminNote: 'same target reviewed' },
      });
      expect(batch.response.status).toBe(200);
      expect(batch.data).toEqual({
        ok: true,
        reportedKey,
        status: 'resolved',
        adminNote: 'same target reviewed',
        updated: 2,
      });
      const pendingCount = await db('match_reports')
        .where({ reported_key: reportedKey, status: 'pending' })
        .count({ count: 'id' })
        .first();
      expect(Number(pendingCount?.count ?? 0)).toBe(0);

      await db('match_reports').insert({
        match_id: matchIds[2],
        reporter_key: `u:${reporterA.id}`,
        reported_key: reportedKey,
        description: 'trusted target',
      });
      const whitelisted = await request('/api/admin/reports/whitelist', cookie, {
        method: 'POST',
        body: { reportedKey, adminNote: 'trusted identity' },
      });
      expect(whitelisted.response.status).toBe(200);
      expect(whitelisted.data).toEqual({
        ok: true,
        reportedKey,
        displayName: guestNameFromKey(reportedGuestKey),
        dismissed: 1,
      });
      expect(await db('report_whitelist').where({ identity_key: reportedKey }).first())
        .toMatchObject({ display_name: guestNameFromKey(reportedGuestKey), admin_note: 'trusted identity', created_by_user_id: admin.id });
      expect(await db('match_reports').where({ match_id: matchIds[2] }).first('status', 'admin_note', 'handled_by_user_id'))
        .toMatchObject({ status: 'dismissed', admin_note: 'trusted identity', handled_by_user_id: admin.id });

      const dismissed = await request(
        `/api/admin/reports?status=dismissed&page=1&pageSize=10&search=${encodeURIComponent(reportedGuestKey)}`,
        cookie
      );
      expect(dismissed.data.reports).toEqual([
        expect.objectContaining({ reportedKey, whitelisted: true, status: 'dismissed' }),
      ]);

      const removed = await request(
        `/api/admin/reports/whitelist/${encodeURIComponent(reportedKey)}`,
        cookie,
        { method: 'DELETE' }
      );
      expect(removed.response.status).toBe(200);
      expect(removed.data).toEqual({ ok: true, reportedKey, removed: 1 });
      expect(await db('report_whitelist').where({ identity_key: reportedKey }).first()).toBeUndefined();
    } finally {
      await db('report_whitelist').where({ identity_key: reportedKey }).del();
      await db('match_records').whereIn('id', matchIds).del();
      await db('users').whereIn('username', [adminUsername, reporterAUsername, reporterBUsername]).del();
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
