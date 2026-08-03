import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from './auth';
import { errorHandler } from '../middleware/common';
import { initDb } from '../db/init';
import { db } from '../db/knex';
import { initRedis } from '../redis';
import { config } from '../config';
import { guestNameFromKey, optionalAuth, userNameFromUsername } from '../middleware/auth';

let server: http.Server;
let baseUrl: string;
const TEST_RUN_IP_HEX = Date.now().toString(16).padStart(12, '0').slice(-12);

function testIp(index = 0): string {
  return `2001:db8:${TEST_RUN_IP_HEX.slice(0, 4)}:${TEST_RUN_IP_HEX.slice(4, 8)}:${TEST_RUN_IP_HEX.slice(8)}::${index + 1}`;
}

const TEST_IP = testIp();

function mergeCookies(current: string, response: Response): string {
  const values = setCookies(response);
  const jar = new Map(current.split('; ').filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    return [item.slice(0, index), item.slice(index + 1)];
  }));
  for (const value of values) {
    const first = value.split(';')[0];
    const index = first.indexOf('=');
    jar.set(first.slice(0, index), first.slice(index + 1));
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
}

function setCookies(response: Response): string[] {
  const getSetCookie = (response.headers as any).getSetCookie?.bind(response.headers);
  return getSetCookie
    ? getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean) as string[];
}

async function request(path: string, cookie: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': TEST_IP,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { response, data: await response.json(), cookie: mergeCookies(cookie, response) };
}

