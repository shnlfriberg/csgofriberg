import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { redis, redisKey } from '../redis';
import { HttpError } from '../middleware/common';

const configured = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
export const storageLimits = {
  assets: configured('LOCATION_ASSET_MAX_BYTES', 20 * 1024 ** 3),
  stages: configured('LOCATION_STAGE_MAX_BYTES', 8 * 1024 ** 3),
  ownerStages: configured('LOCATION_OWNER_STAGE_MAX_BYTES', 4 * 1024 ** 3),
  hourlyInput: configured('LOCATION_UPLOAD_HOURLY_BYTES', 128 * 1024 ** 2),
  minimumFree: configured('LOCATION_UPLOAD_MIN_FREE_BYTES', 256 * 1024 ** 2),
};
const local = new Map<string, { bytes: number; until: number }>();

export async function directoryBytes(directory: string, recursive = false): Promise<number> {
  let total = 0;
  let entries;
  try { entries = await fs.opendir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  for await (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isFile()) total += (await fs.stat(filename)).size;
    else if (recursive && entry.isDirectory()) total += await directoryBytes(filename, true);
  }
  return total;
}

/** Caller holds the shared storage/staging lease across checking and writes. */
export async function assertStorageRoom(directory: string, incoming: number, limit: number, recursive = false): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const [used, stat] = await Promise.all([directoryBytes(directory, recursive), fs.statfs(directory)]);
  if (used + incoming > limit || stat.bavail * stat.bsize < incoming + storageLimits.minimumFree)
    throw new HttpError(429, 'LOCATION_STORAGE_LIMIT');
}

/** Charge raw input before decoding. Failed image work also consumes this budget. */
export async function chargeImageInput(owner: string, bytes: number): Promise<void> {
  const client = redis();
  if (client) {
    const allowed = await client.eval(`local used = tonumber(redis.call('GET', KEYS[1]) or 0)
      if used + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return 0 end
      redis.call('INCRBY', KEYS[1], ARGV[1])
      if used == 0 then redis.call('EXPIRE', KEYS[1], 3600) end
      return 1`, { keys: [redisKey(`location:upload-bytes:${owner}`)], arguments: [String(bytes), String(storageLimits.hourlyInput)] });
    if (Number(allowed) !== 1) throw new HttpError(429, 'LOCATION_UPLOAD_LIMIT');
    return;
  }
  if (config.redisRequired) throw new Error('REDIS_UNAVAILABLE');
  const now = Date.now();
  if (local.size >= 10_000) for (const [key, item] of local) if (item.until <= now) local.delete(key);
  const previous = local.get(owner);
  const item = previous && previous.until > now ? previous : { bytes: 0, until: now + 3600_000 };
  if ((!previous && local.size >= 10_000) || item.bytes + bytes > storageLimits.hourlyInput)
    throw new HttpError(429, 'LOCATION_UPLOAD_LIMIT');
  item.bytes += bytes; local.set(owner, item);
}
