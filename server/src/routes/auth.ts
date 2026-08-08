import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import {
  clearAuthCookies,
  clearGuestCookie,
  ensureGuestCookie,
  requireAuth,
  setAuthCookies,
  refreshAuthCookies,
  restoreAuthSession,
  invalidateAuthUser,
  userNameFromUsername,
} from '../middleware/auth';
import { validateBody, asyncHandler, HttpError } from '../middleware/common';
import { User } from '../types';
import {
  rateLimit,
  RateLimitReservation,
  releaseRateLimit,
  requestIdentity,
  requestIp,
  reserveRateLimit,
} from '../middleware/rateLimit';
import { invalidateCached } from '../services/queryCache';
import { leaderboardCacheKey } from '../services/leaderboardCache';
import { hashPassword, passwordNeedsRehash, verifyPassword } from '../services/password';
import { DIFFICULTY_LEVELS } from '../difficulties';
import { allGlobalStatsCacheKeys, allPersonalStatsCacheKeys } from '../services/statsCache';
import {
  EmailVerificationCooldownError,
  issueEmailVerification,
  normalizeEmail,
  verifyEmailCode,
  verifyEmailToken,
} from '../services/emailVerification';
import { GeeTestVerificationError, verifyGeeTest } from '../services/geetest';

const router = Router();

const USERNAME_MIN_LENGTH = 2;
const USERNAME_MAX_LENGTH = 20;
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;
const USERNAME_PATTERN = /^[\w一-龥-]+$/;
const EMAIL_REQUEST_ATTEMPT_LIMIT = 30;
const EMAIL_SEND_LIMIT = 3;
const EMAIL_RATE_LIMIT_WINDOW_SECONDS = 3600;

const credentialsSchema = z.object({
  username: z
    .string()
    .min(USERNAME_MIN_LENGTH)
    .max(USERNAME_MAX_LENGTH)
    .regex(USERNAME_PATTERN),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});
const geeTestFields = {
  lot_number: z.string().trim().optional(),
  captcha_output: z.string().trim().optional(),
  pass_token: z.string().trim().optional(),
  gen_time: z.string().trim().optional(),
};
const registerSchema = credentialsSchema.extend({ email: z.string().trim().email().max(320).optional().or(z.literal('')), ...geeTestFields });
const emailSchema = z.object({ email: z.string().trim().email().max(320), ...geeTestFields });
const emailCodeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });

function validateRegisterBody(req: Request, res: Response, next: NextFunction) {
  const result = registerSchema.safeParse(req.body);
  if (!result.success) {
    const body = req.body && typeof req.body === 'object'
      ? req.body as Record<string, unknown>
      : {};
    const username = body.username;
    const password = body.password;
    let code = 'VALIDATION_FAILED';
    if (typeof username !== 'string' || username.length === 0) {
      code = 'REGISTER_USERNAME_REQUIRED';
    } else if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
      code = 'REGISTER_USERNAME_LENGTH';
    } else if (!USERNAME_PATTERN.test(username)) {
      code = 'REGISTER_USERNAME_CHARACTERS';
    } else if (typeof password !== 'string' || password.length === 0) {
      code = 'REGISTER_PASSWORD_REQUIRED';
    } else if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      code = 'REGISTER_PASSWORD_LENGTH';
    } else if (body.email != null && body.email !== '') {
      code = 'INVALID_EMAIL';
    }
    return res.status(400).json({ code });
  }
  req.body = result.data;
  next();
}

function publicUser(user: { id: number; username: string; role: 'user' | 'admin'; email?: string | null; emailVerified?: boolean }) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    email: user.email ?? null,
    emailVerified: Boolean(user.emailVerified),
  };
}

async function reserveEmailSendQuota(req: Request, ip: string): Promise<() => Promise<void>> {
  const reservations: RateLimitReservation[] = [];
  try {
    const userReservation = await reserveRateLimit(
      'email-send',
      requestIdentity(req),
      EMAIL_SEND_LIMIT,
      EMAIL_RATE_LIMIT_WINDOW_SECONDS
    );
    if (!userReservation) throw new HttpError(429, 'RATE_LIMITED');
    reservations.push(userReservation);

    const ipReservation = await reserveRateLimit(
      'email-send-ip',
      ip,
      EMAIL_SEND_LIMIT,
      EMAIL_RATE_LIMIT_WINDOW_SECONDS
    );
    if (!ipReservation) throw new HttpError(429, 'RATE_LIMITED');
    reservations.push(ipReservation);

    return async () => {
      await Promise.allSettled(reservations.map((reservation) => releaseRateLimit(reservation)));
    };
  } catch (error) {
    await Promise.allSettled(reservations.map((reservation) => releaseRateLimit(reservation)));
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'RATE_LIMIT_UNAVAILABLE');
  }
}

