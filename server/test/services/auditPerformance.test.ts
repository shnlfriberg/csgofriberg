import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema } from '../../src/db/schema';
import { db } from '../../src/db/knex';
import { initRedis, redis, redisKey } from '../../src/redis';
import { invalidateCached } from '../../src/services/queryCache';
import { locationStatistics } from '../../src/location/statistics';
import { cardReplays } from '../../src/card-link/stats';
import { seatId } from '../../src/card-link/views';

beforeAll(async () => { await ensureSchema(); await initRedis(); });

describe('bounded statistics and replay listing work', () => {
  it('keeps personal statistics current without rescanning global history for each revision', async () => {
    const owner = `g:stats-budget-${randomUUID()}`, ids = [randomUUID(), randomUUID()];
    const key = 'location:stats:global:v2:easy,hard,normal';
    const insert = (id: string) => db('location_results').insert({ game_id: id, identity_key: owner,
      mode: 'random', difficulty: 'normal', score: 1000, finished_at: Date.now(), payload: '{}' });
    let scans = 0;
    const query = ({ sql }: { sql: string }) => {
      if (sql.includes('from `location_results`') && sql.includes('group by') && !sql.includes('`identity_key` =')) scans++;
    };
    try {
      await insert(ids[0]); await invalidateCached(key);
      const before = await locationStatistics(owner, ['easy', 'normal', 'hard']);
      db.on('query', query); await insert(ids[1]);
      const after = await locationStatistics(owner, ['easy', 'normal', 'hard']);
      expect(after.personal.singleGames).toBe(before.personal.singleGames + 1);
      expect(after.global).toEqual(before.global); expect(scans).toBe(0);
      const ttl = await redis()!.ttl(redisKey(`cache:${key}`));
      expect(ttl).toBeGreaterThan(0); expect(ttl).toBeLessThanOrEqual(10);
      await invalidateCached(key);
      expect((await locationStatistics(owner, ['easy', 'normal', 'hard'])).global.singleGames).toBe(before.global.singleGames + 1);
      expect(scans).toBe(1);
    } finally { db.off('query', query); await db('location_results').whereIn('game_id', ids).delete(); await invalidateCached(key); }
  });
  it('lists projected results without loading replay blobs and still reads legacy rows', async () => {
    const id = randomUUID(), owner = { key: `g:replay-budget-${randomUUID()}`, userId: null, name: 'Synthetic' };
    const summary = { dailyPractice: false, rounds: 1, retired: false, rank: 1 };
    const replay = { storageVersion: 1, match: { id, variant: 'unlimited', scene: 'friend', day: null, rulesVersion: 1,
      graphVersion: 'a'.repeat(64), questions: [{ start: 1, end: 2 }] }, players: [
      { id: seatId(owner.key), name: 'Synthetic', retired: false, results: [{ path: [1, 2], elapsed: 20 }] },
      { id: seatId('g:other'), name: 'Other', retired: false, results: [{ path: [1, 3, 2], elapsed: 10 }] },
    ] };
    await db('card_results').insert({ match_id: id, created_at: 1, payload: 'must-not-read-this-blob' });
    await db('card_participants').insert({ match_id: id, identity_key: owner.key, variant: 'unlimited', scene: 'friend',
      solved: 1, hops: 1, elapsed: 20, replay_summary: JSON.stringify(summary) });
    const queries: string[] = [], query = ({ sql }: { sql: string }) => { queries.push(sql); };
    db.on('query', query);
    try {
      const options = { variant: 'unlimited' as const, scene: 'all' as const, page: 1 };
      const projected = await cardReplays(owner, options);
      expect(projected.items[0]).toMatchObject(summary);
      expect(queries.some(sql => sql.includes('`payload`'))).toBe(false);
      await db('card_results').where({ match_id: id }).update({ payload: JSON.stringify(replay) });
      await db('card_participants').where({ match_id: id }).update({ replay_summary: null });
      expect(await cardReplays(owner, options)).toEqual(projected);
    } finally {
      db.off('query', query); await db('card_participants').where({ match_id: id }).delete(); await db('card_results').where({ match_id: id }).delete();
    }
  });
});
