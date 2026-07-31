import { describe, expect, it } from 'vitest';
import {
  createOrResumeSingleGame,
  deleteSingleGame,
  loadSingleGame,
  saveSingleGame,
} from './singleGameStore';
import { initRedis, redis, redisKey } from '../redis';

describe('singleGameStore', () => {
  it('requires Redis instead of silently writing active games to the database', async () => {
    await expect(createOrResumeSingleGame({
      identityKey: 'g:test',
      userId: null,
      guestKey: 'test-guest',
      mode: 'easy',
      targetPlayerId: 1,
    })).rejects.toThrow('REDIS_UNAVAILABLE');
    await expect(loadSingleGame('missing', 'g:test')).rejects.toThrow('REDIS_UNAVAILABLE');
    await expect(deleteSingleGame({
      id: 'missing',
      identityKey: 'g:test',
      userId: null,
      guestKey: 'test-guest',
      mode: 'easy',
      targetPlayerId: 1,
      guesses: [],
      guessTimes: [],
      createdAt: 0,
      lastActiveAt: 0,
    })).rejects.toThrow('REDIS_UNAVAILABLE');
  });

  it('restores the same active game and guesses until it is explicitly deleted', async () => {
    await initRedis();
    const identityKey = `g:single-resume-${Date.now()}`;
    const created = await createOrResumeSingleGame({
      identityKey,
      userId: null,
      guestKey: identityKey.slice(2),
      mode: 'easy',
      targetPlayerId: 1,
    });
    created.guesses.push({ playerId: 2, nickname: 'test' } as any);
    await saveSingleGame(created);
    expect(await redis()!.zScore(redisKey('presence:single'), created.id)).not.toBeNull();

    const restored = await createOrResumeSingleGame({
      identityKey,
      userId: null,
      guestKey: identityKey.slice(2),
      mode: 'easy',
      targetPlayerId: 3,
    });
    expect(restored.id).toBe(created.id);
    expect(restored.targetPlayerId).toBe(1);
    expect(restored.guesses).toEqual(created.guesses);
    expect(restored.guessTimes).toEqual([null]);

    await deleteSingleGame(restored);
    expect(await loadSingleGame(restored.id, identityKey)).toBeNull();
    expect(await redis()!.zScore(redisKey('presence:single'), restored.id)).toBeNull();
  });

  it('removes legacy games once last activity is older than thirty minutes', async () => {
    await initRedis();
    const identityKey = `g:single-stale-${Date.now()}`;
    const created = await createOrResumeSingleGame({
      identityKey,
      userId: null,
      guestKey: identityKey.slice(2),
      mode: 'normal',
      targetPlayerId: 1,
    });
    created.lastActiveAt = Date.now() - 1_801_000;
    await redis()!.set(
      redisKey(`single:game:${created.id}`),
      JSON.stringify(created),
      { EX: 1800 }
    );

    expect(await loadSingleGame(created.id, identityKey)).toBeNull();
    expect(await redis()!.get(redisKey(`single:active:${identityKey}:normal`))).toBeNull();
    expect(await redis()!.zScore(redisKey('presence:single'), created.id)).toBeNull();
  });

  it('aligns missing legacy timing data with stored guesses', async () => {
    await initRedis();
    const identityKey = `g:single-legacy-times-${Date.now()}`;
    const created = await createOrResumeSingleGame({
      identityKey,
      userId: null,
      guestKey: identityKey.slice(2),
      mode: 'normal',
      targetPlayerId: 1,
    });
    created.guesses.push({ playerId: 2, nickname: 'test' } as any);
    const key = redisKey(`single:game:${created.id}`);
    await redis()!.set(key, JSON.stringify({ ...created, guessTimes: undefined }), { EX: 1800 });
    try {
      const restored = await loadSingleGame(created.id, identityKey);
      expect(restored?.guessTimes).toEqual([null]);
    } finally {
      const restored = await loadSingleGame(created.id, identityKey);
      if (restored) await deleteSingleGame(restored);
    }
  });
});
