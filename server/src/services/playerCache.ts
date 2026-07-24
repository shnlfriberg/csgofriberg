import { db } from '../db/knex';
import { redis, redisKey, redisPublisher, redisSubscriber } from '../redis';
import { Player } from '../types';
import { DIFFICULTY_LEVELS } from '../difficulties';

const INVALIDATE_CHANNEL = redisKey('players:invalidate');
// v1 stored a SHA string and cannot be incremented safely during rolling upgrades.
const VERSION_KEY = redisKey('players:revision:v2');
const REFRESH_DEBOUNCE_MS = 100;

type PublicPlayer = { id: number; nickname: string };
type SearchablePlayer = { player: Player; search: string };
let playersById = new Map<number, Player>();
let allPlayers: Player[] = [];
let playersByDifficulty = new Map<string, Player[]>();
let searchablePlayers: SearchablePlayer[] = [];
let publicList: { version: string; players: PublicPlayer[] } = { version: '1', players: [] };
let refreshPromise: Promise<void> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let refreshGeneration = 0;
let pendingVersion: string | null = null;

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export async function refreshPlayerCache(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    let appliedGeneration = -1;
    while (appliedGeneration !== refreshGeneration) {
      const requestedGeneration = refreshGeneration;
      const [rows, memberships, storedVersion] = await Promise.all([
        db<Player>('players').orderBy('nickname'),
        db('player_difficulties').select('player_id', 'difficulty_key'),
        redis()?.get(VERSION_KEY) ?? Promise.resolve(null),
      ]);
      const levels = DIFFICULTY_LEVELS;
      const enabled = rows.filter((player) => Boolean(player.is_enabled));
      const membershipsByPlayer = new Map<number, string[]>();
      for (const membership of memberships) {
        const list = membershipsByPlayer.get(Number(membership.player_id)) ?? [];
        list.push(String(membership.difficulty_key));
        membershipsByPlayer.set(Number(membership.player_id), list);
      }
      const hydrated = rows.map((player) => ({
        ...player,
        difficulties: membershipsByPlayer.get(Number(player.id)) ?? [],
      }));
      const hydratedById = new Map(hydrated.map((player) => [player.id, player]));
      allPlayers = enabled.map((player) => hydratedById.get(player.id)!).filter(Boolean);
      playersByDifficulty = new Map();
      for (const level of levels) {
        const pool = allPlayers.filter((player) => player.difficulties?.includes(level.key));
        playersByDifficulty.set(String(level.key), pool);
      }
      playersById = new Map(hydrated.map((player) => [player.id, player]));
      searchablePlayers = allPlayers.map((player) => ({
        player,
        search: normalizeSearch(`${player.nickname}\0${player.team}`),
      }));
      publicList = {
        version: pendingVersion || storedVersion || String(Date.now()),
        players: enabled.map((player) => ({ id: player.id, nickname: player.nickname })),
      };
      pendingVersion = null;
      appliedGeneration = requestedGeneration;
    }
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

function schedulePlayerCacheRefresh(): void {
  refreshGeneration += 1;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshPlayerCache().catch((err) => console.error('[players] refresh failed', err));
  }, REFRESH_DEBOUNCE_MS);
  refreshTimer.unref?.();
}

export async function initPlayerCache(): Promise<void> {
  const client = redis();
  if (client) {
    await client.set(VERSION_KEY, '1', { NX: true });
    const subscriber = redisSubscriber();
    if (subscriber) await subscriber.subscribe(INVALIDATE_CHANNEL, schedulePlayerCacheRefresh);
  }
  await refreshPlayerCache();
}

export function getPlayer(id: number): Player | undefined {
  return playersById.get(id);
}

export function getEnabledPlayer(id: number): Player | undefined {
  const player = playersById.get(id);
  return player && Boolean(player.is_enabled) ? player : undefined;
}

export function pickCachedTarget(mode: string): Player | null {
  const pool = playersByDifficulty.get(mode) ?? [];
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

export function isDifficultyAvailable(key: string): boolean {
  const difficulty = DIFFICULTY_LEVELS.find((item) => item.key === key);
  return Boolean(difficulty?.isEnabled && (playersByDifficulty.get(key)?.length ?? 0) > 0);
}

export function searchCachedPlayers(search: string, limit: number): Player[] {
  const normalized = normalizeSearch(search);
  if (!normalized) return allPlayers.slice(0, limit);
  const result: Player[] = [];
  for (const entry of searchablePlayers) {
    if (!entry.search.includes(normalized)) continue;
    result.push(entry.player);
    if (result.length >= limit) break;
  }
  return result;
}

export async function getPublicPlayerList(): Promise<typeof publicList> {
  const storedVersion = await redis()?.get(VERSION_KEY);
  if (storedVersion && storedVersion !== publicList.version) {
    pendingVersion = storedVersion;
    refreshGeneration += 1;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    await refreshPlayerCache();
  }
  return publicList;
}

export async function invalidatePlayerCache(): Promise<void> {
  const client = redis();
  let nextVersion = String(Date.now());
  if (client) {
    try {
      nextVersion = String(await client.incr(VERSION_KEY));
    } catch (err) {
      console.warn('[players] cache revision update failed', err instanceof Error
        ? err.message
        : err);
    }
  }
  pendingVersion = nextVersion;
  refreshGeneration += 1;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  await refreshPlayerCache();
  if (client) {
    try {
      await redisPublisher()?.publish(INVALIDATE_CHANNEL, nextVersion);
    } catch (err) {
      console.warn('[players] cache invalidation notification failed', err instanceof Error
        ? err.message
        : err);
    }
  }
}
