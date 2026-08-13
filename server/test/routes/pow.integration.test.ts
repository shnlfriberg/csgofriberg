import http from 'http';
import express from 'express';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import powRoutes from '../../src/routes/pow';
import authRoutes from '../../src/routes/auth';
import { requirePow } from '../../src/middleware/pow';
import { errorHandler } from '../../src/middleware/common';
import { initRedis, redis, redisKey } from '../../src/redis';
import { config } from '../../src/config';
import { hasLeadingZeroBits, modifiedSha256, POW_COOKIE } from '../../src/services/pow';
import { initDb } from '../../src/db/init';
import { db } from '../../src/db/knex';

let server: http.Server;
let baseUrl: string;
const USER_AGENT = 'csgofriberg-pow-integration-test';
const TEST_IP = `198.51.100.${(Date.now() % 250) + 1}`;
const TEST_POW_DIFFICULTY = 16;
const TEST_REGISTER_POW_DIFFICULTY = 17;
const originalPowDifficulty = config.powDifficulty;
const originalPowRegisterDifficulty = config.powRegisterDifficulty;

function setCookies(response: Response): string[] {
  const getSetCookie = (response.headers as any).getSetCookie?.bind(response.headers);
  return getSetCookie ? getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean) as string[];
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-Forwarded-For': TEST_IP,
      ...(init.headers ?? {}),
    },
  });
  return { response, data: await response.json() };
}

function solve(challenge: string, difficulty: number): string {
  const bytes = Buffer.from(challenge, 'base64url');
  for (let nonce = 0n; nonce <= 0xffffffffffffffffn; nonce++) {
    if (hasLeadingZeroBits(modifiedSha256(bytes, nonce), difficulty)) return nonce.toString();
  }
  throw new Error('POW_NOT_FOUND');
}

