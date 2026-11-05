import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as redisModule from '../../src/redis';
import { cached, invalidateCached } from '../../src/services/queryCache';

describe('cache invalidation during loading', () => {
  it.each(['local', 'redis'])('%s never republishes an invalidated load or joins it after invalidation', async mode => {
    await redisModule.initRedis();
    const spy = mode === 'local' ? vi.spyOn(redisModule, 'redis').mockReturnValue(null) : null;
    try {
      const key = `race-${randomUUID()}`;
      let release!: (value: string) => void; let started!: () => void;
      const began = new Promise<void>(resolve => { started = resolve; });
      const old = cached(key, 60, () => { started(); return new Promise<string>(resolve => { release = resolve; }); });
      await began;
      await invalidateCached(key);
      expect(await cached(key, 60, async () => 'fresh')).toBe('fresh');
      release('stale'); expect(await old).toBe('stale');
      expect(await cached(key, 60, async () => 'wrong')).toBe('fresh');
    } finally { spy?.mockRestore(); }
  });
});
