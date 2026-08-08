import crypto from 'crypto';
import { db } from '../db/knex';
import { redis, redisKey } from '../redis';

function hashGuestKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export async function recordGuestSeen(key: string, displayId: string): Promise<void> {
  const hash = hashGuestKey(key);
  const cache = redis();
  if (cache) {
    const seen = await cache.get(redisKey(`guest-seen:${hash}`)).catch(() => null);
    if (seen !== null) return;
  }
  await db('guest_accounts')
    .insert({ guest_key: key, guest_key_hash: hash, display_id: displayId, last_seen_at: db.fn.now() })
    .onConflict('guest_key_hash')
    .merge({ guest_key: key, display_id: displayId, last_seen_at: db.fn.now() });
  if (cache) await cache.set(redisKey(`guest-seen:${hash}`), '1', { EX: 3600 }).catch(() => undefined);
}

export async function isGuestBanned(key: string): Promise<boolean> {
  const cache = redis();
  const cacheKey = redisKey(`guest-ban:${hashGuestKey(key)}`);
  if (cache) {
    const cached = await cache.get(cacheKey).catch(() => null);
    if (cached !== null) return cached === '1';
  }
  const row = await db('guest_accounts').where({ guest_key_hash: hashGuestKey(key) }).first('banned_at');
  const banned = Boolean(row?.banned_at);
  if (cache) await cache.set(cacheKey, banned ? '1' : '0', { EX: 60 }).catch(() => undefined);
  return banned;
}

export async function setGuestBanned(key: string, displayId: string, banned: boolean): Promise<void> {
  await recordGuestSeen(key, displayId);
  await db('guest_accounts').where({ guest_key_hash: hashGuestKey(key) }).update({ banned_at: banned ? db.fn.now() : null });
  const cache = redis();
  if (cache) await cache.del(redisKey(`guest-ban:${hashGuestKey(key)}`)).catch(() => undefined);
}

export { hashGuestKey };
