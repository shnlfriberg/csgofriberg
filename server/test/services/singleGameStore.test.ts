import { describe, expect, it } from 'vitest';
import {
  createOrResumeSingleGameWithStatus,
  deleteSingleGame,
  loadSingleGame,
  saveSingleGame,
} from '../../src/services/singleGameStore';
import { initRedis, redis, redisKey } from '../../src/redis';

type CreateInput = Parameters<typeof createOrResumeSingleGameWithStatus>[0];

async function createGame(input: CreateInput) {
  return (await createOrResumeSingleGameWithStatus(input)).game;
}

describe('singleGameStore', () => {
  it('requires Redis instead of silently writing active games to the database', async () => {
    await expect(createGame({
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
    const created = await createGame({
      identityKey,
      userId: null,
      guestKey: identityKey.slice(2),
      mode: 'easy',
      targetPlayerId: 1,
    });
    created.guesses.push({ playerId: 2, nickname: 'test' } as any);
    await saveSingleGame(created);
    expect(await redis()!.zScore(redisKey('presence:single'), created.id)).not.toBeNull();

    const restored = await createGame({
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

  it('removes expired games once last activity is older than thirty minutes', async () => {
    await initRedis();
    const identityKey = `g:single-stale-${Date.now()}`;
    const created = await createGame({
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
});
