import { Request, Response, NextFunction } from 'express';
import { evalCommandScript, redis, redisKey } from '../redis';

interface RateLimitOptions {
  name: string;
  limit: number;
  windowSeconds: number;
  key?: (req: Request) => string;
  failClosed?: boolean;
}

const localCounters = new Map<string, { count: number; expiresAt: number }>();
const HASH_RATE_LIMIT_SCRIPT = `local count = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
if count == 1 then
  redis.call('HEXPIRE', KEYS[1], ARGV[2], 'FIELDS', '1', ARGV[1])
end
return count`;

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
