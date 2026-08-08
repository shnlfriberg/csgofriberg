import { evalStateScript, redisKey, redisState } from '../redis';
import { config } from '../config';

const WINDOW_MS = 30 * 60_000;
const MAX_LOCAL_ENTRIES = 10_000;
const FIRST_COOLDOWN_SECONDS = 20;
const local = new Map<string, {
  strikes: number;
  seconds: number;
  retryAt: number;
  expiresAt: number;
}>();

export interface MatchmakingCooldown {
  strikes: number;
  retryAt: number;
}

function nextCooldownSeconds(currentSeconds: number, durationMultiplier: number): number {
  const fullSeconds = currentSeconds > 0 ? currentSeconds * 2 : FIRST_COOLDOWN_SECONDS;
  return Math.max(1, Math.ceil(fullSeconds * durationMultiplier));
}

function reducedCooldownSeconds(currentSeconds: number): number {
  return Math.max(1, Math.ceil(currentSeconds / 2));
}

function ttlFor(retryAt: number, now: number): number {
  return Math.max(WINDOW_MS, retryAt - now + WINDOW_MS);
}

export function readyExitPenaltyMultiplier(averageGuesses: number | null): 0 | 0.5 | 1 {
  if (averageGuesses !== null && averageGuesses < 3) return 0;
  if (averageGuesses !== null && averageGuesses <= 4) return 0.5;
  return 1;
}

function pruneLocal(now: number): void {
  for (const [key, value] of local) {
    if (value.expiresAt <= now) local.delete(key);
  }
  while (local.size >= MAX_LOCAL_ENTRIES) {
    const oldest = local.keys().next().value as string | undefined;
    if (!oldest) break;
    local.delete(oldest);
  }
}

export async function getMatchmakingCooldown(identity: string): Promise<MatchmakingCooldown | null> {
  const now = Date.now();
  const client = redisState();
  if (!client && config.redisRequired) throw new Error('REDIS_UNAVAILABLE');
  if (!client) {
    const value = local.get(identity);
    if (!value || value.expiresAt <= now) {
      local.delete(identity);
      return null;
    }
    return value.retryAt > now ? { strikes: value.strikes, retryAt: value.retryAt } : null;
  }
  const values = await client.hmGet(redisKey(`matchmaking-cooldown:${identity}`), [
    'strikes',
    'retryAt',
  ]);
  const strikes = Number(values[0]);
  const retryAt = Number(values[1]);
  return Number.isInteger(strikes) && strikes > 0 && retryAt > now
    ? { strikes, retryAt }
    : null;
}

export async function recordMatchmakingExit(
  identity: string,
  durationMultiplier: 0.5 | 1 = 1
): Promise<MatchmakingCooldown> {
  const now = Date.now();
  const client = redisState();
  if (!client && config.redisRequired) throw new Error('REDIS_UNAVAILABLE');
  if (!client) {
    pruneLocal(now);
    const current = local.get(identity);
    const validCurrent = current && current.expiresAt > now ? current : null;
    const strikes = validCurrent ? validCurrent.strikes + 1 : 1;
    const seconds = nextCooldownSeconds(validCurrent?.seconds ?? 0, durationMultiplier);
    const retryAt = now + seconds * 1000;
    local.delete(identity);
    local.set(identity, { strikes, seconds, retryAt, expiresAt: now + ttlFor(retryAt, now) });
    return { strikes, retryAt };
  }
  const result = await evalStateScript(
    'matchmaking-cooldown-record-v2',
    `local strikes = tonumber(redis.call('HGET', KEYS[1], 'strikes') or 0) + 1
     local currentSeconds = tonumber(redis.call('HGET', KEYS[1], 'seconds') or 0)
     local fullSeconds = tonumber(ARGV[4])
     if currentSeconds > 0 then fullSeconds = currentSeconds * 2 end
     local seconds = math.max(1, math.ceil(fullSeconds * tonumber(ARGV[3])))
     local retryAt = tonumber(ARGV[1]) + seconds * 1000
     local ttl = math.max(tonumber(ARGV[2]), retryAt - tonumber(ARGV[1]) + tonumber(ARGV[2]))
     redis.call('HSET', KEYS[1], 'strikes', tostring(strikes), 'seconds', tostring(seconds), 'retryAt', tostring(retryAt))
     redis.call('PEXPIRE', KEYS[1], ttl)
     return { strikes, retryAt }`,
    [redisKey(`matchmaking-cooldown:${identity}`)],
    [String(now), String(WINDOW_MS), String(durationMultiplier), String(FIRST_COOLDOWN_SECONDS)]
  ) as [number | string, number | string];
  return { strikes: Number(result[0]), retryAt: Number(result[1]) };
}

export async function reduceMatchmakingCooldown(identity: string): Promise<void> {
  const now = Date.now();
  const client = redisState();
  if (!client && config.redisRequired) throw new Error('REDIS_UNAVAILABLE');
  if (!client) {
    pruneLocal(now);
    const current = local.get(identity);
    if (!current || current.expiresAt <= now) {
      local.delete(identity);
      return;
    }
    local.set(identity, {
      strikes: current.strikes,
      seconds: reducedCooldownSeconds(current.seconds),
      retryAt: now,
      expiresAt: now + WINDOW_MS,
    });
    return;
  }
  await evalStateScript(
    'matchmaking-cooldown-reduce-v1',
    `local seconds = tonumber(redis.call('HGET', KEYS[1], 'seconds') or 0)
     if seconds <= 0 then return 0 end
     local reduced = math.max(1, math.ceil(seconds / 2))
     redis.call('HSET', KEYS[1], 'seconds', tostring(reduced), 'retryAt', ARGV[1])
     redis.call('PEXPIRE', KEYS[1], ARGV[2])
     return 1`,
    [redisKey(`matchmaking-cooldown:${identity}`)],
    [String(now), String(WINDOW_MS)]
  );
}

export async function clearMatchmakingCooldown(identity: string): Promise<void> {
  local.delete(identity);
  const client = redisState();
  if (!client && config.redisRequired) throw new Error('REDIS_UNAVAILABLE');
  if (client) await client.del(redisKey(`matchmaking-cooldown:${identity}`));
}
