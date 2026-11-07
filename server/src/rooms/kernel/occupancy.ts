import type { GameId, OccupancyRef } from './protocol';
import { countKernel } from './metrics';
import { getRoomAdapter } from './registry';
import { kernelKey, kernelRedis, kernelScript } from './state';

/**
 * Site-wide multiplayer occupancy.
 *
 * Every game shares the classic `identity-room:<identity>` key, so the classic
 * save script and the kernel claim script guard the same value atomically:
 * - classic rooms keep their historical bare room id value;
 * - other games store `<game>|<roomId>`.
 * An identity therefore holds at most one active multiplayer seat (player or
 * spectator) across classic rooms, 图寻 rooms and 卡牌连接 matches.
 */
export const OCCUPANCY_TTL_SECONDS = 6 * 60 * 60;
/** Claims younger than this are never self-healed, covering in-flight SQL work. */
const SELF_HEAL_MIN_AGE_MS = 30_000;

/** Shared with the classic room store's single-instance fallback. */
export const localOccupancy = new Map<string, string>();

export const occupancyKey = (identity: string) => kernelKey(`identity-room:${identity}`);

export function encodeOccupancy(ref: Pick<OccupancyRef, 'game' | 'roomId'>): string {
  return ref.game === 'classic' ? ref.roomId : `${ref.game}|${ref.roomId}`;
}

export function decodeOccupancy(value: string | null | undefined): OccupancyRef | null {
  if (!value) return null;
  const separator = value.indexOf('|');
  if (separator < 0) return { game: 'classic', roomId: value };
  const game = value.slice(0, separator) as GameId;
  const roomId = value.slice(separator + 1);
  if (!roomId || (game !== 'location' && game !== 'card-link')) return null;
  return { game, roomId };
}

/** Classic code only understands bare room ids; foreign values are invisible to it. */
export function isForeignOccupancyValue(value: string | null | undefined): boolean {
  return Boolean(value && value.includes('|'));
}

export class OccupiedError extends Error {
  constructor(readonly occupied: OccupancyRef & { summary?: unknown }) {
    super('OCCUPIED_ELSEWHERE');
  }
}

export function isOccupiedError(error: unknown): error is OccupiedError {
  return error instanceof OccupiedError;
}

export async function lookupOccupancy(identity: string): Promise<OccupancyRef | null> {
  const client = kernelRedis();
  const value = client ? await client.get(occupancyKey(identity)) : localOccupancy.get(identity) ?? null;
  return decodeOccupancy(value);
}

async function claimAgeMs(identity: string): Promise<number> {
  const client = kernelRedis();
  if (!client) return Number.POSITIVE_INFINITY;
  const ttl = await client.pTTL(occupancyKey(identity));
  if (ttl < 0) return Number.POSITIVE_INFINITY;
  return OCCUPANCY_TTL_SECONDS * 1000 - ttl;
}

/**
 * Return the identity's current seat, deleting stale foreign references whose
 * game no longer considers the identity an active member.
 */
export async function resolveOccupancy(identity: string): Promise<OccupancyRef | null> {
  const ref = await lookupOccupancy(identity);
  if (!ref) return null;
  const adapter = getRoomAdapter(ref.game);
  if (!adapter) return ref;
  const active = await adapter.isActiveMember(ref.roomId, identity).catch(() => null);
  if (active !== false) return active === null ? ref : { ...ref, role: active };
  if (ref.game !== 'classic' && (await claimAgeMs(identity)) < SELF_HEAL_MIN_AGE_MS) return ref;
  if (ref.game !== 'classic') {
    await releaseOccupancy(ref, [identity]);
    countKernel('occupancy.selfHeals');
  }
  return null;
}

/**
 * Throw when the identity is seated in a game other than `game`. Conflicts
 * inside the same game stay with that game's historical rules and error codes.
 */
export async function assertNotOccupiedElsewhere(identity: string, game: GameId): Promise<void> {
  const ref = await resolveOccupancy(identity);
  if (ref && ref.game !== game) throw await occupiedError(ref, identity);
}

/** The identity's seat in another game (with a summary for the UI), or null. */
export async function foreignOccupancy(identity: string, game: GameId): Promise<OccupiedError['occupied'] | null> {
  const ref = await resolveOccupancy(identity);
  if (!ref || ref.game === game) return null;
  return (await occupiedError(ref, identity)).occupied;
}

export async function occupiedError(ref: OccupancyRef, identity: string): Promise<OccupiedError> {
  const summary = await getRoomAdapter(ref.game)?.describe?.(ref.roomId, identity).catch(() => null);
  countKernel('occupancy.conflicts');
  return new OccupiedError({ ...ref, summary: summary ?? null });
}

