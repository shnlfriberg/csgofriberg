import { Router } from 'express';
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
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import { invalidateCached } from '../services/queryCache';
import { hashPassword, passwordNeedsRehash, verifyPassword } from '../services/password';
import { DIFFICULTY_LEVELS } from '../difficulties';

const router = Router();

const credentialsSchema = z.object({
  username: z
    .string()
    .min(2)
    .max(20)
    .regex(/^[\w一-龥-]+$/),
  password: z.string().min(10).max(128),
});

router.post(
  '/register',
  rateLimit({ name: 'register', limit: 5, windowSeconds: 3600, failClosed: true }),
  validateBody(credentialsSchema),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const existing = await db<User>('users').where({ username }).first();
    if (existing) throw new HttpError(409, 'USERNAME_TAKEN');

    const role = 'user' as const;

    const [id] = await db('users')
      .insert({
        username,
        display_id: userNameFromUsername(username),
        password_hash: await hashPassword(password),
        role,
      })
      .returning('id')
      .then((rows) => rows.map((r: any) => (typeof r === 'object' ? r.id : r)));

    const user = { id, username, role, token_version: 0 };
    setAuthCookies(res, user);
    res.json({ user: { id, username, role } });
  })
);

router.post(
  '/login',
  rateLimit({
    name: 'login',
    limit: 10,
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
    if (passwordNeedsRehash(user.password_hash)) {
      const previousHash = user.password_hash;
      const passwordHash = await hashPassword(password);
      await db('users')
        .where({ id: user.id, password_hash: previousHash })
        .update({ password_hash: passwordHash });
    }
    setAuthCookies(res, user);
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
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
    const user = await restoreAuthSession(req.headers.cookie, res, true);
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

/** 登录后认领匿名期间的对局记录,实现本地进度同步到账号 */
router.post(
  '/claim',
  requireAuth,
  rateLimit({
    name: 'claim',
    limit: 5,
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
      ...DIFFICULTY_LEVELS.map((difficulty) => `leaderboard:${difficulty.key}`),
      'leaderboard:multi',
      `stats:personal:g:${guestKey}`,
      `stats:personal:u:${req.user!.id}`,
      `room-player-performance:g:${guestKey}`,
      `room-player-performance:u:${req.user!.id}`
    );
    res.json({ claimed });
  })
);

export default router;
