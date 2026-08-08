import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRedis, redis } from '../../src/redis';
import { releaseRateLimit, reserveRateLimit } from '../../src/middleware/rateLimit';

describe('rate limit reservations', () => {
  const name = `email-send-test-${Date.now()}`;
  const identity = `u:${Date.now()}`;
  const reservationKeys = new Set<string>();

  beforeAll(async () => {
    await initRedis();
  });

  afterEach(async () => {
    if (reservationKeys.size) await redis()?.del([...reservationKeys]);
    reservationKeys.clear();
  });

  it('allows a released send quota to be reserved again', async () => {
    const first = await reserveRateLimit(name, identity, 1, 3600);
    expect(first).not.toBeNull();
    reservationKeys.add(first!.key);

    await expect(reserveRateLimit(name, identity, 1, 3600)).resolves.toBeNull();
    await releaseRateLimit(first!);

    const retried = await reserveRateLimit(name, identity, 1, 3600);
    expect(retried).not.toBeNull();
    reservationKeys.add(retried!.key);
    await releaseRateLimit(retried!);
  });
});
