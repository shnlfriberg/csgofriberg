import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { config } from '../../src/config';
import { db } from '../../src/db/knex';
import { ensureSchema } from '../../src/db/schema';
import { initRedis, redis, redisKey } from '../../src/redis';
import { getPresenceStats, ONLINE_STALE_MS } from '../../src/services/presence';
import { invalidateCached } from '../../src/services/queryCache';
import { saveGame } from '../../src/location/store';
import type { GameState } from '../../src/location/types';
import { createOrResumeSingleGameWithStatus, deleteSingleGame, saveSingleGame } from '../../src/services/singleGameStore';
import { singlePresenceCategories, singlePresenceKey } from '../../src/services/singleGamePresence';

const oldPrefix = config.redisPrefix;
const ids: string[] = [];
beforeAll(async () => {
  if (!process.env.DB_URL?.includes('verification')) throw Error('ISOLATED_DB_REQUIRED');
  config.redisPrefix = `${oldPrefix}presence-${randomUUID()}:`;
  await ensureSchema();
  await initRedis();
});
afterAll(async () => {
  await db('card_matches').whereIn('id', ids).delete();
  const client = redis();
  if (client) for await (const keys of client.scanIterator({ MATCH: redisKey('*'), COUNT: 100 }))
    if (keys.length) await client.del(keys);
  config.redisPrefix = oldPrefix;
  await db.destroy();
});
const fresh = async () => { await invalidateCached('presence:modes:v1'); return getPresenceStats(); };

