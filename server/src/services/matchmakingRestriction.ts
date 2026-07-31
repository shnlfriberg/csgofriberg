import { db } from '../db/knex';
import { redisKey, redisState } from '../redis';

const CACHE_TTL_SECONDS = 300;

function restrictionKey(userId: number): string {
  return redisKey(`matchmaking-restriction:${userId}`);
}

export async function isMatchmakingRestricted(userId: number): Promise<boolean> {
  const client = redisState();
  if (client) {
    const cached = await client.get(restrictionKey(userId));
    if (cached === '1' || cached === '0') return cached === '1';
  }

  const user = await db('users').where({ id: userId }).first('matchmaking_restricted');
  const restricted = Boolean(user?.matchmaking_restricted);
  if (client && user) {
    await client.set(restrictionKey(userId), restricted ? '1' : '0', { EX: CACHE_TTL_SECONDS });
  }
  return restricted;
}

export async function cacheMatchmakingRestriction(
  userId: number,
  restricted: boolean
): Promise<void> {
  const client = redisState();
  if (!client) return;
  await client.set(restrictionKey(userId), restricted ? '1' : '0', { EX: CACHE_TTL_SECONDS });
}
