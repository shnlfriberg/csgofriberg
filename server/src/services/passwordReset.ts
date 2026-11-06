import crypto from 'crypto';
import { db } from '../db/knex';
import { config } from '../config';
import { redis, redisKey } from '../redis';
import { reserveRateLimit } from '../middleware/rateLimit';
import { invalidateAuthUser } from '../middleware/auth';
import { sendEmail } from './emailVerification';
import { hashPassword } from './password';

export const PASSWORD_RESET_TTL_SECONDS = 600;
export const PASSWORD_RESET_COOLDOWN_SECONDS = 30;
const MAX_ATTEMPTS = 5;

// Recovery must still work for previously bound addresses if binding policy changes.
export const recoveryEmail = (email: string): string => email.trim().toLowerCase();
export const recoveryEmailKey = (email: string): string => crypto.createHash('sha256').update(recoveryEmail(email)).digest('hex');

function codeHash(userId: number, email: string, code: string): string {
  return crypto.createHmac('sha256', config.jwtSecret)
    .update(`password-reset:${userId}:${email}:${code}`).digest('hex');
}

export function buildPasswordResetEmail(code: string): string {
  return [
    '您好：', '', '您正在找回「弗一把」账号密码。', '',
    '您的密码重置验证码是：', '', code, '',
    '验证码有效期：10 分钟，仅可使用一次。',
    '为保障账号安全，请勿将验证码告知他人。',
    '如果您没有进行此操作，请忽略本邮件，您的密码不会改变。',
    '此邮件由系统自动发送，请勿直接回复。', '', '弗一把',
  ].join('\n');
}

/** Run before the account lookup, including for nonexistent/unverified mailboxes. */
export async function reservePasswordReset(email: string): Promise<boolean> {
  const client = redis();
  if (!client) throw new Error('REDIS_UNAVAILABLE');
  const identity = recoveryEmailKey(email);
  const acquired = await client.set(redisKey(`password-reset-cooldown:${identity}`), '1', {
    NX: true, EX: PASSWORD_RESET_COOLDOWN_SECONDS,
  });
  if (!acquired) return false;
  return Boolean(await reserveRateLimit('password-reset-mailbox', identity, 3, 3600));
}

/**
 * Delivery is deliberately detached from the HTTP response to avoid SMTP/account timing leaks.
 * A verified email is unique across accounts, so it alone identifies the account to recover.
 */
export async function issuePasswordReset(emailInput: string): Promise<void> {
  const email = recoveryEmail(emailInput);
  const user = await db('users').where({ email }).whereNotNull('email_verified_at')
    .first('id', 'token_version');
  if (!user) return;
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const tokenHash = codeHash(user.id, email, code);
  await db('password_resets').insert({
    user_id: user.id, email, token_hash: tokenHash, token_version: user.token_version,
    attempts: 0, expires_at: new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000),
  }).onConflict('user_id').merge();
  try {
    await sendEmail(email, '您的密码重置验证码｜弗一把', buildPasswordResetEmail(code));
  } catch (error) {
    await db('password_resets').where({ user_id: user.id, token_hash: tokenHash }).del();
    throw error;
  }
}

export interface PasswordResetResult { userId: number; username: string }

/** Returns the recovered account only after the mailbox code was verified and consumed. */
export async function resetPassword(emailInput: string, code: string, password: string): Promise<PasswordResetResult | null> {
  const email = recoveryEmail(emailInput);
  const user = await db('users').where({ email }).whereNotNull('email_verified_at').first('id', 'username');
  if (!user || !/^\d{6}$/.test(code)) return null;
  const expected = codeHash(user.id, email, code);
  // Charge attempts atomically before expensive hashing, including across app instances.
  const [challenge] = await db('password_resets').where({ user_id: user.id, email })
    .where('expires_at', '>', new Date()).where('attempts', '<', MAX_ATTEMPTS)
    .update({ attempts: db.raw('attempts + 1') }).returning('*');
  if (!challenge || !crypto.timingSafeEqual(Buffer.from(challenge.token_hash, 'hex'), Buffer.from(expected, 'hex'))) return null;
  const passwordHash = await hashPassword(password);
  const ok = await db.transaction(async (trx) => {
    // The first write locks/consumes the exact challenge. A resend or another reset cannot reuse it.
    const consumed = await trx('password_resets').where({ user_id: user.id, token_hash: expected, expires_at: challenge.expires_at })
      .where('expires_at', '>', new Date()).del();
    if (!consumed) return false;
    const updated = await trx('users').where({ id: user.id, email, token_version: challenge.token_version })
      .whereNotNull('email_verified_at')
      .update({ password_hash: passwordHash, token_version: trx.raw('token_version + 1') });
    return Boolean(updated);
  });
  if (ok) await invalidateAuthUser(user.id);
  return ok ? { userId: Number(user.id), username: String(user.username) } : null;
}
