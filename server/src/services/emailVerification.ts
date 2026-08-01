import crypto from 'crypto';
import net from 'net';
import tls from 'tls';
import { db } from '../db/knex';
import { config } from '../config';
import { redis, redisKey } from '../redis';

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
const EMAIL_VERIFICATION_COOLDOWN_SECONDS = 30;

export class EmailVerificationCooldownError extends Error {
  constructor(public retryAt: number) {
    super('EMAIL_VERIFICATION_COOLDOWN');
  }
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !EMAIL_RE.test(email)) throw new Error('INVALID_EMAIL');
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  // Deliberately reject provider alias syntax. A verification belongs to one mailbox.
  if (!local || local.startsWith('.') || local.endsWith('.') || local.includes('+') || local.includes('..') || local.includes('.')) {
    throw new Error('EMAIL_ALIAS_NOT_SUPPORTED');
  }
  if (config.email.allowedSuffixes.length && !config.email.allowedSuffixes.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`))) {
    throw new Error('EMAIL_DOMAIN_NOT_ALLOWED');
  }
  return email;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function response(socket: net.Socket | tls.TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      const complete = lines.filter(Boolean);
      if (!complete.length) return;
      const last = complete[complete.length - 1];
      if (/^\d{3} /.test(last)) {
        cleanup();
        if (!last.startsWith('2') && !last.startsWith('3')) reject(new Error(`SMTP_${last}`));
        else resolve(complete.join('\n'));
      }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { socket.off('data', onData); socket.off('error', onError); };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function command(socket: net.Socket | tls.TLSSocket, value: string): Promise<void> {
  socket.write(`${value}\r\n`);
  await response(socket);
}

function dotStuff(value: string): string {
  return value.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  if (!config.email.host || !config.email.from) throw new Error('EMAIL_NOT_CONFIGURED');
  let socket: net.Socket | tls.TLSSocket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    const connected = config.email.secure
      ? tls.connect({ host: config.email.host, port: config.email.port, servername: config.email.host }, () => resolve(connected))
      : net.connect({ host: config.email.host, port: config.email.port }, () => resolve(connected));
    connected.once('error', onError);
    connected.setTimeout(15_000, () => connected.destroy(new Error('SMTP_TIMEOUT')));
  });
  try {
    await response(socket);
    await command(socket, `EHLO csgofriberg`);
    if (!config.email.secure && config.email.startTls) {
      await command(socket, 'STARTTLS');
      socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const upgraded = tls.connect({ socket: socket as net.Socket, servername: config.email.host }, () => resolve(upgraded));
        upgraded.once('error', reject);
      });
      await command(socket, `EHLO csgofriberg`);
    }
    if (config.email.username) {
      await command(socket, 'AUTH LOGIN');
      await command(socket, Buffer.from(config.email.username).toString('base64'));
      await command(socket, Buffer.from(config.email.password).toString('base64'));
    }
    await command(socket, `MAIL FROM:<${config.email.from}>`);
    await command(socket, `RCPT TO:<${to}>`);
    socket.write('DATA\r\n');
    await response(socket);
    const message = [
      `From: ${config.email.from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ].join('\r\n');
    socket.write(`${dotStuff(message)}\r\n.\r\n`);
    await response(socket);
    await command(socket, 'QUIT');
  } finally {
    socket.end();
  }
}

export async function claimEmailVerificationCooldown(userId: number): Promise<number> {
  const client = redis();
  if (!client) throw new Error('REDIS_UNAVAILABLE');
  const key = redisKey(`email-verification-cooldown:${userId}`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = Date.now();
    const retryAt = now + EMAIL_VERIFICATION_COOLDOWN_SECONDS * 1000;
    const acquired = await client.set(key, String(retryAt), {
      NX: true,
      EX: EMAIL_VERIFICATION_COOLDOWN_SECONDS,
    });
    if (acquired) return retryAt;

    const existingRetryAt = Number(await client.get(key));
    if (Number.isFinite(existingRetryAt) && existingRetryAt > now) {
      throw new EmailVerificationCooldownError(existingRetryAt);
    }
  }

  throw new EmailVerificationCooldownError(Date.now() + EMAIL_VERIFICATION_COOLDOWN_SECONDS * 1000);
}

export async function issueEmailVerification(
  userId: number,
  emailInput: string,
  options: { enforceCooldown?: boolean } = {}
): Promise<{ retryAt: number | null }> {
  const user = await db('users').where({ id: userId }).first('id', 'email_verified_at');
  if (!user) throw new Error('USER_NOT_FOUND');
  if (user.email_verified_at) throw new Error('EMAIL_ALREADY_VERIFIED');
  const email = normalizeEmail(emailInput);
  const existing = await db('users').where({ email }).whereNot({ id: userId }).first('id');
  if (existing) throw new Error('EMAIL_TAKEN');
  const retryAt = options.enforceCooldown ? await claimEmailVerificationCooldown(userId) : null;
  await db('users').where({ id: userId }).update({ email, email_verified_at: null });
  const authCache = redis();
  if (authCache) await authCache.del(redisKey(`auth:user:${userId}`)).catch(() => undefined);
  const token = crypto.randomBytes(32).toString('base64url');
  await db('email_verifications').where({ user_id: userId }).del();
  await db('email_verifications').insert({
    user_id: userId,
    email,
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + config.email.verifyTtlSeconds * 1000),
  });
  const base = config.email.verifyBaseUrl || config.corsOrigins[0] || 'http://localhost:3000';
  const link = `${base.replace(/\/$/, '')}/email-verify?token=${encodeURIComponent(token)}`;
  await sendEmail(
    email,
    '弗一把邮箱验证',
    `您好：\n\n您正在为“弗一把”绑定邮箱，请点击以下链接完成验证：\n\n${link}\n\n此链接将在 ${Math.round(config.email.verifyTtlSeconds / 60)} 分钟后失效。如果不是您本人操作，请忽略此邮件。`
  );
  return { retryAt };
}

export async function verifyEmailToken(token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return false;
  const row = await db('email_verifications').where({ token_hash: hashToken(token) }).where('expires_at', '>', new Date()).first();
  if (!row) return false;
  const verified = await db.transaction(async (trx) => {
    const updated = await trx('users').where({ id: row.user_id, email: row.email }).update({ email_verified_at: trx.fn.now() });
    if (!updated) return false;
    await trx('email_verifications').where({ id: row.id }).del();
    return true;
  });
  if (!verified) return false;
  const authCache = redis();
  if (authCache) await authCache.del(redisKey(`auth:user:${row.user_id}`)).catch(() => undefined);
  return true;
}
