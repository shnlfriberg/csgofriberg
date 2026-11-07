import { randomUUID } from 'crypto';
import { logTransientError } from '../../services/transientLog';
import { kernelKey, kernelRedis, kernelScript } from './state';

/**
 * Run a periodic job on at most one instance at a time. The lease is not
 * renewed: jobs must finish well within `leaseMs` and be idempotent.
 */
export async function withLease<T>(name: string, leaseMs: number, job: () => Promise<T>): Promise<T | null> {
  const client = kernelRedis();
  if (!client) return job();
  const key = kernelKey(`kernel:lease:${name}`);
  const token = randomUUID();
  const acquired = await client.set(key, token, { NX: true, PX: leaseMs });
  if (!acquired) return null;
  try {
    return await job();
  } finally {
    await kernelScript(
      'kernel-lease-release-v1',
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0',
      [key],
      [token]
    ).catch((err) => logTransientError('[room-kernel:lease]', err));
  }
}

/** A non-overlapping interval worker whose body runs under a shared lease. */
export function startLeasedWorker(
  name: string,
  intervalMs: number,
  job: () => Promise<unknown>,
  leaseMs = Math.max(intervalMs * 3, 15_000)
): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = withLease(name, leaseMs, job)
      .catch((err) => {
        if (!(err instanceof Error && err.message === 'RESOURCE_BUSY')) logTransientError(`[room-kernel:${name}]`, err);
      })
      .finally(() => {
        running = null;
      });
  }, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
