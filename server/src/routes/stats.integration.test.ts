import http from 'http';
import { randomUUID } from 'crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import statsRoutes from './stats';
import { config } from '../config';
import { db } from '../db/knex';
import { initDb } from '../db/init';
import { initRedis } from '../redis';
import { errorHandler } from '../middleware/common';
import { initPlayerCache, getPlayer } from '../services/playerCache';
import { invalidateCached } from '../services/queryCache';
import { guestNameFromKey, userNameFromUsername } from '../middleware/auth';

let server: http.Server;
let baseUrl: string;

function guestCookie(key: string): string {
  const token = jwt.sign({ key, typ: 'guest' }, config.jwtSecret, {
    expiresIn: '1h',
    algorithm: 'HS256',
  });
  return `csgofriberg_guest=${token}`;
}

async function request(path: string, cookie: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });
  return { response, data: await response.json() };
}

describe('stats and replay', () => {
  beforeAll(async () => {
    await initDb();
    await initRedis();
    await initPlayerCache();
    const app = express();
    app.use('/api/stats', statsRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns personal and global stats and protects replay ownership', async () => {
    const stamp = Date.now();
    const ownerKey = `stats-owner-${stamp}`;
    const otherKey = `stats-other-${stamp}`;
    const sessionId = `stats-session-${stamp}`;
    const playerRows = await db('players').select('id').limit(2);
    const target = getPlayer(Number(playerRows[0].id))!;
    const otherPlayer = getPlayer(Number(playerRows[1].id))!;
    const [gameId] = await db('games')
      .insert({
        session_id: sessionId,
        guest_key: ownerKey,
        target_player_id: target.id,
        mode: 'easy',
        guesses: JSON.stringify([target.id]),
        first_guess_player_id: target.id,
        status: 'won',
        guess_count: 1,
        finished_at: db.fn.now(),
      })
      .returning('id')
      .then((rows) => rows.map((item: any) => typeof item === 'object' ? item.id : item));
    await invalidateCached('stats:global');

    const meKey = `g:${ownerKey}`;
    const opponentKey = `g:${otherKey}`;
    const [matchId] = await db('match_records')
      .insert({
        room_id: randomUUID(),
        db_type: 'easy',
        bo_type: 1,
        replay: JSON.stringify([{
          round: 1,
          targetPlayerId: target.id,
          winnerKey: meKey,
          reason: 'guessed',
          guessesByPlayer: {
            [meKey]: [target.id],
            [opponentKey]: [otherPlayer.id],
          },
        }]),
      })
      .returning('id')
      .then((rows) => rows.map((item: any) => typeof item === 'object' ? item.id : item));
    await db('match_players').insert([
      {
        match_id: matchId,
        player_key: meKey,
        player_name: '',
        score: 1,
        is_winner: true,
      },
      {
        match_id: matchId,
        player_key: opponentKey,
        player_name: '',
        score: 0,
        is_winner: false,
      },
    ]);

    try {
      const stats = await request('/api/stats/me', guestCookie(ownerKey));
      expect(stats.response.status).toBe(200);
      expect(stats.data.personal.totalGames).toBe(1);
      expect(stats.data.personal.wins).toBe(1);
      expect(stats.data.personal.multiGames).toBe(1);
      expect(stats.data.personal.multiWins).toBe(1);
      expect(stats.data.personal.firstGuess).toEqual({
        playerId: target.id,
        nickname: target.nickname,
        percentage: 1,
      });
      expect(stats.data.global.totalGames).toBeGreaterThanOrEqual(1);
      expect(stats.data.global.firstGuess).toMatchObject({
        playerId: expect.any(Number),
        nickname: expect.any(String),
        percentage: expect.any(Number),
      });
      expect(stats.data.global.firstGuess.percentage).toBeGreaterThan(0);
      expect(stats.data.global.firstGuess.percentage).toBeLessThanOrEqual(1);
      const singleList = await request('/api/stats/replays?type=single&page=1&pageSize=5', guestCookie(ownerKey));
      expect(singleList.response.status).toBe(200);
      expect(singleList.data.items[0]).toMatchObject({ type: 'single', id: gameId });

      const multiList = await request('/api/stats/replays?type=multi&page=1&pageSize=5', guestCookie(ownerKey));
      expect(multiList.response.status).toBe(200);
      expect(multiList.data.items[0]).toMatchObject({
        type: 'multi',
        id: matchId,
        result: 'won',
        me: { score: 1 },
        opponent: { displayId: guestNameFromKey(otherKey), score: 0 },
      });

      const replay = await request(`/api/stats/games/${gameId}/replay`, guestCookie(ownerKey));
      expect(replay.response.status).toBe(200);
      expect(replay.data.answer.nickname).toBe(target.nickname);
      expect(replay.data.guesses).toHaveLength(1);
      expect(replay.data.guesses[0].correct).toBe(true);

      const multiReplay = await request(`/api/stats/matches/${matchId}/replay`, guestCookie(ownerKey));
      expect(multiReplay.response.status).toBe(200);
      expect(multiReplay.data.rounds).toHaveLength(1);
      expect(multiReplay.data.rounds[0].winner).toBe('me');
      expect(multiReplay.data.rounds[0].me.guesses[0].correct).toBe(true);
      expect(multiReplay.data.rounds[0].opponent.guesses[0].playerId).toBe(otherPlayer.id);
      expect(multiReplay.data.opponent.displayId).toBe(guestNameFromKey(otherKey));

      const opponentStats = await request(
        `/api/stats/matches/${matchId}/opponent-stats`,
        guestCookie(ownerKey)
      );
      expect(opponentStats.response.status).toBe(200);
      expect(opponentStats.data).toEqual({
        displayId: guestNameFromKey(otherKey),
        stats: {
          single: {
            games: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            avgGuesses: null,
            bestGuesses: null,
          },
          multi: {
            games: 1,
            wins: 0,
            losses: 1,
            winRate: 0,
            recentAverageWinningGuesses: null,
            recentMatches: [expect.objectContaining({
              id: matchId,
              result: 'lost',
              score: { me: 0, opponent: 1 },
              boType: 1,
              dbType: 'easy',
              rounds: [expect.objectContaining({
                round: 1,
                winner: 'opponent',
                meGuesses: 1,
                opponentGuesses: 1,
              })],
            })],
          },
        },
      });

      const forbidden = await request(`/api/stats/games/${gameId}/replay`, guestCookie(otherKey));
      expect(forbidden.response.status).toBe(404);
      expect(forbidden.data.code).toBe('GAME_NOT_FOUND');

      const forbiddenMulti = await request(`/api/stats/matches/${matchId}/replay`, guestCookie(`third-${stamp}`));
      expect(forbiddenMulti.response.status).toBe(404);
      expect(forbiddenMulti.data.code).toBe('GAME_NOT_FOUND');

      const forbiddenStats = await request(
        `/api/stats/matches/${matchId}/opponent-stats`,
        guestCookie(`third-${stamp}`)
      );
      expect(forbiddenStats.response.status).toBe(404);
      expect(forbiddenStats.data.code).toBe('GAME_NOT_FOUND');
    } finally {
      await db('games').where({ session_id: sessionId }).del();
      await db('match_records').where({ id: matchId }).del();
      await invalidateCached('stats:global');
    }
  });

  it('counts current and legacy first guesses and excludes invalid player ids', async () => {
    const stamp = Date.now();
    const ownerKey = `first-guess-owner-${stamp}`;
    const players = await db('players').select('id').orderBy('id').limit(2);
    const favorite = getPlayer(Number(players[0].id))!;
    const other = getPlayer(Number(players[1].id))!;
    const games: Array<{ suffix: string; guesses: unknown[]; firstGuessPlayerId: number | null }> = [
      { suffix: 'current', guesses: [favorite.id], firstGuessPlayerId: favorite.id },
      { suffix: 'legacy', guesses: [{ playerId: favorite.id }], firstGuessPlayerId: null },
      { suffix: 'other', guesses: [other.id], firstGuessPlayerId: other.id },
      { suffix: 'invalid', guesses: [99999999], firstGuessPlayerId: 0 },
    ];

    await db('games').insert(games.map((game) => ({
      session_id: `first-guess-${game.suffix}-${stamp}`,
      guest_key: ownerKey,
      target_player_id: favorite.id,
      mode: 'easy',
      guesses: JSON.stringify(game.guesses),
      first_guess_player_id: game.firstGuessPlayerId,
      status: 'won',
      guess_count: 1,
      finished_at: db.fn.now(),
    })));

    try {
      const stats = await request('/api/stats/me', guestCookie(ownerKey));
      expect(stats.response.status).toBe(200);
      expect(stats.data.personal.firstGuess).toEqual({
        playerId: favorite.id,
        nickname: favorite.nickname,
        percentage: 2 / 3,
      });
    } finally {
      await db('games').where({ guest_key: ownerKey }).del();
      await invalidateCached('stats:global');
    }
  });

  it('returns draw for a match where neither player is marked as winner', async () => {
    const stamp = Date.now();
    const ownerKey = `draw-owner-${stamp}`;
    const opponentUsername = `draw-user-${stamp}`;
    const meKey = `g:${ownerKey}`;
    const [opponentUserId] = await db('users')
      .insert({
        username: opponentUsername,
        password_hash: 'not-used',
        role: 'user',
        token_version: 0,
      })
      .returning('id')
      .then((rows) => rows.map((item: any) => typeof item === 'object' ? item.id : item));
    const opponentKey = `u:${opponentUserId}`;
    const [matchId] = await db('match_records')
      .insert({
        room_id: randomUUID(),
        db_type: 'easy',
        bo_type: 3,
        finish_reason: 'disconnect_timeout',
        replay: '[]',
      })
      .returning('id')
      .then((rows) => rows.map((item: any) => typeof item === 'object' ? item.id : item));
    await db('match_players').insert([
      { match_id: matchId, player_key: meKey, player_name: '', score: 0, is_winner: false },
      {
        match_id: matchId,
        user_id: opponentUserId,
        player_key: opponentKey,
        player_name: '',
        score: 0,
        is_winner: false,
      },
    ]);

    try {
      const list = await request('/api/stats/replays?type=multi&page=1&pageSize=20', guestCookie(ownerKey));
      expect(list.response.status).toBe(200);
      expect(list.data.items.find((item: any) => item.id === matchId)).toMatchObject({
        result: 'draw',
        me: { score: 0 },
        opponent: { displayId: userNameFromUsername(opponentUsername), score: 0 },
      });

      const replay = await request(`/api/stats/matches/${matchId}/replay`, guestCookie(ownerKey));
      expect(replay.response.status).toBe(200);
      expect(replay.data.result).toBe('draw');
      expect(replay.data.opponent.displayId).toBe(userNameFromUsername(opponentUsername));
    } finally {
      await db('match_records').where({ id: matchId }).del();
      await db('users').where({ id: opponentUserId }).del();
    }
  });
});
