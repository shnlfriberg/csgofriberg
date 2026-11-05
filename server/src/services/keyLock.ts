import { randomUUID } from 'crypto';
import { config } from '../config';
import { evalCommandScript, redis, redisKey } from '../redis';

const localLocks = new Map<string, Promise<void>>();

export async function withKeyLock<T>(key: string, handler: () => Promise<T>): Promise<T> {
  const client = redis();
  if (!client && config.redisRequired) throw new Error('REDIS_UNAVAILABLE');
  if (client) {
    const lockKey = redisKey(`lock:${key}`);
    const token = randomUUID();
    for (let attempt = 0; attempt < 8; attempt++) {
      if (await client.set(lockKey, token, { NX: true, PX: 15_000 })) {
        let leaseLost = false;
        let renewing: Promise<unknown> = Promise.resolve();
        const heartbeat = setInterval(() => {
          renewing = renewing.then(async () => {
            const renewed = await evalCommandScript('key-lock-renew-v1',
              'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
              [lockKey], [token, '15000']);
            if (Number(renewed) !== 1) leaseLost = true;
          }).catch(() => { leaseLost = true; });
        }, 5000);
        heartbeat.unref();
        try {
          const result = await handler();
          await renewing;
          if (leaseLost) throw new Error('RESOURCE_LOCK_LOST');
          return result;
        } finally {
          clearInterval(heartbeat);
          await renewing;
          await evalCommandScript(
            'key-lock-release-v1',
            'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
            [lockKey],
            [token]
          ).catch(error => console.error('[lock:release]', error));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 8 + Math.floor(Math.random() * 8)));
    }
    throw new Error('RESOURCE_BUSY');
  }

  const previous = localLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  localLocks.set(key, queued);
  await previous;
  try {
    return await handler();
  } finally {
    release();
    if (localLocks.get(key) === queued) localLocks.delete(key);
  }
}
