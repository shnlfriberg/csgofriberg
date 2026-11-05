import { evalCommandScript, redis, redisKey } from '../redis';
import { db } from '../db/knex';
import { cached } from './queryCache';
import { ensureLocationPresenceIndex, locationPresenceKey } from './locationPresence';
import { singlePresenceCategories } from './singleGamePresence';

export const ONLINE_STALE_MS = 150_000;

export interface PresenceStats {
  onlineUsers: number;
  multiplayerRooms: number;
  singleGames: number;
  modes: PresenceModes;
  updatedAt: number;
}

export interface PresenceModes {
  classicSingle: number;
  classicDaily: number;
  turtleSoup: number;
  classicRooms: number;
  relayRooms: number;
  relay2v2Rooms: number;
  locationDaily: number;
  locationRandom: number;
  locationRooms: number;
  cardSingle: number;
  cardDaily: number;
  cardFriend: number;
  cardRanked: number;
}

export async function cleanupPresence(): Promise<number[]> {
  const client = redis();
  if (!client) throw new Error('REDIS_UNAVAILABLE');
  const now = Date.now();
  return await evalCommandScript(
    'presence-stats-v2',
    `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
     redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[2])
     redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[2])
     redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', ARGV[2])
     redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', ARGV[2])
     return {
       redis.call('ZCARD', KEYS[1]),
       redis.call('ZCARD', KEYS[2]),
       redis.call('ZCARD', KEYS[3])
     }`,
    [
      redisKey('presence:online'),
      redisKey('presence:rooms'),
      redisKey('presence:single'),
      locationPresenceKey('daily'),
      locationPresenceKey('random'),
    ],
    [String(now - ONLINE_STALE_MS), String(now)]
  ) as number[];
}

async function readModes(): Promise<PresenceModes> {
  const client = redis();
  if (!client) throw new Error('REDIS_UNAVAILABLE');
  await ensureLocationPresenceIndex();
  const now = Date.now();
  const counts: PresenceModes = {
    classicSingle: 0, classicDaily: 0, turtleSoup: 0,
    classicRooms: 0, relayRooms: 0, relay2v2Rooms: 0,
    locationDaily: 0, locationRandom: 0, locationRooms: 0,
    cardSingle: 0, cardDaily: 0, cardFriend: 0, cardRanked: 0,
  };
  const [singles, rooms, locationRooms, cards] = await Promise.all([
    client.zRangeByScore(redisKey('presence:single'), now + 1, '+inf'),
    client.zRangeByScore(redisKey('presence:rooms'), now + 1, '+inf'),
    client.zRange(redisKey('location:rooms'), 0, -1),
    db('card_matches').whereIn('status', ['waiting', 'preparing', 'playing', 'roundOver'])
      .select('scene').count<Array<{ scene: string; count: number | string }>>({ count: '*' }).groupBy('scene'),
  ]);
  // Bounded batches over active indexes only. Never load historical matches or a
  // full card payload just to count it; share this snapshot across admins/instances.
  for (let offset = 0; offset < singles.length; offset += 100) {
    const categories = await singlePresenceCategories(singles.slice(offset, offset + 100));
    for (const category of categories)
      if (category === 'turtleSoup' || category === 'classicDaily' || category === 'classicSingle') counts[category]++;
  }
  for (let offset = 0; offset < rooms.length; offset += 100) {
    const ids = rooms.slice(offset, offset + 100);
    const metadata = await Promise.all(ids.map(id => client.hmGet(redisKey(`room:${id}:meta`), ['status', 'gameMode'])));
    for (let i = 0; i < metadata.length; i++) {
      let [status, mode] = metadata[i];
      if (!status) {
        const raw = await client.get(redisKey(`room:${ids[i]}`));
        if (!raw) continue;
        try {
          const room = JSON.parse(raw);
          status = room?.status; mode = room?.gameMode;
        } catch { continue; } // A corrupt legacy room must not blank all counters.
      }
      if (!status || !['waiting', 'starting', 'playing', 'round_over'].includes(status)) continue;
      counts[mode === 'relay' ? 'relayRooms' : mode === 'relay2v2' ? 'relay2v2Rooms' : 'classicRooms']++;
    }
  }
  for (let offset = 0; offset < locationRooms.length; offset += 100) {
    // These scores are maintenance times, NOT expiry times.
    const existing = await Promise.all(locationRooms.slice(offset, offset + 100).map(id => client.exists(redisKey(`location:room:${id}`))));
    counts.locationRooms += existing.filter(Boolean).length;
  }
  const locationCounts = await evalCommandScript('presence-location-count-v1', `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
    redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
    return {redis.call('ZCARD', KEYS[1]), redis.call('ZCARD', KEYS[2])}`,
  [locationPresenceKey('daily'), locationPresenceKey('random')], [String(now)]) as number[];
  [counts.locationDaily, counts.locationRandom] = locationCounts.map(Number);
  const scenes = { practice: 'cardSingle', daily: 'cardDaily', friend: 'cardFriend', ranked: 'cardRanked' } as const;
  for (const row of cards) {
    const key = scenes[row.scene as keyof typeof scenes];
    if (key) counts[key] = Number(row.count);
  }
  return counts;
}

export async function getPresenceStats(): Promise<PresenceStats> {
  const [result, modes] = await Promise.all([cleanupPresence(), cached('presence:modes:v1', 5, readModes)]);
  return {
    onlineUsers: Number(result[0] ?? 0),
    // Retain the legacy fields for older clients.
    multiplayerRooms: Number(result[1] ?? 0),
    singleGames: Number(result[2] ?? 0),
    modes,
    updatedAt: Date.now(),
  };
}
