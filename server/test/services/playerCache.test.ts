import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initRedis, redis, redisKey } from '../../src/redis';
import { db } from '../../src/db/knex';
import { ensureSchema } from '../../src/db/schema';
import {
  getPublicPlayerList,
  isDifficultyAvailable,
  invalidatePlayerCache,
  pickCachedTarget,
  refreshPlayerCache,
} from '../../src/services/playerCache';

beforeAll(async () => {
  await ensureSchema();
  await initRedis();
});

afterAll(async () => {
  await db('players').whereLike('nickname', 'cache-test-%').del();
});

describe('player cache invalidation', () => {
  it('removes a disabled player before invalidation returns and changes the list version', async () => {
    const nickname = `cache-test-${Date.now()}`;
    const [row] = await db('players').insert({
      nickname,
      nationality: '测试',
      region: '测试',
      team: '测试',
      age: 26,
      role: 'Rifler',
      major_championships: 0,
      major_appearances: 0,
      is_active: true,
      is_enabled: true,
    }).returning('id');
    const id = typeof row === 'object' ? row.id : row;

    await refreshPlayerCache();
    const before = await getPublicPlayerList();
    expect(before.players).toContainEqual({ id, nickname });

    await db('players').where({ id }).update({ is_enabled: false });
    await invalidatePlayerCache();

    const after = await getPublicPlayerList();
    expect(after.version).not.toBe(before.version);
    expect(after.players).not.toContainEqual({ id, nickname });
  });

  it('refreshes a stale instance before serving the public list', async () => {
    const nickname = `cache-test-cross-instance-${Date.now()}`;
    const [row] = await db('players').insert({
      nickname,
      nationality: '测试',
      region: '测试',
      team: '测试',
      age: 26,
      role: 'Rifler',
      major_championships: 0,
      major_appearances: 0,
      is_active: true,
      is_enabled: true,
    }).returning('id');
    const id = typeof row === 'object' ? row.id : row;

    await refreshPlayerCache();
    expect((await getPublicPlayerList()).players).toContainEqual({ id, nickname });

    await db('players').where({ id }).update({ is_enabled: false });
    await redis()!.incr(redisKey('players:revision'));

    expect((await getPublicPlayerList()).players).not.toContainEqual({ id, nickname });
  });

  it('serves targets from the beginner difficulty pool', async () => {
    const nickname = `cache-test-beginner-${Date.now()}`;
    const [row] = await db('players').insert({
      nickname,
      nationality: '测试',
      region: '测试',
      team: '测试',
      age: 26,
      role: 'Rifler',
      major_championships: 1,
      major_appearances: 1,
      is_active: true,
      is_enabled: true,
    }).returning('id');
    const id = typeof row === 'object' ? row.id : row;
    await db('player_difficulties').insert({ player_id: id, difficulty_key: 'beginner' });

    await refreshPlayerCache();

    expect(isDifficultyAvailable('beginner')).toBe(true);
    expect(pickCachedTarget('beginner')?.difficulties).toContain('beginner');
  });
});
