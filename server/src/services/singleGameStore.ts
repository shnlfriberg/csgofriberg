import { randomUUID } from 'crypto';
import { evalCommandScript, redis, redisKey } from '../redis';
import { GuessFeedback } from '../types';
import { isSingleGameVariant, type SingleGameVariant } from './gameModes';
import type { SoupState } from './turtleSoup';
import { singlePresenceCategory, singlePresenceKey } from './singleGamePresence';

export type SingleGameMode = string;
export type SingleGameKind = 'single' | 'daily';

export interface SingleGameState {
  id: string;
  kind?: SingleGameKind;
  identityKey: string;
  userId: number | null;
  guestKey: string | null;
  mode: SingleGameMode;
  variant?: SingleGameVariant;
  soup?: SoupState;
  targetPlayerId: number;
  dailyChallengeId?: number;
  guesses: GuessFeedback[];
  /** Milliseconds from game creation for each accepted guess. */
  guessTimes: Array<number | null>;
  createdAt: number;
  lastActiveAt: number;
  /** Absolute expiry for fixed-window games such as the daily challenge. */
  expiresAt?: number;
}

// Active single-player games expire after thirty minutes without a write/guess.
// This is also the retention window used by the online single-game counter.
export const SINGLE_GAME_TTL_SECONDS = 1800;

function gameKey(id: string): string {
  return redisKey(`single:game:${id}`);
}

function activeKey(
  identityKey: string,
  mode: SingleGameMode,
  variant: SingleGameVariant = 'classic'
): string {
  return redisKey(`single:active:${identityKey}:${mode}:${variant}`);
}

function legacyActiveKey(identityKey: string, mode: SingleGameMode): string {
  return redisKey(`single:active:${identityKey}:${mode}`);
}

function requiredRedis() {
  const client = redis();
  if (!client) throw new Error('REDIS_UNAVAILABLE');
  return client;
}

function normalizeGuessTimes(game: SingleGameState): void {
  if (!isSingleGameVariant(game.variant)) game.variant = 'classic';
  game.guessTimes = game.guessTimes.map((value) => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : null
  ));
  if (game.guessTimes.length > game.guesses.length) {
    game.guessTimes = game.guessTimes.slice(0, game.guesses.length);
  }
  while (game.guessTimes.length < game.guesses.length) game.guessTimes.push(null);
}

export async function createOrResumeSingleGameWithStatus(input: {
  identityKey: string;
  userId: number | null;
  guestKey: string | null;
  mode: SingleGameMode;
  /** Gameplay variant; mode remains the difficulty key for compatibility. */
  variant?: SingleGameVariant;
  targetPlayerId: number;
  kind?: SingleGameKind;
  soup?: SoupState;
  expiresAt?: number;
  dailyChallengeId?: number;
}): Promise<{ game: SingleGameState; created: boolean }> {
  const variant = input.variant ?? 'classic';
  const existing = await loadActiveSingleGame(input.identityKey, input.mode, variant);
  if (existing) return { game: existing, created: false };

  const now = Date.now();
  const game: SingleGameState = {
    id: randomUUID(),
    kind: input.kind ?? 'single',
    identityKey: input.identityKey,
    userId: input.userId,
    guestKey: input.guestKey,
    mode: input.mode,
    variant,
    targetPlayerId: input.targetPlayerId,
    soup: input.soup,
    dailyChallengeId: input.dailyChallengeId,
    guesses: [],
    guessTimes: [],
    createdAt: now,
    lastActiveAt: now,
    expiresAt: input.expiresAt,
  };
  await saveSingleGame(game);
  return { game, created: true };
}

export async function loadActiveSingleGame(
  identityKey: string,
  mode: SingleGameMode,
  variant: SingleGameVariant = 'classic'
): Promise<SingleGameState | null> {
  const client = requiredRedis();
  const active = activeKey(identityKey, mode, variant);
  const existingId = await client.get(active)
    || (variant === 'classic' ? await client.get(legacyActiveKey(identityKey, mode)) : null);
  if (!existingId) return null;
  // Restoring after a refresh must not extend the inactivity window.
  const existing = await loadSingleGame(existingId, identityKey);
  if (existing) return existing;
  await client.del(variant === 'classic' ? [active, legacyActiveKey(identityKey, mode)] : [active]);
  return null;
}

export async function loadSingleGame(
  id: string,
  identityKey: string,
  touch = false
): Promise<SingleGameState | null> {
  const client = requiredRedis();
  const raw = await client.get(gameKey(id));
  if (!raw) return null;
  const game = JSON.parse(raw) as SingleGameState;
  if (game.identityKey !== identityKey) return null;
  normalizeGuessTimes(game);
  const expiresAt = game.expiresAt ?? game.lastActiveAt + SINGLE_GAME_TTL_SECONDS * 1000;
  if (expiresAt <= Date.now()) {
    await deleteSingleGame(game);
    return null;
  }
  if (touch) {
    game.lastActiveAt = Date.now();
    await saveSingleGame(game);
  }
  return game;
}

export async function saveSingleGame(game: SingleGameState): Promise<void> {
  const client = requiredRedis();
  normalizeGuessTimes(game);
  game.lastActiveAt = Date.now();
  const expiresAt = game.expiresAt ?? game.lastActiveAt + SINGLE_GAME_TTL_SECONDS * 1000;
  const ttlSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  const transaction = client.multi()
    .set(gameKey(game.id), JSON.stringify(game), { EX: ttlSeconds })
    .set(singlePresenceKey(game.id), singlePresenceCategory(game), { EX: ttlSeconds })
    .set(activeKey(game.identityKey, game.mode, game.variant), game.id, { EX: ttlSeconds });
  if (game.variant === 'classic') transaction.del(legacyActiveKey(game.identityKey, game.mode));
  await transaction
    .zAdd(redisKey('presence:single'), { score: expiresAt, value: game.id })
    .exec();
}

export async function deleteSingleGame(game: SingleGameState): Promise<void> {
  const active = activeKey(game.identityKey, game.mode, game.variant);
  const legacy = legacyActiveKey(game.identityKey, game.mode);
  await evalCommandScript(
    'single-game-delete-v3',
    `redis.call('ZREM', KEYS[4], ARGV[1])
     redis.call('DEL', KEYS[5])
     if redis.call('get', KEYS[1]) == ARGV[1] then
       redis.call('del', KEYS[1], KEYS[2])
     end
     if redis.call('get', KEYS[3]) == ARGV[1] then
       redis.call('del', KEYS[3])
     end
     return redis.call('del', KEYS[2])`,
    [active, gameKey(game.id), legacy, redisKey('presence:single'), singlePresenceKey(game.id)],
    [game.id]
  );
}
