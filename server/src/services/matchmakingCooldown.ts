import { evalStateScript, redisKey, redisState } from '../redis';
import { config } from '../config';

const WINDOW_MS = 30 * 60_000;
const MAX_LOCAL_ENTRIES = 10_000;
const local = new Map<string, { strikes: number; retryAt: number; expiresAt: number }>();

export interface MatchmakingCooldown {
  strikes: number;
  retryAt: number;
}

function cooldownSeconds(strikes: number, durationMultiplier: number): number {
  const fullSeconds = Math.min(120, Math.ceil(10 * Math.pow(1.5, Math.max(0, strikes - 1))));
  return Math.ceil(fullSeconds * durationMultiplier);
}

export function readyExitPenaltyMultiplier(averageGuesses: number | null): 0 | 0.5 | 1 {
  if (averageGuesses !== null && averageGuesses < 3.5) return 0;
  if (averageGuesses !== null && averageGuesses <= 4.5) return 0.5;
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
    const strikes = current && current.expiresAt > now ? current.strikes + 1 : 1;
    const retryAt = now + cooldownSeconds(strikes, durationMultiplier) * 1000;
    local.delete(identity);
    local.set(identity, { strikes, retryAt, expiresAt: now + WINDOW_MS });
    return { strikes, retryAt };
  }
  const result = await evalStateScript(
    'matchmaking-cooldown-record-v1',
    `local strikes = tonumber(redis.call('HGET', KEYS[1], 'strikes') or 0) + 1
     local fullSeconds = math.min(120, math.ceil(10 * (1.5 ^ math.max(0, strikes - 1))))
     local seconds = math.ceil(fullSeconds * tonumber(ARGV[3]))
     local retryAt = tonumber(ARGV[1]) + seconds * 1000
     redis.call('HSET', KEYS[1], 'strikes', tostring(strikes), 'retryAt', tostring(retryAt))
     redis.call('PEXPIRE', KEYS[1], ARGV[2])
     return { strikes, retryAt }`,
    [redisKey(`matchmaking-cooldown:${identity}`)],
    [String(now), String(WINDOW_MS), String(durationMultiplier)]
  ) as [number | string, number | string];
  return { strikes: Number(result[0]), retryAt: Number(result[1]) };
}

export async function clearMatchmakingCooldown(identity: string): Promise<void> {
  local.delete(identity);
  const client = redisState();
  if (!client && config.redisRequired) throw new Error('REDIS_UNAVAILABLE');
  if (client) await client.del(redisKey(`matchmaking-cooldown:${identity}`));
}
