import { beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as redisModule from '../../src/redis';
import { cached, CACHE_GENERATION_TTL_SECONDS, invalidateCached } from '../../src/services/queryCache';
import { config } from '../../src/config';
import { consumeRateLimit, reserveRateLimit, rateLimit } from '../../src/middleware/rateLimit';

beforeAll(async () => { await redisModule.initRedis(); });

describe('cache expiry cannot revive old loaders', () => {
  it('fences old loads even when invalidation expires and another load starts', async () => {
    const key = `expiry-${randomUUID()}`, full = redisModule.redisKey(`cache:${key}`);
    let release!: (value: string) => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const old = cached(key, 60, () => { began(); return new Promise<string>(resolve => { release = resolve; }); });
    await started; await invalidateCached(key);
    const client = redisModule.redis()!;
    expect(await client.ttl(`${full}:generation`)).toBeGreaterThan(0);
    expect(await client.ttl(`${full}:generation`)).toBeLessThanOrEqual(CACHE_GENERATION_TTL_SECONDS);
    await client.del(`${full}:generation`); // Simulate expiry, not an invalidation with a live tombstone.
    expect(await cached(key, 60, async () => 'new')).toBe('new');
    release('old'); expect(await old).toBe('old');
    expect(await cached(key, 60, async () => 'incorrect')).toBe('new');
    await client.del([full, `${full}:generation`]);
  });
  it('gives legacy permanent generation keys a lifetime on access', async () => {
    const key = `legacy-${randomUUID()}`, full = redisModule.redisKey(`cache:${key}`), client = redisModule.redis()!;
    await client.set(`${full}:generation`, 'legacy');
    await cached(key, 1, async () => 1);
    expect(await client.ttl(`${full}:generation`)).toBeGreaterThan(0);
    await client.del([full, `${full}:generation`]);
  });
});

describe('required Redis limiter outage', () => {
  it('rejects consume, reserve and sensitive middleware when redis() is null', async () => {
    const previous = config.redisRequired; config.redisRequired = true;
    const spy = vi.spyOn(redisModule, 'redis').mockReturnValue(null);
    try {
      await expect(consumeRateLimit('test', 'u:1', 5, 60)).rejects.toThrow('REDIS_UNAVAILABLE');
      await expect(reserveRateLimit('test', 'u:1', 5, 60)).rejects.toThrow('REDIS_UNAVAILABLE');
      const next = vi.fn(), res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await rateLimit({ name: 'test', limit: 5, windowSeconds: 60, failClosed: true })({ ip: 'test' } as any, res, next);
      expect(next).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(503);
    } finally { config.redisRequired = previous; spy.mockRestore(); }
  });
});