router.post(
  '/register',
  rateLimit({ name: 'register', limit: 3, windowSeconds: 3600, failClosed: true }),
  validateRegisterBody,
  asyncHandler(async (req, res) => {
    const { username, password, email: emailInput, lot_number, captcha_output, pass_token, gen_time } = req.body;
    try {
      await verifyGeeTest({ lot_number, captcha_output, pass_token, gen_time });
    } catch (error) {
      if (error instanceof GeeTestVerificationError) throw new HttpError(400, error.code);
      throw error;
    }
    let email: string | null = null;
    if (emailInput) {
      try { email = normalizeEmail(emailInput); }
      catch (error) {
        const code = error instanceof Error ? error.message : 'INVALID_EMAIL';
        throw new HttpError(400, code);
      }
      if (await db<User>('users').where({ email }).first('id')) throw new HttpError(409, 'EMAIL_TAKEN');
    }
    const existing = await db<User>('users').where({ username }).first();
    if (existing) throw new HttpError(409, 'USERNAME_TAKEN');

    const role = 'user' as const;

    const [id] = await db('users')
      .insert({
        username,
        display_id: userNameFromUsername(username),
        password_hash: await hashPassword(password),
        role,
        email,
      })
      .returning('id')
      .then((rows) => rows.map((r: any) => (typeof r === 'object' ? r.id : r)));

    const user = { id, username, role, token_version: 0, email, emailVerified: false };
    await invalidateCached(...allGlobalStatsCacheKeys());
    setAuthCookies(res, user);
    if (email) void issueEmailVerification(id, email).catch((error) => console.warn('[email:register]', error));
    res.json({ user: publicUser(user) });
  })
);

router.post(
  '/login',
  rateLimit({
    name: 'login',
    limit: 5,
    windowSeconds: 60,
    failClosed: true,
    key: (req) => `${req.ip}:${String(req.body?.username ?? '').toLowerCase()}`,
  }),
  validateBody(credentialsSchema),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const user = await db<User>('users').where({ username }).first();
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS');
    }
    if (user.banned_at) throw new HttpError(403, 'USER_BANNED');
    if (passwordNeedsRehash(user.password_hash)) {
      const previousHash = user.password_hash;
      const passwordHash = await hashPassword(password);
      await db('users')
        .where({ id: user.id, password_hash: previousHash })
        .update({ password_hash: passwordHash });
    }
    setAuthCookies(res, user);
    res.json({ user: publicUser({ id: user.id, username: user.username, role: user.role, email: user.email, emailVerified: Boolean(user.email_verified_at) }) });
  })
);

router.get('/me', requireAuth, rateLimit({
  name: 'auth-me',
  limit: 60,
  windowSeconds: 60,
  key: requestIdentity,
  failClosed: true,
}), (req, res) => {
  res.json({ user: req.user });
});

router.post(
  '/refresh',
  rateLimit({ name: 'auth-refresh', limit: 60, windowSeconds: 60, failClosed: true }),
  asyncHandler(async (req, res) => {
    const user = await refreshAuthCookies(req.headers.cookie, res);
    if (!user) {
      clearAuthCookies(res);
      throw new HttpError(401, 'AUTH_REQUIRED');
    }
    res.json({ user });
  })
);

router.post(
  '/session',
  rateLimit({ name: 'session', limit: 60, windowSeconds: 60, failClosed: true }),
  asyncHandler(async (req, res) => {
    const user = await restoreAuthSession(req.headers.cookie, res);
    if (user) return res.json({ authenticated: true, user });
    const guest = ensureGuestCookie(req, res);
    res.json({ authenticated: false, guest: { name: guest.name } });
  })
);

