import { Request, Response, NextFunction } from 'express';
import { evalCommandScript, redis, redisKey } from '../redis';

interface RateLimitOptions {
  name: string;
  limit: number;
  windowSeconds: number;
  key?: (req: Request) => string;
  failClosed?: boolean;
}

const HASH_RATE_LIMIT_RESERVE_SCRIPT = [
  "local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or 0)",
  "if current >= tonumber(ARGV[2]) then return 0 end",
  "local count = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)",
  "if count == 1 then",
  "  redis.call('HEXPIRE', KEYS[1], ARGV[3], 'FIELDS', '1', ARGV[1])",
  "end",
  "return 1",
].join('\n');
const HASH_RATE_LIMIT_RELEASE_SCRIPT = [
  "local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or 0)",
  "if current <= 1 then",
  "  redis.call('HDEL', KEYS[1], ARGV[1])",
  "else",
  "  redis.call('HINCRBY', KEYS[1], ARGV[1], -1)",
  "end",
  "return 1",
].join('\n');
const localCounters = new Map<string, { count: number; expiresAt: number }>();
const HASH_RATE_LIMIT_SCRIPT = `local count = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
if count == 1 then
  redis.call('HEXPIRE', KEYS[1], ARGV[2], 'FIELDS', '1', ARGV[1])
end
return count`;

export interface RateLimitReservation {
  backend: 'redis' | 'local';
  key: string;
  identity: string;
  localKey: string;
}

export async function consumeRateLimit(
  name: string,
  identity: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = redisKey(`rl:${name}:${bucket}`);
  const localKey = `${key}:${identity}`;
  const client = redis();
  if (client) {
    const count = Number(await evalCommandScript(
      'rate-limit-hexpire-v1',
      HASH_RATE_LIMIT_SCRIPT,
      [key],
      [identity, String(windowSeconds + 1)]
    ));
    return count <= limit;
  }
  const now = Date.now();
  const current = localCounters.get(localKey);
  const item = !current || current.expiresAt <= now
    ? { count: 1, expiresAt: now + windowSeconds * 1000 }
    : { count: current.count + 1, expiresAt: current.expiresAt };
  localCounters.set(localKey, item);
  return item.count <= limit;
}

export async function reserveRateLimit(
  name: string,
  identity: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitReservation | null> {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = redisKey(`rl:${name}:${bucket}`);
  const localKey = `${key}:${identity}`;
  const client = redis();
  if (client) {
    const acquired = Number(await evalCommandScript(
      'rate-limit-reserve-v1',
      HASH_RATE_LIMIT_RESERVE_SCRIPT,
      [key],
      [identity, String(limit), String(windowSeconds + 1)]
    ));
    return acquired === 1 ? { backend: 'redis', key, identity, localKey } : null;
  }
  const now = Date.now();
  const current = localCounters.get(localKey);
  if (current && current.expiresAt > now && current.count >= limit) return null;
  const item = !current || current.expiresAt <= now
    ? { count: 1, expiresAt: now + windowSeconds * 1000 }
    : { count: current.count + 1, expiresAt: current.expiresAt };
  localCounters.set(localKey, item);
  return { backend: 'local', key, identity, localKey };
}

export async function releaseRateLimit(reservation: RateLimitReservation): Promise<void> {
  const client = redis();
  if (reservation.backend === 'redis') {
    if (!client) return;
    await evalCommandScript(
      'rate-limit-release-v1',
      HASH_RATE_LIMIT_RELEASE_SCRIPT,
      [reservation.key],
      [reservation.identity]
    );
    return;
  }
  const current = localCounters.get(reservation.localKey);
  if (!current) return;
  if (current.count <= 1) localCounters.delete(reservation.localKey);
  else localCounters.set(reservation.localKey, { ...current, count: current.count - 1 });
}

export function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/** Prefer an authenticated/guest identity so users behind one NAT do not share a bucket. */
export function requestIdentity(req: Request): string {
  if (req.user) return `u:${req.user.id}`;
  if (req.guestKey) return `g:${req.guestKey}`;
  return requestIp(req);
}

export function rateLimit(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const identity = options.key?.(req) || requestIp(req);
    try {
      if (!(await consumeRateLimit(
        options.name,
        identity,
        options.limit,
        options.windowSeconds
      ))) {
        return res.status(429).json({ code: 'RATE_LIMITED' });
      }
      next();
    } catch (err) {
      if (options.failClosed) return res.status(503).json({ code: 'RATE_LIMIT_UNAVAILABLE' });
      next();
    }
  };
}
