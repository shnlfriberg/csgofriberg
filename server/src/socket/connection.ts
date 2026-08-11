import { isIP } from 'net';
import { Socket } from 'socket.io';
import { consumeRateLimit } from '../middleware/rateLimit';
import { evalCommandScript, redis, redisKey } from '../redis';
import { ONLINE_STALE_MS } from '../services/presence';

const MAX_CONNECTIONS_PER_IDENTITY = 3;
const MAX_CONNECTIONS_PER_IP = 20;
const LOCAL_GUESS_LIMIT = 12;
const LOCAL_GUESS_WINDOW_MS = 10_000;
const localGuessBuckets = new Map<string, { count: number; expiresAt: number }>();

export function allowLocalGuess(identity: string): boolean {
  const now = Date.now();
  const current = localGuessBuckets.get(identity);
  if (!current || current.expiresAt <= now) {
    if (localGuessBuckets.size >= 10_000) {
      for (const [key, bucket] of localGuessBuckets) {
        if (bucket.expiresAt <= now) localGuessBuckets.delete(key);
      }
    }
    localGuessBuckets.set(identity, { count: 1, expiresAt: now + LOCAL_GUESS_WINDOW_MS });
    return true;
  }
  if (current.count >= LOCAL_GUESS_LIMIT) return false;
  current.count += 1;
  return true;
}

function validForwardedIp(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : null;
}

/** Match Express `trust proxy = 1`: trust only the address appended by the nearest proxy. */
export function resolveSocketIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  realIp: string | string[] | undefined,
  trustProxy: boolean
): string {
  if (trustProxy) {
    const forwarded = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const nearestForwarded = forwarded?.split(',').at(-1);
    const fromForwarded = validForwardedIp(nearestForwarded);
    if (fromForwarded) return fromForwarded;

    const real = Array.isArray(realIp) ? realIp.at(-1) : realIp;
    const fromRealIp = validForwardedIp(real);
    if (fromRealIp) return fromRealIp;
  }
  return validForwardedIp(remoteAddress) ?? 'unknown';
}

export async function socketAllowed(
  event: string,
  identity: string,
  limit: number,
  seconds: number
): Promise<boolean> {
  return consumeRateLimit(`socket:${event}`, identity, limit, seconds);
}

export async function socketAllowedWithIp(
  socket: Socket,
  event: string,
  identity: string,
  identityLimit: number,
  ipLimit: number,
  seconds: number
): Promise<boolean> {
  if (!(await socketAllowed(event, identity, identityLimit, seconds))) return false;
  return consumeRateLimit(`socket:${event}:ip`, String(socket.data.ip), ipLimit, seconds);
}

export async function acquireConnectionSlot(
  ip: string,
  identity: string,
  socketId: string
): Promise<boolean> {
  const client = redis();
  if (!client) return true;
  const result = await evalCommandScript(
    'connection-slot-acquire-v1',
    `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
     redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
     local ipCount = redis.call('ZCARD', KEYS[1])
     local identityCount = redis.call('ZCARD', KEYS[2])
     if ipCount >= tonumber(ARGV[2]) or identityCount >= tonumber(ARGV[3]) then return 0 end
     redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
     redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
     redis.call('ZADD', KEYS[3], ARGV[4], ARGV[6])
     redis.call('SET', KEYS[4], '1', 'EX', 180)
     redis.call('expire', KEYS[1], 900); redis.call('expire', KEYS[2], 900)
     return 1`,
    [
      redisKey(`connections:ip:${ip}`),
      redisKey(`connections:identity:${identity}`),
      redisKey('presence:online'),
      redisKey(`connections:socket:${socketId}`),
    ],
    [
      String(Date.now() - ONLINE_STALE_MS),
      String(MAX_CONNECTIONS_PER_IP),
      String(MAX_CONNECTIONS_PER_IDENTITY),
      String(Date.now()),
      socketId,
      identity,
    ]
  );
  return Number(result) === 1;
}

export async function releaseConnectionSlot(
  ip: string,
  identity: string,
  socketId: string
): Promise<void> {
  const client = redis();
  if (!client) return;
  await evalCommandScript(
    'connection-slot-release-v1',
    `redis.call('ZREM', KEYS[1], ARGV[1])
     redis.call('ZREM', KEYS[2], ARGV[1])
     redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
     redis.call('DEL', KEYS[4])
     if redis.call('ZCARD', KEYS[2]) == 0 then
       redis.call('ZREM', KEYS[3], ARGV[2])
     else
       redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
     end
     return 1`,
    [
      redisKey(`connections:ip:${ip}`),
      redisKey(`connections:identity:${identity}`),
      redisKey('presence:online'),
      redisKey(`connections:socket:${socketId}`),
    ],
    [
      socketId,
      identity,
      String(Date.now() - ONLINE_STALE_MS),
      String(Date.now()),
    ]
  );
}

export async function refreshConnectionSlots(
  entries: { ip: string; identity: string; socketId: string }[]
): Promise<void> {
  if (!entries.length) return;
  const client = redis();
  if (!client) return;
  const now = Date.now();
  await evalCommandScript(
    'connection-slot-refresh-v1',
    `for index = 2, #ARGV, 3 do
       local ip = ARGV[index]
       local identity = ARGV[index + 1]
       local socketId = ARGV[index + 2]
       local ipKey = KEYS[2] .. ip
       local identityKey = KEYS[3] .. identity
       redis.call('ZADD', ipKey, ARGV[1], socketId)
       redis.call('ZADD', identityKey, ARGV[1], socketId)
       redis.call('ZADD', KEYS[1], ARGV[1], identity)
       redis.call('SET', KEYS[4] .. socketId, '1', 'EX', 180)
       redis.call('EXPIRE', ipKey, 900)
       redis.call('EXPIRE', identityKey, 900)
     end
     return #ARGV`,
    [
      redisKey('presence:online'),
      redisKey('connections:ip:'),
      redisKey('connections:identity:'),
      redisKey('connections:socket:'),
    ],
    [
      String(now),
      ...entries.flatMap((entry) => [entry.ip, entry.identity, entry.socketId]),
    ]
  );
}
