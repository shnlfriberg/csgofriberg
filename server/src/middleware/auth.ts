import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { db } from '../db/knex';
import { User } from '../types';
import { redis, redisKey } from '../redis';
import { guestNameFromKey, userNameFromUsername } from '../services/identityDisplay';
import { isGuestBanned } from '../services/guestAccounts';

export { guestNameFromKey, userNameFromUsername } from '../services/identityDisplay';

const AUTH_COOKIE = 'csgofriberg_session';
const REFRESH_COOKIE = 'csgofriberg_refresh';
const GUEST_COOKIE = 'csgofriberg_guest';
const AUTH_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const GUEST_MAX_AGE_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const MAX_VERIFIED_TOKEN_CACHE = 10_000;
const verifiedAuthTokens = new Map<string, { payload: AuthTokenPayload; expiresAt: number }>();
const verifiedGuestTokens = new Map<string, { identity: GuestIdentity; expiresAt: number }>();

function cacheToken<T>(cache: Map<string, T>, token: string, value: T): void {
  if (cache.size >= MAX_VERIFIED_TOKEN_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(token, value);
}

interface AuthTokenPayload {
  sub: string;
  ver: number;
  typ: 'auth';
}

interface RefreshTokenPayload {
  sub: string;
  ver: number;
  typ: 'refresh';
  jti: string;
}

interface GuestTokenPayload {
  key: string;
  typ: 'guest';
}

interface CachedAuthUser extends AuthPayload {
  tokenVersion: number;
}

export interface ResolvedAuthUser extends AuthPayload {
  tokenVersion: number;
}

export interface AuthPayload {
  id: number;
  username: string;
  role: 'user' | 'admin';
  email: string | null;
  emailVerified: boolean;
}

export interface GuestIdentity {
  key: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
      guestKey?: string;
      guestName?: string;
    }
  }
}

function cookieOptions(maxAge: number, path = '/') {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    path,
    maxAge,
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const index = part.indexOf('=');
      const key = index >= 0 ? part.slice(0, index).trim() : part.trim();
      const value = index >= 0 ? part.slice(index + 1).trim() : '';
      try {
        return [key, decodeURIComponent(value)];
      } catch {
        return [key, value];
      }
    })
  );
}

export function signToken(user: Pick<User, 'id' | 'token_version'>): string {
  return jwt.sign(
    { sub: String(user.id), ver: Number(user.token_version), typ: 'auth' } satisfies AuthTokenPayload,
    config.jwtSecret,
    { expiresIn: '12h', algorithm: 'HS256' }
  );
}

function signRefreshToken(user: Pick<User, 'id' | 'token_version'>): string {
  return jwt.sign(
    {
      sub: String(user.id),
      ver: Number(user.token_version),
      typ: 'refresh',
      jti: crypto.randomUUID(),
    } satisfies RefreshTokenPayload,
    config.jwtSecret,
    { expiresIn: '30d', algorithm: 'HS256' }
  );
}

export function setAuthCookies(res: Response, user: Pick<User, 'id' | 'token_version'>): void {
  res.cookie(AUTH_COOKIE, signToken(user), cookieOptions(AUTH_MAX_AGE_MS));
  res.cookie(
    REFRESH_COOKIE,
    signRefreshToken(user),
    cookieOptions(REFRESH_MAX_AGE_MS, '/api/auth')
  );
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(AUTH_COOKIE, cookieOptions(0));
  res.clearCookie(REFRESH_COOKIE, cookieOptions(0, '/api/auth'));
}

function signGuestToken(key: string): string {
  return jwt.sign({ key, typ: 'guest' } satisfies GuestTokenPayload, config.jwtSecret, {
    expiresIn: '1095d',
    algorithm: 'HS256',
  });
}

function verifyGuestToken(token: string | undefined): GuestIdentity | null {
  if (!token) return null;
  const cached = verifiedGuestTokens.get(token);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.identity;
    verifiedGuestTokens.delete(token);
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as GuestTokenPayload & { exp?: number };
    if (payload.typ !== 'guest' || !/^[\w-]{8,64}$/.test(payload.key)) return null;
    const identity = { key: payload.key, name: guestNameFromKey(payload.key) };
    cacheToken(verifiedGuestTokens, token, {
      identity,
      expiresAt: (payload.exp ?? 0) * 1000,
    });
    return identity;
  } catch {
    return null;
  }
}

export function getGuestFromCookie(cookieHeader: string | undefined): GuestIdentity | null {
  return verifyGuestToken(parseCookies(cookieHeader)[GUEST_COOKIE]);
}

export function ensureGuestCookie(req: Request, res: Response): GuestIdentity {
  const existing = getGuestFromCookie(req.headers.cookie);
  if (existing) return existing;
  const guest = { key: crypto.randomUUID(), name: '' };
  guest.name = guestNameFromKey(guest.key);
  res.cookie(GUEST_COOKIE, signGuestToken(guest.key), cookieOptions(GUEST_MAX_AGE_MS));
  return guest;
}

