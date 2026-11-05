import express from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config';
import { db } from '../../src/db/knex';
import { initDb } from '../../src/db/init';
import { initRedis } from '../../src/redis';
import { errorHandler } from '../../src/middleware/common';
import locationRoutes from '../../src/location/routes';
import { testMap } from './fixtures';
import type { Difficulty, Mode, RoundResult } from '../../src/location/types';

describe('location statistics and personal replays', () => {
  const tag = `location-statistics-${randomUUID()}`;
  const owner = `g:${tag}`;
  const other = `g:${tag}-other`;
  let server: ReturnType<express.Express['listen']>;
  let base: string;
  const entries: Array<{ game: string; who: string; mode: Mode; difficulty: Difficulty; score: number; rank?: number; retired?: boolean }> = [
    { game: 'random-easy', who: owner, mode: 'random', difficulty: 'easy', score: 10000 },
    { game: 'random-hard', who: owner, mode: 'random', difficulty: 'hard', score: 20000 },
    { game: 'daily', who: owner, mode: 'daily', difficulty: 'normal', score: 15000 },
    { game: 'multiplayer', who: owner, mode: 'multiplayer', difficulty: 'normal', score: 24000, rank: 1 },
    { game: 'multiplayer', who: other, mode: 'multiplayer', difficulty: 'normal', score: 12000, rank: 2 },
    { game: 'retired', who: owner, mode: 'multiplayer', difficulty: 'hard', score: 0, rank: 1, retired: true },
  ];
  const round: RoundResult = {
    round: 1, imageUrl: '/location-assets/test-snapshot.webp', questionId: 'snapshot', questionVersion: 1,
    tier: 'easy', guess: { mapId: 'test_location', floorId: 'upper', u: .2, v: .3 },
    answer: { mapId: 'test_location', floorId: 'upper', u: .2, v: .3 },
    map: testMap(), guessedMap: testMap(), score: 5000, distanceRatio: 0, mapCorrect: true, floorCorrect: true,
  };
  async function req(route: string, who = owner) {
    const cookie = jwt.sign({ key: who.slice(2), typ: 'guest' }, config.jwtSecret);
    const response = await fetch(base + route, { headers: { Cookie: `csgofriberg_guest=${cookie}` } });
    return { status: response.status, data: await response.json() };
  }
  beforeAll(async () => {
    await initDb(); await initRedis();
    for (const [index, entry] of entries.entries()) {
      await db('location_results').insert({ game_id: `${tag}-${entry.game}`, identity_key: entry.who, user_id: null,
        mode: entry.mode, difficulty: entry.difficulty, score: entry.score, date: null, finished_at: 1000 + index,
        payload: JSON.stringify({ gameId: `${tag}-${entry.game}`, owner: { key: entry.who, name: 'Test', userId: null },
          mode: entry.mode, difficulty: entry.difficulty, totalScore: entry.score, results: [round], scoringVersion: 1,
          rank: entry.rank, retired: entry.retired,
          ...(entry.mode === 'multiplayer' ? { roomResults: [{ key: owner, name: 'Test', rounds: [round] }, { key: other, name: 'Other', rounds: [round] }] } : {}),
        }),
      });
    }
    const app = express(); app.use('/location', locationRoutes); app.use(errorHandler);
    server = app.listen(0); await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/location`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db('location_results').whereIn('identity_key', [owner, other]).delete();
  });
  it('merges selected difficulties, counts multiplayer games once globally and excludes retired winners', async () => {
    const all = await req('/stats');
    expect(all.status).toBe(200);
    expect(all.data.personal).toEqual({ acceptedSubmissions: 0, singleGames: 3, randomGames: 2, dailyGames: 1, averageScore: 15000,
      bestScore: 20000, multiGames: 2, multiEntries: 2, multiWins: 1, multiAverageScore: 12000 });
    expect(all.data.global.multiGames).toBe(2);
    expect(all.data.global.multiEntries).toBe(3);
    expect(all.data.global.multiAverageScore).toBe(12000);
    const easy = await req('/stats?difficulties=easy');
    expect(easy.data.personal).toMatchObject({ singleGames: 1, averageScore: 10000, bestScore: 10000, multiGames: 0 });
    const isolated = await req('/stats?difficulties=easy', other);
    expect(isolated.data.personal.singleGames).toBe(0);
    expect(isolated.data.personal.averageScore).toBeNull();
    expect((await req('/stats?difficulties=invalid')).status).toBe(400);
  });
  it('filters and paginates only the current identity’s single and multiplayer results', async () => {
    const first = await req('/replays?pageSize=2');
    expect(first.data).toMatchObject({ page: 1, pageSize: 2, hasNext: true });
    expect(first.data.items.map((item: { mode: string }) => item.mode)).toEqual(['daily', 'random']);
    const second = await req('/replays?pageSize=2&page=2');
    expect(second.data.hasNext).toBe(false); expect(second.data.items).toHaveLength(1);
    const daily = await req('/replays?mode=daily');
    expect(daily.data.items).toHaveLength(1); expect(daily.data.items[0].mode).toBe('daily');
    const multi = await req('/replays?type=multi&difficulties=normal');
    expect(multi.data.items).toHaveLength(1); expect(multi.data.items[0]).toMatchObject({ rank: 1, retired: false });
    expect((await req('/replays?type=single', other)).data.items).toEqual([]);
    expect((await req('/replays?page=-1')).status).toBe(400);
  });
  it('returns original screenshot and map snapshots in a replay and blocks other identities', async () => {
    const id = `${tag}-random-easy`;
    const own = await req(`/games/${id}/replay`);
    expect(own.data.results[0]).toEqual(round);
    expect((await req(`/games/${id}/replay`, other)).status).toBe(404);
    const multi = await req(`/games/${tag}-multiplayer/replay`);
    expect(multi.data.roomResults).toHaveLength(2);
    expect(multi.data.results[0].imageUrl).toBe(round.imageUrl);
  });
});