describe('cookie authentication', () => {
  beforeAll(async () => {
    await initDb();
    await initRedis();
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.get('/api/optional-auth', optionalAuth, (req, res) => {
      res.json({ authenticated: Boolean(req.user) });
    });
    app.use('/api/auth', authRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('derives a stable anonymous display ID for authenticated users', () => {
    expect(userNameFromUsername('alice')).toMatch(/^用户#[0-9A-Z]{5}$/);
    expect(userNameFromUsername('alice')).toBe(userNameFromUsername('alice'));
    expect(userNameFromUsername('alice')).not.toBe(userNameFromUsername('bob'));
  });

  it('binds guest claims and revokes logout immediately', async () => {
    const stamp = String(Date.now()).slice(-10);
    const username = `at${stamp}`;
    const password = `Strong-${stamp}-Password`;
    let cookie = '';
    let result = await request('/api/auth/session', cookie, { method: 'POST', body: '{}' });
    cookie = result.cookie;
    expect(result.response.headers.get('set-cookie')).toContain('Max-Age=94608000');
    const guestToken = cookie.split('; ').find((item) => item.startsWith('csgofriberg_guest='))!.split('=')[1];
    const guest = jwt.verify(guestToken, config.jwtSecret) as {
      key: string;
      iat: number;
      exp: number;
    };
    expect(result.data.guest.name).toMatch(/^访客#[0-9A-Z]{5}$/);
    expect(result.data.guest.name).toBe(guestNameFromKey(guest.key));
    expect(guest.exp - guest.iat).toBe(3 * 365 * 24 * 60 * 60);
    const sessionId = `auth-test-${Date.now()}`;
    const [player] = await db('players').select('id').limit(1);
    await db('games').insert({
      session_id: sessionId,
      guest_key: guest.key,
      target_player_id: player.id,
      mode: 'easy',
      guesses: '[]',
      status: 'lost',
      guess_count: 0,
      finished_at: db.fn.now(),
    });

    result = await request('/api/auth/register', cookie, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    cookie = result.cookie;
    expect(result.response.status).toBe(200);
    expect(cookie).toContain('csgofriberg_session=');
    expect(cookie).toContain('csgofriberg_refresh=');
    expect(result.response.headers.get('set-cookie')).toContain('Max-Age=43200');
    expect(result.response.headers.get('set-cookie')).toContain('Max-Age=2592000');
    const issuedCookies = setCookies(result.response);
    expect(issuedCookies.find((item) => item.startsWith('csgofriberg_session=')))
      .toContain('Path=/');
    expect(issuedCookies.find((item) => item.startsWith('csgofriberg_refresh=')))
      .toContain('Path=/api/auth');
    const authToken = cookie.split('; ').find((item) => item.startsWith('csgofriberg_session='))!.split('=')[1];
    const authPayload = jwt.verify(authToken, config.jwtSecret) as { iat: number; exp: number };
    expect(authPayload.exp - authPayload.iat).toBe(12 * 60 * 60);
    const refreshToken = cookie.split('; ').find((item) => item.startsWith('csgofriberg_refresh='))!.split('=')[1];
    const refreshPayload = jwt.verify(refreshToken, config.jwtSecret) as {
      typ: string;
      iat: number;
      exp: number;
    };
    expect(refreshPayload.typ).toBe('refresh');
    expect(refreshPayload.exp - refreshPayload.iat).toBe(30 * 24 * 60 * 60);
    const registeredUser = await db('users').where({ username }).first();
    expect(registeredUser.password_hash).toMatch(/^\$2[aby]\$08\$/);
    expect(registeredUser.display_id).toBe(userNameFromUsername(username));

    const legacyAccessOnlyCookie = cookie
      .split('; ')
      .filter((item) => !item.startsWith('csgofriberg_refresh='))
      .join('; ');
    result = await request('/api/auth/me', legacyAccessOnlyCookie);
    cookie = result.cookie;
    expect(result.response.status).toBe(200);
    expect(cookie).toContain('csgofriberg_refresh=');

    const cookiesBeforeSession = cookie;
    result = await request('/api/auth/session', cookie, { method: 'POST', body: '{}' });
    cookie = result.cookie;
    expect(result.data.authenticated).toBe(true);
    expect(cookie).toBe(cookiesBeforeSession);

    const expiredAccess = jwt.sign(
      { sub: String(registeredUser.id), ver: 0, typ: 'auth' },
      config.jwtSecret,
      { expiresIn: -1, algorithm: 'HS256' }
    );
    cookie = cookie
      .split('; ')
      .map((item) => item.startsWith('csgofriberg_session=')
        ? `csgofriberg_session=${expiredAccess}`
        : item)
      .join('; ');

    const expiredAccessOnlyCookie = cookie
      .split('; ')
      .filter((item) => !item.startsWith('csgofriberg_refresh='))
      .join('; ');
    const expiredOptional = await request('/api/optional-auth', expiredAccessOnlyCookie, {
      headers: { 'X-Auth-Expected': '1' },
    });
    expect(expiredOptional.response.status).toBe(401);
    expect(expiredOptional.data.code).toBe('AUTH_EXPIRED');
    expect(setCookies(expiredOptional.response).join(';')).not.toContain('csgofriberg_guest=');

    result = await request('/api/auth/me', cookie);
    cookie = result.cookie;
    expect(result.response.status).toBe(200);
    expect(result.data.user.username).toBe(username);
    const refreshedAccess = cookie
      .split('; ')
      .find((item) => item.startsWith('csgofriberg_session='))!
      .split('=')[1];
    expect(refreshedAccess).not.toBe(expiredAccess);
    expect((jwt.verify(refreshedAccess, config.jwtSecret) as { exp: number; iat: number }).exp -
      (jwt.verify(refreshedAccess, config.jwtSecret) as { exp: number; iat: number }).iat)
      .toBe(12 * 60 * 60);

    result = await request('/api/auth/refresh', cookie, { method: 'POST', body: '{}' });
    cookie = result.cookie;
    expect(result.response.status).toBe(200);
    expect(result.data.user.id).toBe(registeredUser.id);

    result = await request('/api/auth/claim', cookie, {
      method: 'POST',
      body: JSON.stringify({ guestKey: 'forged-guest-key' }),
    });
    expect(result.data.claimed).toBe(1);
    expect(setCookies(result.response).find((item) => item.startsWith('csgofriberg_guest=')))
      .toMatch(/Max-Age=0; Path=\//);
    const game = await db('games').where({ session_id: sessionId }).first();
    expect(game.guest_key).toBeNull();

    const refreshBeforeLogout = cookie
      .split('; ')
      .find((item) => item.startsWith('csgofriberg_refresh='))!;
    result = await request('/api/auth/logout', cookie, { method: 'POST', body: '{}' });
    cookie = result.cookie;
    result = await request('/api/auth/me', cookie);
    expect(result.response.status).toBe(401);
    result = await request('/api/auth/refresh', refreshBeforeLogout, {
      method: 'POST',
      body: '{}',
    });
    expect(result.response.status).toBe(401);

    const user = await db('users').where({ username }).first();
    await db('games').where({ session_id: sessionId }).del();
    await db('users').where({ id: user.id }).del();
  });

  it.each([
    ['short username', { username: 'a', password: 'long-enough-password' }, 'REGISTER_USERNAME_LENGTH', 1],
    ['invalid username characters', { username: 'bad name', password: 'long-enough-password' }, 'REGISTER_USERNAME_CHARACTERS', 2],
    ['short password', { username: 'valid_name', password: 'short' }, 'REGISTER_PASSWORD_LENGTH', 3],
    ['invalid email', { username: 'valid_name', password: 'long-enough-password', email: 'invalid-email' }, 'INVALID_EMAIL', 4],
  ])('returns a specific registration error for %s', async (_label, body, code, ipIndex) => {
    const result = await request('/api/auth/register', '', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'X-Forwarded-For': testIp(ipIndex) },
    });
    expect(result.response.status).toBe(400);
    expect(result.data).toEqual({ code });
  });
});
