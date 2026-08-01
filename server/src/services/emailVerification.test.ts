import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRedis, redis, redisKey } from '../redis';
import {
  buildVerificationEmail,
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

describe('verification email template', () => {
  it('keeps the body generic while including the link and safety guidance', () => {
    const body = buildVerificationEmail({
      link: 'https://game.example.com/email-verify?token=test-token',
      ttlSeconds: 1_800,
    });

    expect(body).toContain('您好：');
    expect(body).not.toContain('alice');
    expect(body).not.toContain('@example.com');
    expect(body).toContain('https://game.example.com/email-verify?token=test-token');
    expect(body).toContain('链接有效期：30 分钟');
    expect(body).toContain('如果您没有进行此操作，请忽略本邮件。');
  });
});
