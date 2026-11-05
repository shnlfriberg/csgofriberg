import { evalCommandScript, redisKey } from '../redis';
import type { SingleGameState } from './singleGameStore';

export const singlePresenceKey = (id: string) => redisKey(`single:presence:${id}`);
export function singlePresenceCategory(game: Pick<SingleGameState, 'kind' | 'variant' | 'soup'>): string {
  if (game.variant === 'turtle-soup')
    return game.soup && game.soup.status !== 'playing' ? 'inactive' : 'turtleSoup';
  return game.kind === 'daily' ? 'classicDaily' : 'classicSingle';
}

// Normal reads transfer only short category strings, never the full game/receipt
// payload. Old games are projected once with their remaining TTL, atomically.
export async function singlePresenceCategories(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  return await evalCommandScript('single-presence-categories-v1', `
    local result = {}
    for i = 1, #KEYS, 2 do
      local category = redis.call('GET', KEYS[i])
      if not category then
        local raw = redis.call('GET', KEYS[i + 1])
        if raw then
          local ok, game = pcall(cjson.decode, raw)
          if ok and type(game) == 'table' then
            category = game.kind == 'daily' and 'classicDaily' or 'classicSingle'
            if game.variant == 'turtle-soup' then
              category = 'turtleSoup'
              if type(game.soup) == 'table' and game.soup.status ~= 'playing' then category = 'inactive' end
            end
            local ttl = redis.call('PTTL', KEYS[i + 1])
            if ttl > 0 then redis.call('SET', KEYS[i], category, 'PX', ttl) end
          end
        end
      end
      result[#result + 1] = category or 'inactive'
    end
    return result`, ids.flatMap(id => [singlePresenceKey(id), redisKey(`single:game:${id}`)]), []) as string[];
}