describe('proof of work gateway', () => {
  beforeAll(async () => {
    config.powDifficulty = TEST_POW_DIFFICULTY;
    config.powRegisterDifficulty = TEST_REGISTER_POW_DIFFICULTY;
    await initDb();
    await initRedis();
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/pow', powRoutes);
    app.use('/api', requirePow);
    app.use('/api/auth', authRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    try {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      config.powDifficulty = originalPowDifficulty;
      config.powRegisterDifficulty = originalPowRegisterDifficulty;
    }
  });

  it('does not issue a guest identity before PoW succeeds', async () => {
    const result = await request('/api/auth/session', { method: 'POST', body: '{}' });
    expect(result.response.status).toBe(428);
    expect(result.data.code).toBe('POW_REQUIRED');
    expect(setCookies(result.response).join(';')).not.toContain('csgofriberg_guest=');
  });

  it('issues a short-lived pass and consumes the challenge once', async () => {
    const challengeResult = await request('/api/pow/challenge', { method: 'POST', body: '{}' });
    expect(challengeResult.response.status).toBe(200);
    const rateKeys = await redis()!.keys(redisKey('rl:pow:challenge:*'));
    const rateKey = rateKeys.at(-1);
    expect(rateKey).toBeTruthy();
    const fields = await redis()!.hKeys(rateKey!);
    expect(fields.length).toBeGreaterThan(0);
    const fieldTtl = await redis()!.sendCommand([
      'HTTL', rateKey!, 'FIELDS', '1', fields[0],
    ]) as number[];
    expect(Number(fieldTtl[0])).toBeGreaterThan(0);
    const nonce = solve(challengeResult.data.challenge, challengeResult.data.difficulty);
    const body = JSON.stringify({ id: challengeResult.data.id, nonce });

    const verified = await request('/api/pow/verify', { method: 'POST', body });
    expect(verified.response.status).toBe(200);
    expect(verified.data.expiresAt).toBeGreaterThan(Date.now());
    expect(verified.data.expiresInMs).toBeGreaterThan(0);
    expect(verified.data.expiresInMs).toBeLessThanOrEqual(verified.data.expiresAt - Date.now() + 1_000);
    const powCookie = setCookies(verified.response)
      .map((value) => value.split(';')[0])
      .find((value) => value.startsWith(`${POW_COOKIE}=`));
    expect(powCookie).toBeTruthy();
    expect(setCookies(verified.response).find((value) => value.startsWith(`${POW_COOKIE}=`)))
      .toContain('Path=/api');

    const replay = await request('/api/pow/verify', { method: 'POST', body });
    expect(replay.response.status).toBe(400);
    expect(replay.data.code).toBe('POW_CHALLENGE_EXPIRED');

    const session = await request('/api/auth/session', {
      method: 'POST',
      body: '{}',
      headers: { Cookie: powCookie! },
    });
    expect(session.response.status).toBe(200);
    expect(Number(session.response.headers.get('x-pow-expires-in'))).toBeGreaterThan(0);
    expect(setCookies(session.response).join(';')).toContain('csgofriberg_guest=');

    const registerChallenge = await request('/api/pow/challenge', {
      method: 'POST',
      body: JSON.stringify({ profile: 'register' }),
    });
    expect(registerChallenge.response.status).toBe(200);
    expect(registerChallenge.data.difficulty).toBe(config.powRegisterDifficulty);
    expect(setCookies(registerChallenge.response).join(';')).not.toContain(`${POW_COOKIE}=`);
    const blockedRegister = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'pow-register-check', password: 'Strong-password-123' }),
      headers: { Cookie: powCookie! },
    });
    expect(blockedRegister.response.status).toBe(428);
    expect(blockedRegister.data.code).toBe('POW_REQUIRED');
  });

  it('consumes one dedicated PoW proof for exactly one registration', async () => {
    const challengeResult = await request('/api/pow/challenge', {
      method: 'POST',
      body: JSON.stringify({ profile: 'register' }),
    });
    const nonce = solve(challengeResult.data.challenge, challengeResult.data.difficulty);
    const username = `pr${Date.now().toString(36)}`;
    const proofHeaders = {
      'X-Register-PoW-Id': challengeResult.data.id,
      'X-Register-PoW-Nonce': nonce,
    };

    const registered = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password: 'Strong-password-123' }),
      headers: proofHeaders,
    });
    expect(registered.response.status).toBe(200);
    expect(registered.data.user.username).toBe(username);
    expect(setCookies(registered.response).join(';')).not.toContain(`${POW_COOKIE}=`);

    const replay = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: `${username}x`, password: 'Strong-password-123' }),
      headers: proofHeaders,
    });
    expect(replay.response.status).toBe(428);
    expect(replay.data.code).toBe('POW_REQUIRED');
    expect(await db('users').where({ username: `${username}x` }).first()).toBeUndefined();

    await db('users').where({ username }).del();
  }, 15_000);

  it('does not exchange a registration challenge for a reusable PoW cookie', async () => {
    const challengeResult = await request('/api/pow/challenge', {
      method: 'POST',
      body: JSON.stringify({ profile: 'register' }),
    });
    const result = await request('/api/pow/verify', {
      method: 'POST',
      body: JSON.stringify({ id: challengeResult.data.id, nonce: '0' }),
    });

    expect(result.response.status).toBe(400);
    expect(result.data.code).toBe('POW_CHALLENGE_INVALID');
    expect(setCookies(result.response).join(';')).not.toContain(`${POW_COOKIE}=`);
  });

  it('binds a challenge to the requesting browser fingerprint', async () => {
    const challengeResult = await request('/api/pow/challenge', { method: 'POST', body: '{}' });
    const result = await request('/api/pow/verify', {
      method: 'POST',
      body: JSON.stringify({ id: challengeResult.data.id, nonce: '0' }),
      headers: { 'User-Agent': `${USER_AGENT}-changed` },
    });
    expect(result.response.status).toBe(400);
    expect(result.data.code).toBe('POW_FINGERPRINT_MISMATCH');
  });

  it('binds a challenge to the requesting IP address', async () => {
    const challengeResult = await request('/api/pow/challenge', { method: 'POST', body: '{}' });
    const nonce = solve(challengeResult.data.challenge, challengeResult.data.difficulty);
    const result = await request('/api/pow/verify', {
      method: 'POST',
      body: JSON.stringify({ id: challengeResult.data.id, nonce }),
      headers: { 'X-Forwarded-For': '203.0.113.91' },
    });
    expect(result.response.status).toBe(400);
    expect(result.data.code).toBe('POW_FINGERPRINT_MISMATCH');
  });

  it('rejects a valid PoW cookie after the client IP changes', async () => {
    const challengeResult = await request('/api/pow/challenge', { method: 'POST', body: '{}' });
    const nonce = solve(challengeResult.data.challenge, challengeResult.data.difficulty);
    const verified = await request('/api/pow/verify', {
      method: 'POST',
      body: JSON.stringify({ id: challengeResult.data.id, nonce }),
    });
    const powCookie = setCookies(verified.response)
      .map((value) => value.split(';')[0])
      .find((value) => value.startsWith(`${POW_COOKIE}=`));
    expect(powCookie).toBeTruthy();

    const session = await request('/api/auth/session', {
      method: 'POST',
      body: '{}',
      headers: { Cookie: powCookie!, 'X-Forwarded-For': '203.0.113.92' },
    });
    expect(session.response.status).toBe(428);
    expect(session.data.code).toBe('POW_REQUIRED');
  });

  it('rejects a registration proof after the client IP changes', async () => {
    const challengeResult = await request('/api/pow/challenge', {
      method: 'POST',
      body: JSON.stringify({ profile: 'register' }),
    });
    const nonce = solve(challengeResult.data.challenge, challengeResult.data.difficulty);
    const username = `pi${Date.now().toString(36)}`;
    const registered = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password: 'Strong-password-123' }),
      headers: {
        'X-Register-PoW-Id': challengeResult.data.id,
        'X-Register-PoW-Nonce': nonce,
        'X-Forwarded-For': '203.0.113.93',
      },
    });
    expect(registered.response.status).toBe(428);
    expect(registered.data.code).toBe('POW_REQUIRED');
    expect(await db('users').where({ username }).first()).toBeUndefined();
  }, 15_000);

  it('rejects an invalid nonce and does not accept its challenge again', async () => {
    const challengeResult = await request('/api/pow/challenge', { method: 'POST', body: '{}' });
    const challengeBytes = Buffer.from(challengeResult.data.challenge, 'base64url');
    let invalidNonce = 0n;
    while (hasLeadingZeroBits(
      modifiedSha256(challengeBytes, invalidNonce),
      challengeResult.data.difficulty
    )) invalidNonce++;
    const invalid = await request('/api/pow/verify', {
      method: 'POST',
      body: JSON.stringify({ id: challengeResult.data.id, nonce: invalidNonce.toString() }),
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.data.code).toBe('POW_INVALID');

    const replay = await request('/api/pow/verify', {
      method: 'POST',
      body: JSON.stringify({ id: challengeResult.data.id, nonce: invalidNonce.toString() }),
    });
    expect(replay.data.code).toBe('POW_CHALLENGE_EXPIRED');
  });
});