describe('admin presence by mode', () => {
  it('maintains tiny projections with game TTL and deletes them on finish', async () => {
    const client = redis()!;
    const { game } = await createOrResumeSingleGameWithStatus({ identityKey: 'g:projection', userId: null, guestKey: 'projection', mode: 'normal', targetPlayerId: 1 });
    expect(await client.get(singlePresenceKey(game.id))).toBe('classicSingle');
    expect(await client.pTTL(singlePresenceKey(game.id))).toBeGreaterThan(0);
    await client.del(singlePresenceKey(game.id));
    await client.pExpire(redisKey(`single:game:${game.id}`), 9000);
    expect(await singlePresenceCategories([game.id])).toEqual(['classicSingle']);
    const ttl = await client.pTTL(singlePresenceKey(game.id));
    expect(ttl).toBeGreaterThan(0); expect(ttl).toBeLessThanOrEqual(9000);
    game.kind = 'daily'; await saveSingleGame(game);
    expect(await singlePresenceCategories([game.id])).toEqual(['classicDaily']);
    await deleteSingleGame(game);
    expect(await client.get(singlePresenceKey(game.id))).toBeNull();
    expect(await singlePresenceCategories([game.id])).toEqual(['inactive']);
  });

  it('ignores corrupt legacy states and finished soup awaiting settlement without breaking the dashboard', async () => {
    const client = redis()!, now = Date.now();
    const baseline = (await fresh()).modes;
    for (const [id, raw] of [['bad', '{broken'], ['null', 'null'], ['ended', JSON.stringify({ variant: 'turtle-soup', soup: { status: 'won' } })]]) {
      await client.set(redisKey(`single:game:${id}`), raw, { EX: 60 });
      await client.zAdd(redisKey('presence:single'), { value: id, score: now + 60_000 });
    }
    await client.set(redisKey('room:broken-legacy'), '{broken', { EX: 60 });
    await client.zAdd(redisKey('presence:rooms'), { value: 'broken-legacy', score: now + 60_000 });
    expect((await fresh()).modes).toEqual(baseline);
    expect(await client.get(redisKey('single:game:bad'))).toBe('{broken');
  });

  it('counts distinct identities and classifies classic modes, excluding expired, finished and missing records', async () => {
    const client = redis()!;
    const now = Date.now();
    await client.zAdd(redisKey('presence:online'), [
      { value: 'u:1', score: now }, { value: 'g:1', score: now },
      { value: 'stale', score: now - ONLINE_STALE_MS - 1000 },
    ]);
    for (const [id, game] of Object.entries({ solo: {}, daily: { kind: 'daily' }, soup: { variant: 'turtle-soup' }, expired: {} })) {
      await client.set(redisKey(`single:game:${id}`), JSON.stringify(game), { EX: 60 });
      await client.zAdd(redisKey('presence:single'), { value: id, score: id === 'expired' ? now - 1 : now + 60_000 });
    }
    await client.zAdd(redisKey('presence:single'), { value: 'missing', score: now + 60_000 });
    for (const [id, gameMode, status] of [
      ['classic', 'classic', 'waiting'], ['relay', 'relay', 'playing'], ['2v2', 'relay2v2', 'round_over'], ['done', 'classic', 'finished'],
    ]) {
      await client.hSet(redisKey(`room:${id}:meta`), { gameMode, status });
      await client.zAdd(redisKey('presence:rooms'), { value: id, score: now + 60_000 });
    }
    const stats = await fresh();
    expect(stats.onlineUsers).toBe(2);
    expect(stats.modes).toMatchObject({ classicSingle: 1, classicDaily: 1, turtleSoup: 1, classicRooms: 1, relayRooms: 1, relay2v2Rooms: 1 });
    // Same total, different categories: the returned snapshot must reflect it.
    await client.hSet(redisKey('room:classic:meta'), 'gameMode', 'relay');
    expect((await fresh()).modes).toMatchObject({ classicRooms: 0, relayRooms: 2 });
  });

  it('backfills retained location games once and follows atomic save/finish and expiry', async () => {
    const client = redis()!;
    const now = Date.now();
    await client.del(redisKey('presence:location:index-v1'));
    await client.set(redisKey('location:game:invalid-expiry'), JSON.stringify({ id: 'invalid-expiry', mode: 'daily', status: 'playing', expiresAt: 'invalid' }), { EX: 60 });
    for (const [id, mode, status, expiresAt] of [
      ['legacy-daily', 'daily', 'ready', now + 60_000],
      ['legacy-random', 'random', 'playing', now + 60_000],
      ['legacy-done', 'random', 'finished', now + 60_000],
      ['legacy-expired', 'daily', 'playing', now - 1],
    ] as const) await client.set(redisKey(`location:game:${id}`), JSON.stringify({ id, mode, status, expiresAt }), { EX: 60 });
    await client.set(redisKey('location:room:active'), '{}', { EX: 60 });
    await client.zAdd(redisKey('location:rooms'), [{ value: 'active', score: now - 5000 }, { value: 'missing', score: now + 60_000 }]);
    expect((await fresh()).modes).toMatchObject({ locationDaily: 1, locationRandom: 1, locationRooms: 1 });
    const game = { id: 'new-random', mode: 'random', status: 'ready', expiresAt: now + 60_000, owner: { key: 'g:test' }, difficulty: 'easy' } as GameState;
    await saveGame(game);
    expect((await fresh()).modes.locationRandom).toBe(2);
    await saveGame({ ...game, status: 'finished' });
    expect((await fresh()).modes.locationRandom).toBe(1);
    await client.zAdd(redisKey('presence:location:random'), { value: 'legacy-random', score: now - 1 });
    expect((await fresh()).modes.locationRandom).toBe(0);
  });

  it('counts card scenes without loading payloads and excludes terminal matches', async () => {
    const baseline = (await fresh()).modes;
    for (const [scene, status] of [
      ['practice', 'playing'], ['daily', 'playing'], ['friend', 'waiting'], ['ranked', 'preparing'],
      ['friend', 'roundOver'], ['practice', 'finished'], ['daily', 'cancelled'],
    ]) {
      const id = randomUUID(); ids.push(id);
      await db('card_matches').insert({ id, scene, status, variant: 'infinite', revision: 0, due_at: null, payload: 'not needed for counts' });
    }
    const modes = (await fresh()).modes;
    expect(modes.cardSingle - baseline.cardSingle).toBe(1);
    expect(modes.cardDaily - baseline.cardDaily).toBe(1);
    expect(modes.cardFriend - baseline.cardFriend).toBe(2);
    expect(modes.cardRanked - baseline.cardRanked).toBe(1);
  });
});