router.post(
  '/logout',
  requireAuth,
  rateLimit({
    name: 'logout',
    limit: 30,
    windowSeconds: 60,
    key: requestIdentity,
    failClosed: true,
  }),
  asyncHandler(async (req, res) => {
    await db('users').where({ id: req.user!.id }).increment('token_version', 1);
    await invalidateAuthUser(req.user!.id);
    clearAuthCookies(res);
    ensureGuestCookie(req, res);
    res.json({ ok: true });
  })
);

router.post(
  '/email/request',
  requireAuth,
  rateLimit({
    name: 'email-request',
    limit: EMAIL_REQUEST_ATTEMPT_LIMIT,
    windowSeconds: EMAIL_RATE_LIMIT_WINDOW_SECONDS,
    key: requestIdentity,
    failClosed: true,
  }),
  rateLimit({
    name: 'email-request-ip',
    limit: EMAIL_REQUEST_ATTEMPT_LIMIT,
    windowSeconds: EMAIL_RATE_LIMIT_WINDOW_SECONDS,
    key: requestIp,
    failClosed: true,
  }),
  validateBody(emailSchema),
  asyncHandler(async (req, res) => {
    try {
      await verifyGeeTest(req.body);
    } catch (error) {
      if (error instanceof GeeTestVerificationError) throw new HttpError(400, error.code);
      throw error;
    }
    try {
      const { retryAt } = await issueEmailVerification(req.user!.id, req.body.email, {
        enforceCooldown: true,
        requestIp: requestIp(req),
        reserveSendQuota: (ip) => reserveEmailSendQuota(req, ip),
      });
      return res.json({ ok: true, retryAt, serverNow: Date.now() });
    } catch (error) {
      if (error instanceof EmailVerificationCooldownError) {
        return res.status(429).json({
          code: error.message,
          retryAt: error.retryAt,
          serverNow: Date.now(),
        });
      }
      const code = error instanceof Error ? error.message : 'EMAIL_SEND_FAILED';
      if (code === 'EMAIL_TAKEN' || code === 'EMAIL_ALREADY_VERIFIED') throw new HttpError(409, code);
      if (['INVALID_EMAIL', 'EMAIL_ALIAS_NOT_SUPPORTED', 'EMAIL_DOMAIN_NOT_ALLOWED', 'EMAIL_NOT_CONFIGURED'].includes(code)) {
        throw new HttpError(400, code);
      }
      throw error;
    }
  })
);

router.get(
  '/email/verify',
  rateLimit({ name: 'email-verify', limit: 30, windowSeconds: 3600, failClosed: false }),
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const ok = await verifyEmailToken(token);
    res.status(ok ? 200 : 400).json({ ok });
  })
);

router.post(
  '/email/verify-code',
  requireAuth,
  rateLimit({ name: 'email-verify-code', limit: 10, windowSeconds: 600, key: requestIdentity, failClosed: true }),
  rateLimit({ name: 'email-verify-code-ip', limit: 10, windowSeconds: 600, key: requestIp, failClosed: true }),
  validateBody(emailCodeSchema),
  asyncHandler(async (req, res) => {
    const ok = await verifyEmailCode(req.user!.id, req.body.code);
    if (!ok) throw new HttpError(400, 'EMAIL_VERIFICATION_CODE_INVALID');
    res.json({ ok: true });
  })
);

/** 登录后认领匿名期间的对局记录,实现本地进度同步到账号 */
router.post(
  '/claim',
  requireAuth,
  rateLimit({
    name: 'claim',
    limit: 3,
    windowSeconds: 3600,
    key: requestIdentity,
    failClosed: true,
  }),
  asyncHandler(async (req, res) => {
    if (!req.guestKey) throw new HttpError(400, 'GUEST_KEY_REQUIRED');
    const guestKey = req.guestKey;
    const claimed = await db('games')
      .where({ guest_key: guestKey })
      .whereNull('user_id')
      .update({ user_id: req.user!.id, guest_key: null });
    clearGuestCookie(res);
    await invalidateCached(
      ...DIFFICULTY_LEVELS.map((difficulty) => leaderboardCacheKey('single', difficulty.key)),
      ...allPersonalStatsCacheKeys(`g:${guestKey}`),
      ...allPersonalStatsCacheKeys(`u:${req.user!.id}`),
      `room-player-performance:g:${guestKey}`,
      `room-player-performance:u:${req.user!.id}`
    );
    res.json({ claimed });
  })
);

export default router;
