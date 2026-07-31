import { getDifficultyPlayers, pickCachedTarget } from './playerCache';
import { evalStateScript, redisKey, redisState } from '../redis';
import type { Player } from '../types';

const HISTORY_WINDOW_MS = 60 * 60_000;
const HISTORY_TTL_SECONDS = 2 * 60 * 60;
const MAX_HISTORY_TARGETS = 20;
const MIN_CANDIDATES = 5;
const MAX_LOCAL_HISTORY_KEYS = 10_000;

interface TargetHistoryEntry {
  playerId: number;
  selectedAt: number;
}

const localHistory = new Map<string, TargetHistoryEntry[]>();

function historyKey(identity: string, mode: string): string {
  return redisKey(`target-history:${mode}:${identity}`);
}

function localKey(identity: string, mode: string): string {
  return `${mode}:${identity}`;
}

function normalizedIdentities(identities: readonly string[]): string[] {
  return [...new Set(identities.filter(Boolean))];
}

function readLocalHistory(identity: string, mode: string, cutoff: number): TargetHistoryEntry[] {
  const key = localKey(identity, mode);
  const current = localHistory.get(key) ?? [];
  const active = current.filter((entry) => entry.selectedAt >= cutoff);
  if (active.length) {
    localHistory.delete(key);
    localHistory.set(key, active);
  } else {
    localHistory.delete(key);
  }
  return active;
}

function rememberLocally(identities: readonly string[], mode: string, playerId: number, now: number): void {
  const cutoff = now - HISTORY_WINDOW_MS;
  for (const identity of identities) {
    const key = localKey(identity, mode);
    const current = readLocalHistory(identity, mode, cutoff)
      .filter((entry) => entry.playerId !== playerId);
    current.push({ playerId, selectedAt: now });
    localHistory.delete(key);
    localHistory.set(key, current.slice(-MAX_HISTORY_TARGETS));
  }
  while (localHistory.size > MAX_LOCAL_HISTORY_KEYS) {
    localHistory.delete(localHistory.keys().next().value!);
  }
}

async function recentEntries(
  identities: readonly string[],
  mode: string,
  now: number
): Promise<TargetHistoryEntry[]> {
  const cutoff = now - HISTORY_WINDOW_MS;
  const byPlayer = new Map<number, number>();
  for (const identity of identities) {
    for (const entry of readLocalHistory(identity, mode, cutoff)) {
      byPlayer.set(entry.playerId, Math.max(byPlayer.get(entry.playerId) ?? 0, entry.selectedAt));
    }
  }

  const client = redisState();
  if (client) {
    try {
      const histories = await Promise.all(identities.map((identity) =>
        client.zRangeWithScores(historyKey(identity, mode), 0, -1)
      ));
      for (const history of histories) {
        for (const entry of history) {
          const playerId = Number(entry.value);
          if (!Number.isInteger(playerId) || playerId <= 0 || entry.score < cutoff) continue;
          byPlayer.set(playerId, Math.max(byPlayer.get(playerId) ?? 0, entry.score));
        }
      }
    } catch {
      // Recent-target avoidance is best effort; room creation must remain available.
    }
  }

  return [...byPlayer.entries()]
    .map(([playerId, selectedAt]) => ({ playerId, selectedAt }))
    .sort((a, b) => b.selectedAt - a.selectedAt);
}

export async function pickTargetAvoidingRecent(input: {
  mode: string;
  identities: readonly string[];
  hardExcludedIds?: readonly number[];
  now?: number;
}): Promise<Player | null> {
  const pool = getDifficultyPlayers(input.mode);
  if (!pool.length) return null;
  const poolIds = new Set(pool.map((player) => player.id));
  const hardExcluded = new Set(
    (input.hardExcludedIds ?? []).filter((playerId) => poolIds.has(playerId))
  );
  const withoutHardExclusions = pool.filter((player) => !hardExcluded.has(player.id));
  const basePool = withoutHardExclusions.length ? withoutHardExclusions : pool;
  const baseIds = new Set(basePool.map((player) => player.id));
  const identities = normalizedIdentities(input.identities);
  const recent = await recentEntries(identities, input.mode, input.now ?? Date.now());
  const minimumCandidateCount = Math.min(
    MIN_CANDIDATES,
    Math.max(1, Math.ceil(basePool.length * 0.2))
  );
  const maximumRecentExclusions = Math.max(
    0,
    basePool.length - minimumCandidateCount
  );
  const recentExcluded = recent
    .filter((entry) => baseIds.has(entry.playerId))
    .slice(0, maximumRecentExclusions)
    .map((entry) => entry.playerId);
  const excluded = withoutHardExclusions.length
    ? new Set([...hardExcluded, ...recentExcluded])
    : new Set(recentExcluded);
  return pickCachedTarget(input.mode, excluded);
}

export async function rememberTargetSelection(input: {
  mode: string;
  identities: readonly string[];
  playerId: number;
  now?: number;
}): Promise<void> {
  const identities = normalizedIdentities(input.identities);
  if (!identities.length) return;
  const now = input.now ?? Date.now();
  rememberLocally(identities, input.mode, input.playerId, now);
  const client = redisState();
  if (!client) return;
  try {
    await evalStateScript(
      'target-history-record-v1',
      `for _, key in ipairs(KEYS) do
         redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[2])
         redis.call('ZADD', key, ARGV[1], ARGV[3])
         local count = redis.call('ZCARD', key)
         if count > ${MAX_HISTORY_TARGETS} then
           redis.call('ZREMRANGEBYRANK', key, 0, count - ${MAX_HISTORY_TARGETS + 1})
         end
         redis.call('EXPIRE', key, ARGV[4])
       end
       return #KEYS`,
      identities.map((identity) => historyKey(identity, input.mode)),
      [
        String(now),
        String(now - HISTORY_WINDOW_MS),
        String(input.playerId),
        String(HISTORY_TTL_SECONDS),
      ]
    );
  } catch {
    // The bounded local history still avoids immediate repeats on this instance.
  }
}
