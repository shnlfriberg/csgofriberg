import { config } from '../../config';
import { evalStateScript, redisKey, redisState } from '../../redis';

/**
 * Room kernel state client. Room, schedule and occupancy traffic shares the
 * dedicated state connection with classic rooms so HTTP/rate-limit traffic does
 * not queue behind it. Without Redis the kernel falls back to in-process maps,
 * exactly like the classic room store does in single-instance tests.
 */
export function kernelRedis() {
  const client = redisState();
  if (!client && config.redisRequired) throw new Error('REDIS_UNAVAILABLE');
  return client;
}

export function kernelKey(key: string): string {
  return redisKey(key);
}

export function kernelScript(name: string, script: string, keys: string[], args: string[]): Promise<unknown> {
  return evalStateScript(name, script, keys, args);
}
