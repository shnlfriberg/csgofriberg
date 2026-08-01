import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRedis, redis, redisKey } from '../redis';
import {
  claimEmailVerificationCooldown,
  EmailVerificationCooldownError,
} from './emailVerification';

describe('email verification cooldown', () => {
  const userId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
  const key = redisKey(`email-verification-cooldown:${userId}`);

  beforeAll(async () => {
    await initRedis();
  });

  afterEach(async () => {
    await redis()?.del(key);
  });

  it('allows one request per user every 30 seconds', async () => {
    const before = Date.now();
    const retryAt = await claimEmailVerificationCooldown(userId);

    expect(retryAt).toBeGreaterThanOrEqual(before + 29_000);
    expect(retryAt).toBeLessThanOrEqual(before + 31_000);
    await expect(claimEmailVerificationCooldown(userId)).rejects.toMatchObject({
      message: 'EMAIL_VERIFICATION_COOLDOWN',
      retryAt,
    } satisfies Partial<EmailVerificationCooldownError>);
  });
});
