import { evalCommandScript, redis, redisKey } from '../redis';

export const locationPresenceKey = (mode: 'daily' | 'random') => redisKey(`presence:location:${mode}`);

// One compatibility pass over retained games, not a scan on every dashboard poll.
// Read and project each batch atomically so a concurrent finish cannot resurrect it.
export async function ensureLocationPresenceIndex(): Promise<void> {
  const client = redis();
  if (!client) throw new Error('REDIS_UNAVAILABLE');
  const marker = redisKey('presence:location:index-v1');
  if (await client.exists(marker)) return;
  for await (const keys of client.scanIterator({ MATCH: redisKey('location:game:*'), COUNT: 100 })) {
    if (!keys.length) continue;
    await evalCommandScript('presence-location-backfill-v2', `
      for i = 3, #KEYS do
        local raw = redis.call('GET', KEYS[i])
        if raw then
          local ok, game = pcall(cjson.decode, raw)
          if ok and type(game) == 'table' and type(game.id) == 'string'
            and (game.mode == 'daily' or game.mode == 'random') then
            local target = game.mode == 'daily' and KEYS[1] or KEYS[2]
            local expiresAt = tonumber(game.expiresAt)
            if (game.status == 'playing' or game.status == 'ready')
              and expiresAt and expiresAt > tonumber(ARGV[1]) then
              redis.call('ZADD', target, expiresAt, game.id)
            else redis.call('ZREM', target, game.id) end
          end
        end
      end
      return 1`, [locationPresenceKey('daily'), locationPresenceKey('random'), ...keys], [String(Date.now())]);
  }
  await client.set(marker, '1');
}
