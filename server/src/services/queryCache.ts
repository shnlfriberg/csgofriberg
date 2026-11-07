import { randomUUID } from 'node:crypto';
import { evalCommandScript, redis, redisKey } from '../redis';

const MAX_LOCAL_ENTRIES = 10_000;
export const CACHE_GENERATION_TTL_SECONDS = 600;
const local = new Map<string, { value: unknown; expiresAt: number }>();
const generations = new Map<string, { version: string; expiresAt: number }>();
const inFlight = new Map<string, { generation: string; promise: Promise<unknown> }>();

// Capture a nonempty random fence BEFORE reading SQL. Expiry/eviction can
// never make an old loader match a missing fence or a newly created one.
const read = `local generation = redis.call('GET', KEYS[2])
if not generation then
  generation = ARGV[1]
  redis.call('SET', KEYS[2], generation, 'EX', ARGV[2])
elseif redis.call('TTL', KEYS[2]) == -1 then
  redis.call('EXPIRE', KEYS[2], ARGV[2])
end
return {redis.call('GET', KEYS[1]) or false, generation}`;
const publish = `if redis.call('GET', KEYS[2]) == ARGV[1] then
  redis.call('EXPIRE', KEYS[2], ARGV[4])
  return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end return nil`;
const invalidate = `redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2]); return redis.call('DEL', KEYS[1])`;

function bound<T>(map: Map<string, T>): void {
  while (map.size > MAX_LOCAL_ENTRIES) map.delete(map.keys().next().value!);
}
function localGeneration(key: string): string {
  let fence = generations.get(key);
  if (!fence || fence.expiresAt <= Date.now()) {
    fence = { version: randomUUID(), expiresAt: Date.now() + CACHE_GENERATION_TTL_SECONDS * 1000 };
    generations.delete(key); generations.set(key, fence); bound(generations);
  }
  return fence.version;
}

export async function cached<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  return cachedAt(redisKey(`cache:${key}`), ttlSeconds, loader);
}

async function cachedAt<T>(fullKey: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const generationKey = `${fullKey}:generation`;
  const client = redis();
  const fenceTtl = Math.max(CACHE_GENERATION_TTL_SECONDS, ttlSeconds + 1);
  let generation: string;
  if (client) {
    const [hit, version] = await evalCommandScript('query-cache-read-v2', read,
      [fullKey, generationKey], [randomUUID(), String(fenceTtl)]) as [string | null, string];
    if (hit !== null) return JSON.parse(String(hit)) as T;
    generation = `redis:${version}`;
  } else {
    const hit = local.get(fullKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    local.delete(fullKey);
    generation = `local:${localGeneration(fullKey)}`;
  }
  const existing = inFlight.get(fullKey);
  if (existing?.generation === generation) return existing.promise as Promise<T>;
  if (!existing && inFlight.size >= MAX_LOCAL_ENTRIES) return loader();
  const promise = Promise.resolve().then(loader).then(async value => {
    if (client) await evalCommandScript('query-cache-publish-v2', publish,
      [fullKey, generationKey], [generation.slice(6), JSON.stringify(value), String(ttlSeconds), String(fenceTtl)]);
    else if (generations.get(fullKey)?.version === generation.slice(6) && generations.get(fullKey)!.expiresAt > Date.now()) {
      local.set(fullKey, { value, expiresAt: Date.now() + ttlSeconds * 1000 }); bound(local);
    }
    return value;
  }).finally(() => {
    if (inFlight.get(fullKey)?.promise === promise) inFlight.delete(fullKey);
  });
  inFlight.set(fullKey, { generation, promise });
  return promise;
}

export async function invalidateCacheAt(...fullKeys: string[]): Promise<void> {
  const client = redis();
  await Promise.all(fullKeys.map(fullKey => {
    const version = randomUUID();
    local.delete(fullKey); generations.delete(fullKey);
    if (!client) {
      generations.set(fullKey, { version, expiresAt: Date.now() + CACHE_GENERATION_TTL_SECONDS * 1000 }); bound(generations);
    }
    return client ? evalCommandScript('query-cache-invalidate-v2', invalidate,
      [fullKey, `${fullKey}:generation`], [version, String(CACHE_GENERATION_TTL_SECONDS)]) : undefined;
  }));
}

export async function invalidateCached(...keys: string[]): Promise<void> {
  await invalidateCacheAt(...keys.map(key => redisKey(`cache:${key}`)));
}

let cleanupCursor = '0';
/** Bounded legacy metadata cleanup; no game/identity-state keys are scanned. */
export async function expireLegacyCacheGenerations(): Promise<void> {
  const now = Date.now();
  for (const [key, entry] of local) if (entry.expiresAt <= now) local.delete(key);
  for (const [key, entry] of generations) if (entry.expiresAt <= now) generations.delete(key);
  const client = redis();
  if (!client) return;
  const page = await client.scan(cleanupCursor, { MATCH: redisKey('cache:*:generation'), COUNT: 100 });
  cleanupCursor = String(page.cursor);
  for (const key of page.keys) await client.eval(
    `if redis.call('TTL', KEYS[1]) == -1 then return redis.call('EXPIRE', KEYS[1], ARGV[1]) end return 0`,
    { keys: [key], arguments: [String(CACHE_GENERATION_TTL_SECONDS)] }
  );
}