async function resolveTokenUser(
  payload: Pick<AuthTokenPayload, 'sub' | 'ver'>
): Promise<ResolvedAuthUser | null> {
  if (!/^\d+$/.test(payload.sub)) return null;
  const userId = Number(payload.sub);
  const client = redis();
  const cacheKey = redisKey(`auth:user:${userId}`);
  if (client) {
    try {
      const cached = await client.get(cacheKey);
      if (cached) {
        const user = JSON.parse(cached) as CachedAuthUser;
        if (user.tokenVersion !== Number(payload.ver)) return null;
        return {
          id: user.id,
          username: user.username,
          role: user.role,
          email: user.email ?? null,
          emailVerified: Boolean(user.emailVerified),
          tokenVersion: user.tokenVersion,
        };
      }
    } catch (err) {
      console.warn('[auth:cache-read]', err instanceof Error ? err.message : err);
    }
  }
  const user = await db<User>('users').where({ id: userId }).first();
  if (!user || Number(user.token_version) !== Number(payload.ver) || user.banned_at) return null;
  if (client) {
    const cached: CachedAuthUser = {
      id: user.id,
      username: user.username,
      role: user.role,
      email: user.email ?? null,
      emailVerified: Boolean(user.email_verified_at),
      tokenVersion: Number(user.token_version),
    };
    try {
      await client.set(cacheKey, JSON.stringify(cached), { EX: 300 });
    } catch (err) {
      console.warn('[auth:cache-write]', err instanceof Error ? err.message : err);
    }
  }
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    tokenVersion: Number(user.token_version),
    email: user.email ?? null,
    emailVerified: Boolean(user.email_verified_at),
  };
}

export function clearGuestCookie(res: Response): void {
  res.clearCookie(GUEST_COOKIE, cookieOptions(0));
}

export function hasAuthSessionCookie(cookieHeader: string | undefined): boolean {
  const cookies = parseCookies(cookieHeader);
  return Boolean(cookies[AUTH_COOKIE] || cookies[REFRESH_COOKIE]);
}

function hasRefreshCookie(cookieHeader: string | undefined): boolean {
  return Boolean(parseCookies(cookieHeader)[REFRESH_COOKIE]);
}

export async function authenticateCookie(
  cookieHeader: string | undefined
): Promise<ResolvedAuthUser | null> {
  const token = parseCookies(cookieHeader)[AUTH_COOKIE];
  if (!token) return null;
  let payload: AuthTokenPayload;
  const cachedToken = verifiedAuthTokens.get(token);
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    payload = cachedToken.payload;
  } else {
    if (cachedToken) verifiedAuthTokens.delete(token);
    try {
      const verified = jwt.verify(token, config.jwtSecret, {
        algorithms: ['HS256'],
      }) as AuthTokenPayload & { exp?: number };
      if (verified.typ !== 'auth') return null;
      payload = verified;
      cacheToken(verifiedAuthTokens, token, {
        payload,
        expiresAt: (verified.exp ?? 0) * 1000,
      });
    } catch {
      return null;
    }
  }
  if (payload.typ !== 'auth') return null;
  return resolveTokenUser(payload);
}

export async function authenticateRefreshCookie(
  cookieHeader: string | undefined
): Promise<ResolvedAuthUser | null> {
  const token = parseCookies(cookieHeader)[REFRESH_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
    }) as RefreshTokenPayload;
    if (payload.typ !== 'refresh' || !payload.jti) return null;
    return resolveTokenUser(payload);
  } catch {
    return null;
  }
}

export async function refreshAuthCookies(
  cookieHeader: string | undefined,
  res: Response
): Promise<AuthPayload | null> {
  const user = await authenticateRefreshCookie(cookieHeader);
  if (!user) return null;
  setAuthCookies(res, { id: user.id, token_version: user.tokenVersion });
  return { id: user.id, username: user.username, role: user.role, email: user.email, emailVerified: user.emailVerified };
}

export async function restoreAuthSession(
  cookieHeader: string | undefined,
  res: Response,
  issueMissingRefresh = false
): Promise<AuthPayload | null> {
  const user = await authenticateCookie(cookieHeader);
  if (user) {
    if (issueMissingRefresh && !hasRefreshCookie(cookieHeader)) {
      setAuthCookies(res, { id: user.id, token_version: user.tokenVersion });
    }
    return { id: user.id, username: user.username, role: user.role, email: user.email, emailVerified: user.emailVerified };
  }
  return refreshAuthCookies(cookieHeader, res);
}

export async function invalidateAuthUser(userId: number): Promise<void> {
  const client = redis();
  if (!client) return;
  await client.del(redisKey(`auth:user:${userId}`));
}

async function attachIdentity(
  req: Request,
  res: Response
): Promise<'authenticated' | 'guest' | 'expired' | 'banned'> {
  const user = await restoreAuthSession(
    req.headers.cookie,
    res,
    req.originalUrl.startsWith('/api/auth/')
  );
  if (user) {
    req.user = user;
  } else if (req.headers['x-auth-expected'] === '1') {
    return 'expired';
  } else if (hasAuthSessionCookie(req.headers.cookie)) {
    // Do not silently downgrade a revoked/banned authenticated session to a guest.
    return 'expired';
  }
  const guest = user
    ? getGuestFromCookie(req.headers.cookie)
    : ensureGuestCookie(req, res);
  if (!guest) return user ? 'authenticated' : 'guest';
  if (await isGuestBanned(guest.key)) return 'banned';
  req.guestKey = guest.key;
  req.guestName = guest.name;
  return user ? 'authenticated' : 'guest';
}

export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  void attachIdentity(req, res).then((result) => {
    if (result === 'expired') return res.status(401).json({ code: 'AUTH_EXPIRED' });
    if (result === 'banned') return res.status(403).json({ code: 'USER_BANNED' });
    next();
  }, next);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  void attachIdentity(req, res).then((result) => {
    if (result === 'banned') return res.status(403).json({ code: 'USER_BANNED' });
    if (!req.user) {
      return res.status(401).json({ code: result === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED' });
    }
    next();
  }, next);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ code: 'AUTH_REQUIRED' });
  if (req.user.role !== 'admin') return res.status(403).json({ code: 'FORBIDDEN' });
  next();
}
