import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Request, Response } from 'express';
import { config } from '../config';
import { parseCookies } from '../middleware/auth';
import { redis, redisKey } from '../redis';

export const POW_COOKIE = 'csgofriberg_pow';
export const POW_ALGORITHM = 'csgofriberg-pow-v1';

const DOMAIN = Buffer.from(`${POW_ALGORITHM}\0`, 'ascii');
const MAX_TOKEN_CACHE = 10_000;
const MAX_FINGERPRINT_CACHE = 512;
const tokenCache = new Map<string, { access: PowAccess; fingerprint: string }>();
const fingerprintCache = new Map<string, string>();

interface StoredChallenge {
  challenge: string;
  difficulty: number;
  fingerprint: string;
  purpose?: PowPurpose;
}

export type PowPurpose = 'default' | 'register';

interface PowTokenPayload {
  typ: 'pow';
  fp: string;
  jti: string;
  difficulty: number;
  exp?: number;
}

export interface PowAccess {
  expiresAt: number;
  difficulty: number;
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/api',
    maxAge,
  };
}

export function browserFingerprint(
  userAgent: string | undefined,
  clientIp: string | undefined
): string {
  const key = `${userAgent || 'unknown'}\0${clientIp || 'unknown'}`;
  const cached = fingerprintCache.get(key);
  if (cached) return cached;
  const fingerprint = crypto
    .createHash('sha256')
    .update('csgofriberg-browser-v1\0', 'ascii')
    .update(key, 'utf8')
    .digest('base64url');
  if (fingerprintCache.size >= MAX_FINGERPRINT_CACHE) {
    fingerprintCache.delete(fingerprintCache.keys().next().value!);
  }
  fingerprintCache.set(key, fingerprint);
  return fingerprint;
}

function nonceBuffer(nonce: bigint): Buffer {
  const value = Buffer.allocUnsafe(8);
  value.writeBigUInt64LE(nonce);
  return value;
}

export function modifiedSha256(challenge: Buffer, nonce: bigint): Buffer {
  const first = crypto
    .createHash('sha256')
    .update(DOMAIN)
    .update(challenge)
    .update(nonceBuffer(nonce))
    .digest();
  const mixed = Buffer.allocUnsafe(32);
  for (let i = 0; i < 32; i++) {
    mixed[i] = first[(i + 11) & 31] ^ first[i] ^ ((i * 29 + 0x5d) & 0xff);
  }
  return crypto.createHash('sha256').update(DOMAIN).update(mixed).digest();
}

export function hasLeadingZeroBits(digest: Uint8Array, difficulty: number): boolean {
  const wholeBytes = Math.floor(difficulty / 8);
  for (let i = 0; i < wholeBytes; i++) if (digest[i] !== 0) return false;
  const remaining = difficulty & 7;
  return remaining === 0 || (digest[wholeBytes] & (0xff << (8 - remaining))) === 0;
}

export async function createChallenge(
  userAgent: string | undefined,
  clientIp: string | undefined,
  difficulty = config.powDifficulty,
  purpose: PowPurpose = 'default'
) {
  const client = redis();
  if (!client) throw new Error('REDIS_UNAVAILABLE');
  const id = crypto.randomUUID();
  const challenge = crypto.randomBytes(32).toString('base64url');
  const stored: StoredChallenge = {
    challenge,
    difficulty,
    fingerprint: browserFingerprint(userAgent, clientIp),
    purpose,
  };
  await client.set(redisKey(`pow:challenge:${id}`), JSON.stringify(stored), {
    EX: config.powChallengeTtlSeconds,
    NX: true,
  });
  return {
    id,
    challenge,
    difficulty: stored.difficulty,
    algorithm: POW_ALGORITHM,
    expiresIn: config.powChallengeTtlSeconds,
  };
}

export async function consumeAndVerifyChallenge(
  id: string,
  nonceText: string,
  userAgent: string | undefined,
  clientIp: string | undefined,
  expectedPurpose: PowPurpose = 'default'
): Promise<number> {
  const client = redis();
  if (!client) throw new Error('REDIS_UNAVAILABLE');
  const raw = await client.sendCommand([
    'GETDEL',
    redisKey(`pow:challenge:${id}`),
  ]) as string | null;
  if (!raw) throw new PowVerificationError('POW_CHALLENGE_EXPIRED');
  let stored: StoredChallenge;
  try {
    stored = JSON.parse(raw) as StoredChallenge;
  } catch {
    throw new PowVerificationError('POW_CHALLENGE_INVALID');
  }
  if (!Number.isInteger(stored.difficulty) || stored.difficulty < 16 || stored.difficulty > 24) {
    throw new PowVerificationError('POW_CHALLENGE_INVALID');
  }
  if ((stored.purpose ?? 'default') !== expectedPurpose) {
    throw new PowVerificationError('POW_CHALLENGE_INVALID');
  }
  if (stored.fingerprint !== browserFingerprint(userAgent, clientIp)) {
    throw new PowVerificationError('POW_FINGERPRINT_MISMATCH');
  }
  let nonce: bigint;
  try {
    nonce = BigInt(nonceText);
  } catch {
    throw new PowVerificationError('POW_INVALID');
  }
  if (nonce < 0n || nonce > 0xffffffffffffffffn) throw new PowVerificationError('POW_INVALID');
  const challenge = Buffer.from(stored.challenge, 'base64url');
  if (challenge.length !== 32 || !hasLeadingZeroBits(modifiedSha256(challenge, nonce), stored.difficulty)) {
    throw new PowVerificationError('POW_INVALID');
  }
  return stored.difficulty;
}

export function signPowCookie(
  res: Response,
  userAgent: string | undefined,
  clientIp: string | undefined,
  difficulty: number
): PowAccess {
  const token = jwt.sign(
    {
      typ: 'pow',
      fp: browserFingerprint(userAgent, clientIp),
      jti: crypto.randomUUID(),
      difficulty,
    } satisfies PowTokenPayload,
    config.jwtSecret,
    { expiresIn: config.powTokenTtlSeconds, algorithm: 'HS256' }
  );
  res.cookie(POW_COOKIE, token, cookieOptions(config.powTokenTtlSeconds * 1000));
  return { expiresAt: Date.now() + config.powTokenTtlSeconds * 1000, difficulty };
}

export function verifyPowCookie(
  cookieHeader: string | undefined,
  userAgent: string | undefined,
  clientIp: string | undefined
): PowAccess | null {
  const token = parseCookies(cookieHeader)[POW_COOKIE];
  if (!token) return null;
  const cached = tokenCache.get(token);
  if (cached) {
    if (
      cached.access.expiresAt > Date.now()
      && cached.fingerprint === browserFingerprint(userAgent, clientIp)
    ) {
      return cached.access;
    }
    tokenCache.delete(token);
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as PowTokenPayload;
    if (
      payload.typ !== 'pow' ||
      payload.fp !== browserFingerprint(userAgent, clientIp) ||
      !payload.jti ||
      !payload.exp ||
      payload.difficulty < 16 ||
      payload.difficulty > 24
    ) return null;
    const access = { expiresAt: payload.exp * 1000, difficulty: payload.difficulty };
    if (tokenCache.size >= MAX_TOKEN_CACHE) tokenCache.delete(tokenCache.keys().next().value!);
    tokenCache.set(token, { access, fingerprint: payload.fp });
    return access;
  } catch {
    return null;
  }
}

export function getRequestPow(req: Pick<Request, 'headers' | 'ip'>): PowAccess | null {
  return verifyPowCookie(req.headers.cookie, req.headers['user-agent'], req.ip);
}

export class PowVerificationError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
