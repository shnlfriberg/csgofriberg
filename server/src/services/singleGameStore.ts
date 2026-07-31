import { randomUUID } from 'crypto';
import { evalCommandScript, redis, redisKey } from '../redis';
import { GuessFeedback } from '../types';

export type SingleGameMode = string;

export interface SingleGameState {
  id: string;
  identityKey: string;
  userId: number | null;
  guestKey: string | null;
  mode: SingleGameMode;
  targetPlayerId: number;
  guesses: GuessFeedback[];
  /** Milliseconds from game creation for each accepted guess. */
  guessTimes: Array<number | null>;
  createdAt: number;
  lastActiveAt: number;
}

// Active single-player games expire after thirty minutes without a write/guess.
// This is also the retention window used by the online single-game counter.
export const SINGLE_GAME_TTL_SECONDS = 1800;

function gameKey(id: string): string {
  return redisKey(`single:game:${id}`);
}

function activeKey(identityKey: string, mode: SingleGameMode): string {
  return redisKey(`single:active:${identityKey}:${mode}`);
}

function requiredRedis() {
  const client = redis();
  if (!client) throw new Error('REDIS_UNAVAILABLE');
  return client;
}

function normalizeGuessTimes(game: SingleGameState): void {
  if (!Array.isArray(game.guessTimes)) game.guessTimes = [];
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

export async function createOrResumeSingleGame(input: {
  identityKey: string;
  userId: number | null;
  guestKey: string | null;
  mode: SingleGameMode;
  targetPlayerId: number;
}): Promise<SingleGameState> {
  return (await createOrResumeSingleGameWithStatus(input)).game;
}

export async function createOrResumeSingleGameWithStatus(input: {
  identityKey: string;
  userId: number | null;
  guestKey: string | null;
  mode: SingleGameMode;
  targetPlayerId: number;
}): Promise<{ game: SingleGameState; created: boolean }> {
  const existing = await loadActiveSingleGame(input.identityKey, input.mode);
  if (existing) return { game: existing, created: false };

  const now = Date.now();
  const game: SingleGameState = {
    id: randomUUID(),
    identityKey: input.identityKey,
    userId: input.userId,
    guestKey: input.guestKey,
    mode: input.mode,
    targetPlayerId: input.targetPlayerId,
    guesses: [],
    guessTimes: [],
    createdAt: now,
    lastActiveAt: now,
  };
  await saveSingleGame(game);
  return { game, created: true };
}

export async function loadActiveSingleGame(
  identityKey: string,
  mode: SingleGameMode
): Promise<SingleGameState | null> {
  const client = requiredRedis();
  const active = activeKey(identityKey, mode);
  const existingId = await client.get(active);
  if (!existingId) return null;
  // Restoring after a refresh must not extend the inactivity window.
  const existing = await loadSingleGame(existingId, identityKey);
  if (existing) return existing;
  await client.del(active);
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
  if (!Array.isArray(game.guesses)) game.guesses = [];
  normalizeGuessTimes(game);
  if (game.lastActiveAt + SINGLE_GAME_TTL_SECONDS * 1000 <= Date.now()) {
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
  const expiresAt = game.lastActiveAt + SINGLE_GAME_TTL_SECONDS * 1000;
  await client.multi()
    .set(gameKey(game.id), JSON.stringify(game), { EX: SINGLE_GAME_TTL_SECONDS })
    .set(activeKey(game.identityKey, game.mode), game.id, { EX: SINGLE_GAME_TTL_SECONDS })
    .zAdd(redisKey('presence:single'), { score: expiresAt, value: game.id })
    .exec();
}

export async function deleteSingleGame(game: SingleGameState): Promise<void> {
  const client = requiredRedis();
  const active = activeKey(game.identityKey, game.mode);
  await evalCommandScript(
    'single-game-delete-v1',
    `redis.call('ZREM', KEYS[3], ARGV[1])
     if redis.call('get', KEYS[1]) == ARGV[1] then
       return redis.call('del', KEYS[1], KEYS[2])
     end
     return redis.call('del', KEYS[2])`,
    [active, gameKey(game.id), redisKey('presence:single')],
    [game.id]
  );
}
