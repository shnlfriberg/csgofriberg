import { randomUUID } from 'node:crypto';
import { redis, redisKey } from '../redis';

const local = new Map<string, { value: unknown; expiresAt: number }>();
const generations = new Map<string, string>();
const inFlight = new Map<string, { generation: string; promise: Promise<unknown> }>();
const publish = `if (redis.call('GET', KEYS[2]) or '') == ARGV[1] then
  return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end return nil`;
const invalidate = `redis.call('SET', KEYS[2], ARGV[1]); return redis.call('DEL', KEYS[1])`;

export async function cached<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const fullKey = redisKey(`cache:${key}`);
  const generationKey = `${fullKey}:generation`;
  const client = redis();
  let generation: string;
  if (client) {
    const [hit, version] = await client.mGet([fullKey, generationKey]);
    if (hit) return JSON.parse(hit) as T;
    generation = `redis:${version ?? ''}`;
  } else {
    const hit = local.get(fullKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
    generation = `local:${generations.get(fullKey) ?? ''}`;
  }
  const existing = inFlight.get(fullKey);
  if (existing?.generation === generation) return existing.promise as Promise<T>;
  const promise = Promise.resolve().then(loader).then(async value => {
    if (client) await client.eval(publish, {
      keys: [fullKey, generationKey], arguments: [generation.slice(6), JSON.stringify(value), String(ttlSeconds)],
    });
    else if (`local:${generations.get(fullKey) ?? ''}` === generation)
      local.set(fullKey, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return value;
  }).finally(() => {
    if (inFlight.get(fullKey)?.promise === promise) inFlight.delete(fullKey);
  });
  inFlight.set(fullKey, { generation, promise });
  return promise;
}

export async function invalidateCached(...keys: string[]): Promise<void> {
  const client = redis();
  const jobs = keys.map(key => {
    const fullKey = redisKey(`cache:${key}`);
    const version = randomUUID();
    generations.set(fullKey, version);
    local.delete(fullKey);
    return client?.eval(invalidate, { keys: [fullKey, `${fullKey}:generation`], arguments: [version] });
  });
  await Promise.all(jobs);
}
