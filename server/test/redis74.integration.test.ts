import { beforeAll, describe, expect, it } from 'vitest';
import { initRedis, redis, redisKey } from '../src/redis';

describe('Redis 7.4 primitives', () => {
  beforeAll(async () => {
    await initRedis();
  });

  it('atomically consumes values with GETDEL', async () => {
    const key = redisKey(`test:getdel:${Date.now()}`);
    await redis()!.set(key, 'value', { EX: 10 });
    expect(await redis()!.sendCommand(['GETDEL', key])).toBe('value');
    expect(await redis()!.get(key)).toBeNull();
  });

  it('expires individual rate-limit hash fields with HEXPIRE', async () => {
    const key = redisKey(`test:hexpire:${Date.now()}`);
    await redis()!.hSet(key, 'identity', '1');
    expect(await redis()!.sendCommand([
      'HEXPIRE', key, '10', 'FIELDS', '1', 'identity',
    ])).toEqual([1]);
    const ttl = await redis()!.sendCommand([
      'HTTL', key, 'FIELDS', '1', 'identity',
    ]) as number[];
    expect(Number(ttl[0])).toBeGreaterThan(0);
    await redis()!.del(key);
  });

  it('claims stale stream messages with XAUTOCLAIM', async () => {
    const stream = redisKey(`test:xautoclaim:${Date.now()}`);
    const group = 'test-group';
    await redis()!.sendCommand(['XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM']);
    const id = await redis()!.sendCommand(['XADD', stream, '*', 'payload', 'value']) as string;
    await redis()!.sendCommand([
      'XREADGROUP', 'GROUP', group, 'consumer-a', 'COUNT', '1',
      'STREAMS', stream, '>',
    ]);
    const claimed = await redis()!.sendCommand([
      'XAUTOCLAIM', stream, group, 'consumer-b', '0', '0-0', 'COUNT', '1',
    ]) as any[];
    expect(claimed?.[1]?.[0]?.[0]).toBe(id);
    await redis()!.del(stream);
  });
});