const CLAIM_SCRIPT = `local ref = ARGV[1]
local ttl = tonumber(ARGV[2])
local roomPrefix = ARGV[3]
local conflicts = {}
for index, key in ipairs(KEYS) do
  local identity = ARGV[3 + index]
  local current = redis.call('GET', key)
  if current and current ~= ref then
    if string.find(current, '|', 1, true) then
      table.insert(conflicts, index)
      table.insert(conflicts, current)
    else
      local metaKey = roomPrefix .. current .. ':meta'
      local status = redis.call('HGET', metaKey, 'status')
      local active = false
      if status then
        if status ~= 'finished' then
          local player = redis.call('HGET', roomPrefix .. current .. ':players', identity)
          if player then
            local ok, decoded = pcall(cjson.decode, player)
            active = not ok or decoded.eliminated ~= true
          elseif redis.call('HEXISTS', roomPrefix .. current .. ':spectators', identity) == 1 then
            active = true
          end
        end
      else
        local raw = redis.call('GET', roomPrefix .. current)
        if raw then
          local ok, room = pcall(cjson.decode, raw)
          if ok and room.status ~= 'finished' then
            for _, member in ipairs(room.players or {}) do
              if member.key == identity and member.eliminated ~= true then active = true end
            end
            for _, member in ipairs(room.spectators or {}) do
              if member.key == identity then active = true end
            end
          end
        end
      end
      if active then
        table.insert(conflicts, index)
        table.insert(conflicts, current)
      end
    end
  end
end
if #conflicts > 0 then return conflicts end
for _, key in ipairs(KEYS) do
  redis.call('SET', key, ref, 'EX', ttl)
end
return {}`;

const RELEASE_SCRIPT = `local removed = 0
for _, key in ipairs(KEYS) do
  if redis.call('GET', key) == ARGV[1] then
    redis.call('DEL', key)
    removed = removed + 1
  end
end
return removed`;

const REFRESH_SCRIPT = `for _, key in ipairs(KEYS) do
  if redis.call('GET', key) == ARGV[1] then redis.call('EXPIRE', key, ARGV[2]) end
end
return 1`;

export type ClaimResult = { ok: true } | { ok: false; identity: string; conflict: OccupancyRef };

async function claimOnce(ref: OccupancyRef, identities: string[]): Promise<ClaimResult> {
  const value = encodeOccupancy(ref);
  const client = kernelRedis();
  if (!client) {
    for (const identity of identities) {
      const current = localOccupancy.get(identity);
      if (!current || current === value) continue;
      const decoded = decodeOccupancy(current);
      if (!decoded) continue;
      const adapter = getRoomAdapter(decoded.game);
      const active = decoded.game === 'classic'
        ? Boolean(await adapter?.isActiveMember(decoded.roomId, identity).catch(() => false))
        : true;
      if (active) return { ok: false, identity, conflict: decoded };
    }
    for (const identity of identities) localOccupancy.set(identity, value);
    return { ok: true };
  }
  const result = await kernelScript(
    'kernel-occupancy-claim-v1',
    CLAIM_SCRIPT,
    identities.map(occupancyKey),
    [value, String(OCCUPANCY_TTL_SECONDS), kernelKey('room:'), ...identities]
  ) as Array<string | number>;
  if (!result.length) return { ok: true };
  const index = Number(result[0]) - 1;
  const conflict = decodeOccupancy(String(result[1]));
  return { ok: false, identity: identities[index], conflict: conflict ?? { game: 'classic', roomId: String(result[1]) } };
}

/**
 * Atomically claim the seat for every identity (a matched pair is claimed
 * together). Stale foreign references are self-healed once before giving up.
 */
export async function claimOccupancy(
  ref: OccupancyRef,
  identities: string[],
  options: { staleSameGame?: boolean } = {}
): Promise<ClaimResult> {
  if (!identities.length) return { ok: true };
  let result = await claimOnce(ref, identities);
  if (result.ok) return result;
  if (options.staleSameGame && result.conflict.game === ref.game) {
    // The caller already proved (inside its own transaction) that the identity
    // holds no other active seat in this game, so the old reference is stale.
    await releaseOccupancy(result.conflict, [result.identity]);
    countKernel('occupancy.selfHeals');
    result = await claimOnce(ref, identities);
    if (result.ok) return result;
  }
  const healed = await resolveOccupancy(result.identity);
  const stillHeld = healed && encodeOccupancy(healed) !== encodeOccupancy(ref);
  if (stillHeld) return { ok: false, identity: result.identity, conflict: healed };
  result = await claimOnce(ref, identities);
  if (!result.ok) countKernel('occupancy.conflicts');
  return result;
}

/** Claim or throw an OccupiedError describing the conflicting seat. */
export async function claimOccupancyOrThrow(ref: OccupancyRef, identities: string[], options: { staleSameGame?: boolean } = {}): Promise<void> {
  const result = await claimOccupancy(ref, identities, options);
  if (!result.ok) throw await occupiedError(result.conflict, result.identity);
}

export async function releaseOccupancy(ref: Pick<OccupancyRef, 'game' | 'roomId'>, identities: string[]): Promise<void> {
  if (!identities.length) return;
  const value = encodeOccupancy(ref);
  const client = kernelRedis();
  if (!client) {
    for (const identity of identities) if (localOccupancy.get(identity) === value) localOccupancy.delete(identity);
    return;
  }
  await kernelScript('kernel-occupancy-release-v1', RELEASE_SCRIPT, identities.map(occupancyKey), [value]);
}

export async function refreshOccupancy(ref: Pick<OccupancyRef, 'game' | 'roomId'>, identities: string[]): Promise<void> {
  if (!identities.length) return;
  const client = kernelRedis();
  if (!client) return;
  await kernelScript('kernel-occupancy-refresh-v1', REFRESH_SCRIPT, identities.map(occupancyKey), [
    encodeOccupancy(ref),
    String(OCCUPANCY_TTL_SECONDS),
  ]);
}

/** Lua fragments other scripts embed to release or refresh occupancy atomically. */
export const OCCUPANCY_LUA = { RELEASE_SCRIPT, REFRESH_SCRIPT };
