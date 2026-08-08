import { randomUUID } from 'crypto';
import { evalStateScript, redisKey, redisState } from '../redis';
import { GuessFeedback } from '../types';
import { config } from '../config';
import { logTransientError } from './transientLog';
import { DIFFICULTY_LEVELS } from '../difficulties';

export type BoType = 1 | 3 | 5 | 7;
export type DbType = string;
export type MatchmakingPool = 'restricted' | 'verified';
export type RoomStatus = 'waiting' | 'starting' | 'playing' | 'round_over' | 'finished';
const MATCHMAKING_ENTRY_TTL_MS = 300_000;

export interface StoredIdentity {
  key: string;
  userId: number | null;
  name: string;
  emailVerified?: boolean;
}

export interface QueuedIdentity extends StoredIdentity {
  socketId: string;
  anonymous?: boolean;
  matchmakingPool?: MatchmakingPool;
}

export interface StoredPlayer extends StoredIdentity {
  socketId: string;
  ready: boolean;
  score: number;
  guesses: GuessFeedback[];
  guessTimes: Array<number | null>;
  lastGuessAt: number | null;
  skipped: boolean;
  connected: boolean;
  disconnectDeadline: number | null;
}

export interface StoredSpectator extends StoredIdentity {
  socketId: string;
  connected: boolean;
  disconnectDeadline: number | null;
}

export interface StoredRoundResult {
  round: number;
  winnerKey: string | null;
  reason: 'guessed' | 'exhausted' | 'timeout' | 'skipped' | 'surrender';
  matchOver: boolean;
  nextRoundAt: number | null;
}

export interface StoredMatchResult {
  winnerKey: string | null;
  reason: string;
  forfeitedKey: string | null;
}

export interface StoredMatchReport {
  reporterKey: string;
  reportedKey: string;
  description: string;
  createdAt: number;
}

export interface StoredReplayRound {
  round: number;
  targetPlayerId: number;
  winnerKey: string | null;
  reason: string;
  guessesByPlayer: Record<string, number[]>;
  guessTimesByPlayer: Record<string, Array<number | null>>;
}

export interface StoredRoom {
  id: string;
  recordId: string;
  ownerIp: string;
  hostKey: string;
  status: RoomStatus;
  matchmaking: boolean;
  readyCheckEndsAt: number | null;
  dbType: DbType;
  boType: BoType;
  rematchAllowed: boolean;
  rematchInviterKey: string | null;
  allowSpectators: boolean;
  verifiedOnly: boolean;
  anonymous: boolean;
  round: number;
  players: StoredPlayer[];
  spectators: StoredSpectator[];
  targetPlayerId: number | null;
  roundEndsAt: number | null;
  nextRoundAt: number | null;
  eventResults: Record<string, number>;
  roundResult: StoredRoundResult | null;
  matchResult: StoredMatchResult | null;
  reports: StoredMatchReport[];
  replayRounds: StoredReplayRound[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

const ROOM_TTL_SECONDS = 6 * 60 * 60;
const FINISHED_ROOM_TTL_MS = 5 * 60_000;
const MAX_GLOBAL_ROOMS = 10_000;
const MAX_ROOMS_PER_IP = 50;
const localRooms = new Map<string, StoredRoom>();
const localIdentityRooms = new Map<string, string>();
const localLocks = new Map<string, Promise<void>>();
const roomTargetCache = new Map<string, { round: number; targetPlayerId: number }>();

function roomKey(id: string) {
  return redisKey(`room:${id}`);
}

function roomMetaKey(id: string) {
  return redisKey(`room:${id}:meta`);
}

function roomPlayersKey(id: string) {
  return redisKey(`room:${id}:players`);
}

function roomGuessesKey(id: string) {
  return redisKey(`room:${id}:guesses`);
}

function roomEventsKey(id: string) {
  return redisKey(`room:${id}:events`);
}

function roomSpectatorsKey(id: string) {
  return redisKey(`room:${id}:spectators`);
}

function identityKey(identity: string) {
  return redisKey(`identity-room:${identity}`);
}

function stateRedis() {
  const client = redisState();
  if (!client && config.redisRequired) throw new Error('REDIS_UNAVAILABLE');
  return client;
}

function evalCachedStateScript(
  name: string,
  script: string,
  options: { keys: string[]; arguments: string[] }
): Promise<unknown> {
  return evalStateScript(name, script, options.keys, options.arguments);
}

function normalizeGuessTimes(value: unknown, guessCount: number): Array<number | null> {
  const times = Array.isArray(value)
    ? value.map((item) => (
      typeof item === 'number' && Number.isFinite(item) && item >= 0
        ? Math.floor(item)
        : null
    ))
    : [];
  if (times.length > guessCount) times.length = guessCount;
  while (times.length < guessCount) times.push(null);
  return times;
}

function matchmakingQueueName(dbType: DbType, pool: MatchmakingPool = 'verified'): string {
  return `${pool}:${dbType}`;
}

function matchmakingQueueKey(dbType: DbType, pool: MatchmakingPool = 'verified'): string {
  return redisKey(`matchmaking:${matchmakingQueueName(dbType, pool)}`);
}

function normalizeRoom(room: StoredRoom): StoredRoom {
  if (!Array.isArray(room.players)) room.players = [];
  if (!Array.isArray(room.spectators)) room.spectators = [];
  if (typeof room.allowSpectators !== 'boolean') room.allowSpectators = false;
  if (typeof room.verifiedOnly !== 'boolean') room.verifiedOnly = false;
  if (typeof room.anonymous !== 'boolean') room.anonymous = false;
  if (typeof room.matchmaking !== 'boolean') room.matchmaking = false;
  room.readyCheckEndsAt ??= null;
  if (typeof room.rematchAllowed !== 'boolean') room.rematchAllowed = false;
  room.rematchInviterKey ??= null;
  room.eventResults ??= {};
  if (Object.values(room.eventResults).some((value) => typeof value !== 'number')) {
    room.eventResults = {};
  }
  room.roundResult ??= null;
  room.matchResult ??= null;
  if (room.matchResult) room.matchResult.forfeitedKey ??= null;
  if (!Array.isArray(room.reports)) room.reports = [];
  if (room.reports.length > 2) room.reports = room.reports.slice(-2);
  if (!Array.isArray(room.replayRounds)) room.replayRounds = [];
  if (room.replayRounds.length > 30) room.replayRounds = room.replayRounds.slice(-30);
  for (const round of room.replayRounds) {
    const guessesByPlayer = round.guessesByPlayer && typeof round.guessesByPlayer === 'object'
      ? round.guessesByPlayer
      : {};
    const storedTimes = round.guessTimesByPlayer && typeof round.guessTimesByPlayer === 'object'
      ? round.guessTimesByPlayer
      : {};
    round.guessTimesByPlayer = Object.fromEntries(
      Object.entries(guessesByPlayer).map(([key, guesses]) => [
        key,
        normalizeGuessTimes(storedTimes[key], Array.isArray(guesses) ? guesses.length : 0),
      ])
    );
  }
  room.revision ??= 0;
  for (const player of room.players) {
    if (!Array.isArray(player.guesses)) player.guesses = [];
    player.guessTimes = normalizeGuessTimes(player.guessTimes, player.guesses.length);
    player.lastGuessAt ??= null;
    player.skipped ??= false;
  }
  for (const spectator of room.spectators) {
    spectator.connected ??= true;
    spectator.disconnectDeadline ??= null;
  }
  return room;
}

export async function getRoom(id: string): Promise<StoredRoom | null> {
  const client = stateRedis();
  if (!client) {
    const room = localRooms.get(id);
    return room ? structuredClone(normalizeRoom(room)) : null;
  }
  const result = await client.multi()
    .get(roomKey(id))
    .hGetAll(roomMetaKey(id))
    .hGetAll(roomPlayersKey(id))
    .hGetAll(roomGuessesKey(id))
    .hGetAll(roomEventsKey(id))
    .hGetAll(roomSpectatorsKey(id))
    .exec();
  const raw = result?.[0] as unknown as string | null;
  if (!raw) return null;
  const room = normalizeRoom(JSON.parse(raw) as StoredRoom);
  const meta = (result?.[1] ?? {}) as unknown as Record<string, string>;
  const players = (result?.[2] ?? {}) as unknown as Record<string, string>;
  const guesses = (result?.[3] ?? {}) as unknown as Record<string, string>;
  const events = (result?.[4] ?? {}) as unknown as Record<string, string>;
  const spectators = (result?.[5] ?? {}) as unknown as Record<string, string>;
  if (!Object.keys(meta).length || !Object.keys(players).length) return room;

  const parseNullableNumber = (value: string | undefined): number | null => {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const parseNullableJson = <T>(value: string | undefined): T | null => {
    if (!value || value === 'null') return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  };
  const playerValues = new Map<string, StoredPlayer>();
  for (const [key, value] of Object.entries(players)) {
    try {
      const player = JSON.parse(value) as StoredPlayer;
      const storedGuesses = guesses[key];
      player.guesses = storedGuesses ? JSON.parse(storedGuesses) as GuessFeedback[] : [];
      if (!Array.isArray(player.guesses)) player.guesses = [];
      playerValues.set(key, player);
    } catch {
      // Keep the snapshot value when one hot field is malformed.
    }
  }
  const orderedPlayers = room.players
    .map((player) => playerValues.get(player.key) ?? player)
    .filter((player, index, all) => all.findIndex((candidate) => candidate.key === player.key) === index);
  for (const player of playerValues.values()) {
    if (!orderedPlayers.some((candidate) => candidate.key === player.key)) orderedPlayers.push(player);
  }
  room.players = orderedPlayers;

  const spectatorValues = new Map<string, StoredSpectator>();
  for (const [key, value] of Object.entries(spectators)) {
    try {
      spectatorValues.set(key, JSON.parse(value) as StoredSpectator);
    } catch {
      // Keep the snapshot value when one hot field is malformed.
    }
  }
  const orderedSpectators = room.spectators
    .map((spectator) => spectatorValues.get(spectator.key) ?? spectator)
    .filter((spectator, index, all) => all.findIndex(
      (candidate) => candidate.key === spectator.key
    ) === index);
  for (const spectator of spectatorValues.values()) {
    if (!orderedSpectators.some((candidate) => candidate.key === spectator.key)) {
      orderedSpectators.push(spectator);
    }
  }
  room.spectators = orderedSpectators;

  room.eventResults = Object.fromEntries(
    Object.entries(events)
      .map(([key, value]) => [key, Number(value)] as const)
      .filter((entry) => Number.isInteger(entry[1]))
  );
  room.status = (meta.status || room.status) as RoomStatus;
  room.targetPlayerId = parseNullableNumber(meta.targetPlayerId);
  room.round = Number(meta.round || room.round);
  room.revision = Number(meta.revision || room.revision);
  room.updatedAt = Number(meta.updatedAt || room.updatedAt);
  room.roundEndsAt = parseNullableNumber(meta.roundEndsAt);
  room.nextRoundAt = parseNullableNumber(meta.nextRoundAt);
  room.roundResult = parseNullableJson<StoredRoundResult>(meta.roundResult);
  room.matchResult = parseNullableJson<StoredMatchResult>(meta.matchResult);
  return normalizeRoom(room);
}

export async function getRoomForIdentity(
  identity: string,
  includeFinished = false
): Promise<StoredRoom | null> {
  const id = await getRoomIdForIdentity(identity);
  if (!id) return null;
  const room = await getRoom(id);
  if (!room) {
    await clearIdentityRoom(identity, id);
    return null;
  }
  if (![...room.players, ...room.spectators].some((member) => member.key === identity)) {
    await clearIdentityRoom(identity, id);
    return null;
  }
  if (room.status === 'finished' && !includeFinished) return null;
  return room;
}

export async function getRoomIdForIdentity(identity: string): Promise<string | null> {
  const client = stateRedis();
  return client
    ? await client.get(identityKey(identity))
    : localIdentityRooms.get(identity) ?? null;
}

export interface ApplyRoomGuessInput {
  roomId: string;
  identity: string;
  socketId: string;
  expectedRound: number;
  eventId: string;
  targetPlayerId: number;
  feedback: GuessFeedback;
  maxGuesses: number;
  roundDurationMs: number;
  nextRoundDelayMs: number;
  minGuessIntervalMs: number;
  rateLimit: number;
  rateWindowSeconds: number;
}

export type ApplyRoomGuessResult =
  | {
      kind: 'applied';
      feedback: GuessFeedback;
      round: number;
      correct: boolean;
      shouldFinish: boolean;
      matchOver: boolean;
      revision: number;
      playerKeys: string[];
      room?: StoredRoom;
    }
  | {
      kind: 'duplicate';
      feedback: GuessFeedback;
      round: number;
      revision: number;
    }
  | { kind: 'error'; code: string; reason?: string; retryAfterMs?: number };


const APPLY_ROOM_GUESS_HASH_SCRIPT = `local rateCount = redis.call('HINCRBY', KEYS[6], ARGV[1], 1)
if rateCount == 1 then redis.call('HEXPIRE', KEYS[6], ARGV[15], 'FIELDS', '1', ARGV[1]) end
if rateCount > tonumber(ARGV[14]) then
  return cjson.encode({kind='error', code='RATE_LIMITED'})
end
if redis.call('EXISTS', KEYS[5]) == 1 then
  return cjson.encode({kind='error', code='ROOM_BUSY'})
end
if redis.call('EXISTS', KEYS[1]) == 0 then
  return cjson.encode({kind='error', code='NO_ACTIVE_ROUND', reason='room_missing'})
end
local meta = redis.call('HMGET', KEYS[2], 'status', 'targetPlayerId', 'round', 'roundEndsAt', 'revision', 'boType')
if not meta[1] or redis.call('HLEN', KEYS[7]) == 0 then
  return cjson.encode({kind='error', code='HOT_STATE_MISSING', reason='room_hot_state_missing'})
end
local identity = ARGV[1]
local eventKey = identity .. ':' .. ARGV[5]
local playerRaw = redis.call('HGET', KEYS[7], identity)
if not playerRaw then
  return cjson.encode({kind='error', code='NO_ACTIVE_ROUND', reason='player_missing'})
end
local playerOk, player = pcall(cjson.decode, playerRaw)
if not playerOk then
  return cjson.encode({kind='error', code='INTERNAL_ERROR', reason='invalid_player_state'})
end
local guessesRaw = redis.call('HGET', KEYS[8], identity) or '[]'
local guessesOk, guesses = pcall(cjson.decode, guessesRaw)
if not guessesOk or type(guesses) ~= 'table' then
  return cjson.encode({kind='error', code='INTERNAL_ERROR', reason='invalid_guess_state'})
end
local previousIndex = redis.call('HGET', KEYS[9], eventKey)
if previousIndex then
  local previous = guesses[tonumber(previousIndex) + 1]
  if not previous then
    return cjson.encode({kind='error', code='NO_ACTIVE_ROUND', reason='event_result_missing'})
  end
  return cjson.encode({
    kind='duplicate', feedback=previous, round=tonumber(meta[3]),
    revision=tonumber(meta[5] or 0)
  })
end
if meta[1] ~= 'playing' or not meta[2] or meta[2] == '' then
  return cjson.encode({kind='error', code='NO_ACTIVE_ROUND', reason='round_not_playing'})
end
if tonumber(meta[3]) ~= tonumber(ARGV[3]) then
  return cjson.encode({kind='error', code='STALE_ROUND', reason='round_id_mismatch'})
end
if tonumber(meta[2]) ~= tonumber(ARGV[6]) then
  return cjson.encode({kind='error', code='STALE_ROUND', reason='target_changed'})
end
if meta[4] and meta[4] ~= '' and tonumber(meta[4]) <= tonumber(ARGV[9]) then
  return cjson.encode({kind='error', code='NO_ACTIVE_ROUND', reason='deadline_passed'})
end
if player.socketId ~= ARGV[2] then return cjson.encode({kind='error', code='STALE_CONNECTION'}) end
if player.skipped == true then return cjson.encode({kind='error', code='ROUND_SKIPPED'}) end
if #guesses >= tonumber(ARGV[7]) then return cjson.encode({kind='error', code='GUESS_LIMIT_REACHED'}) end
for _, previous in ipairs(guesses) do
  if tonumber(previous.playerId) == tonumber(ARGV[4]) then
    return cjson.encode({kind='error', code='ALREADY_GUESSED'})
  end
end
local lastGuessAt = tonumber(player.lastGuessAt) or 0
local minGuessInterval = tonumber(ARGV[16]) or 0
if lastGuessAt > 0 and tonumber(ARGV[9]) - lastGuessAt < minGuessInterval then
  return cjson.encode({
    kind='error', code='GUESS_COOLDOWN',
    retryAfterMs=minGuessInterval - (tonumber(ARGV[9]) - lastGuessAt)
  })
end
local feedback = cjson.decode(ARGV[8])
local guessTimes = player.guessTimes or {}
if type(guessTimes) ~= 'table' then guessTimes = {} end
while #guessTimes < #guesses do table.insert(guessTimes, cjson.null) end
while #guessTimes > #guesses do table.remove(guessTimes) end
local now = tonumber(ARGV[9])
local roundDuration = math.max(0, tonumber(ARGV[17]) or 0)
local guessTime = 0
if meta[4] and meta[4] ~= '' then
  guessTime = now - (tonumber(meta[4]) - roundDuration)
  if guessTime < 0 then guessTime = 0 end
  if guessTime > roundDuration then guessTime = roundDuration end
end
table.insert(guesses, feedback)
table.insert(guessTimes, guessTime)
local guessCount = #guesses
redis.call('HSET', KEYS[8], identity, cjson.encode(guesses))
redis.call('HSET', KEYS[9], eventKey, guessCount - 1)
player.guessCount = guessCount
player.lastGuessAt = tonumber(ARGV[9])
player.guessTimes = guessTimes
if feedback.correct == true then player.score = tonumber(player.score or 0) + 1 end
redis.call('HSET', KEYS[7], identity, cjson.encode(player))
local allDone = true
local anySkipped = false
local playerStates = redis.call('HGETALL', KEYS[7])
for index = 2, #playerStates, 2 do
  local stateOk, candidate = pcall(cjson.decode, playerStates[index])
  if stateOk and candidate.skipped == true then anySkipped = true end
  if not stateOk or (candidate.skipped ~= true and tonumber(candidate.guessCount or 0) < tonumber(ARGV[7])) then
    allDone = false
    break
  end
end
local shouldFinish = feedback.correct == true or allDone
local matchOver = false
local status = meta[1]
local roundEndsAt = meta[4] or ''
local nextRoundAt = ''
local roundResult = ''
local matchResult = ''
if shouldFinish then
  matchOver = feedback.correct == true and tonumber(player.score or 0) >= math.ceil(tonumber(meta[6] or 1) / 2)
  roundEndsAt = ''
  if matchOver then
    status = 'finished'
    matchResult = cjson.encode({winnerKey=identity, reason='score'})
  else
    status = 'round_over'
    nextRoundAt = tostring(tonumber(ARGV[9]) + tonumber(ARGV[10]))
  end
  roundResult = cjson.encode({
    round=tonumber(meta[3]),
    winnerKey=feedback.correct == true and identity or cjson.null,
    reason=feedback.correct == true and 'guessed' or (anySkipped and 'skipped' or 'exhausted'),
    matchOver=matchOver,
    nextRoundAt=nextRoundAt == '' and cjson.null or tonumber(nextRoundAt)
  })
end
local revision = tonumber(meta[5] or 0) + 1
redis.call('HSET', KEYS[2],
  'targetPlayerId', meta[2], 'status', status, 'round', meta[3],
  'roundEndsAt', roundEndsAt, 'nextRoundAt', nextRoundAt,
  'roundResult', roundResult, 'matchResult', matchResult,
  'boType', meta[6], 'revision', revision, 'updatedAt', now)
redis.call('EXPIRE', KEYS[1], ARGV[11])
redis.call('EXPIRE', KEYS[2], ARGV[11])
redis.call('EXPIRE', KEYS[7], ARGV[11])
redis.call('EXPIRE', KEYS[8], ARGV[11])
redis.call('EXPIRE', KEYS[9], ARGV[11])
redis.call('EXPIRE', KEYS[10], ARGV[11])
if status == 'finished' then
  redis.call('ZREM', KEYS[3], ARGV[12])
  redis.call('ZADD', KEYS[4], ARGV[9], 'persist|' .. ARGV[12] .. '|0')
  redis.call('ZADD', KEYS[4], tonumber(ARGV[9]) + tonumber(ARGV[13]), 'cleanup|' .. ARGV[12] .. '|0')
else
  redis.call('ZADD', KEYS[3], tonumber(ARGV[9]) + tonumber(ARGV[11]) * 1000, ARGV[12])
  if shouldFinish then redis.call('ZADD', KEYS[4], tonumber(nextRoundAt), 'next|' .. ARGV[12] .. '|' .. tostring(meta[3])) end
end
local playerKeys = redis.call('HKEYS', KEYS[7])
return cjson.encode({
  kind='applied', feedback=feedback, round=tonumber(meta[3]),
  correct=feedback.correct == true, shouldFinish=shouldFinish, matchOver=matchOver,
  revision=revision, playerKeys=playerKeys
})
`;

export async function getRoomGuessTarget(
  roomId: string,
  expectedRound: number
): Promise<{ targetPlayerId: number; round: number } | null> {
  const cached = roomTargetCache.get(roomId);
  if (cached?.round === expectedRound) return cached;
  const client = stateRedis();
  if (!client) {
    const room = localRooms.get(roomId);
    return room?.targetPlayerId
      ? { targetPlayerId: room.targetPlayerId, round: room.round }
      : null;
  }
  const [targetRaw, roundRaw] = await client.hmGet(roomMetaKey(roomId), [
    'targetPlayerId',
    'round',
  ]);
  const targetPlayerId = Number(targetRaw);
  const round = Number(roundRaw);
  if (Number.isInteger(targetPlayerId) && targetPlayerId > 0 && round === expectedRound) {
    roomTargetCache.set(roomId, { round, targetPlayerId });
    return { round, targetPlayerId };
  }

  // Lazy upgrade for rooms created before the hot metadata hash existed.
  const room = await getRoom(roomId);
  if (!room?.targetPlayerId) return null;
  await client.hSet(roomMetaKey(roomId), {
    targetPlayerId: String(room.targetPlayerId),
    status: room.status,
    round: String(room.round),
    revision: String(room.revision),
    updatedAt: String(room.updatedAt),
  });
  await client.expire(roomMetaKey(roomId), ROOM_TTL_SECONDS);
  roomTargetCache.set(roomId, { round: room.round, targetPlayerId: room.targetPlayerId });
  return { round: room.round, targetPlayerId: room.targetPlayerId };
}

export async function applyRoomGuess(input: ApplyRoomGuessInput): Promise<ApplyRoomGuessResult> {
  const client = stateRedis();
  if (!client) {
    const result = await withRoomLock(input.roomId, (room): ApplyRoomGuessResult => {
      const eventKey = `${input.identity}:${input.eventId}`;
      const player = room.players.find((candidate) => candidate.key === input.identity);
      if (!player) return { kind: 'error', code: 'NO_ACTIVE_ROUND', reason: 'player_missing' };
      const previousIndex = room.eventResults[eventKey];
      if (previousIndex !== undefined) {
        const previous = player.guesses[previousIndex];
        return previous
          ? {
              kind: 'duplicate',
              feedback: previous,
              round: room.round,
              revision: room.revision,
            }
          : { kind: 'error', code: 'NO_ACTIVE_ROUND', reason: 'event_result_missing' };
      }
      if (room.status !== 'playing' || !room.targetPlayerId) {
        return { kind: 'error', code: 'NO_ACTIVE_ROUND', reason: 'round_not_playing' };
      }
      if (room.round !== input.expectedRound || room.targetPlayerId !== input.targetPlayerId) {
        return { kind: 'error', code: 'STALE_ROUND', reason: 'round_id_mismatch' };
      }
      const now = Date.now();
      if (room.roundEndsAt && room.roundEndsAt <= now) {
        return { kind: 'error', code: 'NO_ACTIVE_ROUND', reason: 'deadline_passed' };
      }
      if (player.socketId !== input.socketId) return { kind: 'error', code: 'STALE_CONNECTION' };
      if (player.skipped) return { kind: 'error', code: 'ROUND_SKIPPED' };
      if (player.guesses.length >= input.maxGuesses) {
        return { kind: 'error', code: 'GUESS_LIMIT_REACHED' };
      }
      if (player.guesses.some((previous) => previous.playerId === input.feedback.playerId)) {
        return { kind: 'error', code: 'ALREADY_GUESSED' };
      }
      const elapsed = player.lastGuessAt ? now - player.lastGuessAt : input.minGuessIntervalMs;
      if (elapsed < input.minGuessIntervalMs) {
        return {
          kind: 'error',
          code: 'GUESS_COOLDOWN',
          retryAfterMs: input.minGuessIntervalMs - elapsed,
        };
      }
      player.guessTimes = normalizeGuessTimes(player.guessTimes, player.guesses.length);
      const roundDurationMs = Math.max(0, Math.floor(input.roundDurationMs));
      const roundStartedAt = room.roundEndsAt === null ? now : room.roundEndsAt - roundDurationMs;
      const guessTime = Math.max(0, Math.min(roundDurationMs, Math.floor(now - roundStartedAt)));
      player.guesses.push(input.feedback);
      player.guessTimes.push(guessTime);
      player.lastGuessAt = now;
      room.eventResults[eventKey] = player.guesses.length - 1;
      const allDone = room.players.every(
        (candidate) => candidate.skipped || candidate.guesses.length >= input.maxGuesses
      );
      const shouldFinish = input.feedback.correct || allDone;
      let matchOver = false;
      if (shouldFinish) {
        if (input.feedback.correct) player.score += 1;
        matchOver = input.feedback.correct && player.score >= Math.ceil(room.boType / 2);
        room.roundEndsAt = null;
        if (matchOver) {
          room.status = 'finished';
          room.nextRoundAt = null;
          room.matchResult = {
            winnerKey: input.identity,
            reason: 'score',
            forfeitedKey: null,
          };
        } else {
          room.status = 'round_over';
          room.nextRoundAt = Date.now() + input.nextRoundDelayMs;
        }
        room.roundResult = {
          round: room.round,
          winnerKey: input.feedback.correct ? input.identity : null,
          reason: input.feedback.correct
            ? 'guessed'
            : room.players.some((candidate) => candidate.skipped) ? 'skipped' : 'exhausted',
          matchOver,
          nextRoundAt: room.nextRoundAt,
        };
      }
      return {
        kind: 'applied',
        feedback: input.feedback,
        round: room.round,
        correct: input.feedback.correct,
        shouldFinish,
        matchOver,
        revision: room.revision,
        playerKeys: room.players.map((candidate) => candidate.key),
        room,
      };
    }, (value) => value.kind === 'applied');
    if (!result) return { kind: 'error', code: 'NO_ACTIVE_ROUND', reason: 'room_missing' };
    return result;
  }
  const now = Date.now();
  const rateBucket = Math.floor(now / (input.rateWindowSeconds * 1000));
  const keys = [
    roomKey(input.roomId),
    roomMetaKey(input.roomId),
    redisKey('presence:rooms'),
    redisKey('room:schedules'),
    redisKey(`lock:room:${input.roomId}`),
    redisKey(`rl:socket:guess:${rateBucket}`),
    roomPlayersKey(input.roomId),
    roomGuessesKey(input.roomId),
    roomEventsKey(input.roomId),
    roomSpectatorsKey(input.roomId),
  ];
  const args = [
    input.identity,
    input.socketId,
    String(input.expectedRound),
    String(input.feedback.playerId),
    input.eventId,
    String(input.targetPlayerId),
    String(input.maxGuesses),
    JSON.stringify(input.feedback),
    String(now),
    String(input.nextRoundDelayMs),
    String(ROOM_TTL_SECONDS),
    input.roomId,
    String(FINISHED_ROOM_TTL_MS),
    String(input.rateLimit),
    String(input.rateWindowSeconds + 1),
    String(input.minGuessIntervalMs),
    String(input.roundDurationMs),
  ];
  let result = await evalStateScript('apply-room-guess-hash-v4', APPLY_ROOM_GUESS_HASH_SCRIPT, keys, args);
  if (typeof result !== 'string') throw new Error('INVALID_GUESS_RESULT');
  let parsed = JSON.parse(result) as ApplyRoomGuessResult;
  if (parsed.kind === 'error' && parsed.code === 'HOT_STATE_MISSING') {
    const room = await getRoom(input.roomId);
    if (!room) return { kind: 'error', code: 'NO_ACTIVE_ROUND', reason: 'room_missing' };
    await saveRoom(room);
    result = await evalStateScript('apply-room-guess-hash-v4', APPLY_ROOM_GUESS_HASH_SCRIPT, keys, args);
    if (typeof result !== 'string') throw new Error('INVALID_GUESS_RESULT');
    parsed = JSON.parse(result) as ApplyRoomGuessResult;
  }
  if (parsed.kind === 'applied' && parsed.shouldFinish) {
    const room = await getRoom(input.roomId);
    if (!room) return { kind: 'error', code: 'NO_ACTIVE_ROUND', reason: 'room_missing' };
    parsed.room = room;
  }
  return parsed;
}

export async function saveRoom(room: StoredRoom): Promise<void> {
  if (room.status === 'finished' && !room.matchResult) {
    throw new Error('INVALID_FINISHED_ROOM');
  }
  const previousRevision = room.revision ?? 0;
  room.updatedAt = Date.now();
  room.revision = previousRevision + 1;
  const client = stateRedis();
  if (!client) {
    const current = localRooms.get(room.id);
    if (current && current.revision > previousRevision) throw new Error('STALE_ROOM_WRITE');
    const currentMembers = new Set(
      current ? [...current.players, ...current.spectators].map((member) => member.key) : []
    );
    for (const member of [...room.players, ...room.spectators]) {
      const mappedRoomId = localIdentityRooms.get(member.key);
      const mappedRoom = mappedRoomId ? localRooms.get(mappedRoomId) : null;
      if (
        mappedRoomId &&
        mappedRoomId !== room.id &&
        mappedRoom &&
        mappedRoom.status !== 'finished' &&
        !currentMembers.has(member.key)
      ) {
        room.revision = previousRevision;
        throw new Error('ROOM_IDENTITY_CONFLICT');
      }
    }
    localRooms.set(room.id, structuredClone(room));
    if (room.targetPlayerId) {
      roomTargetCache.set(room.id, { round: room.round, targetPlayerId: room.targetPlayerId });
    } else {
      roomTargetCache.delete(room.id);
    }
    for (const member of [...room.players, ...room.spectators]) {
      const mappedRoomId = localIdentityRooms.get(member.key);
      const mappedRoom = mappedRoomId ? localRooms.get(mappedRoomId) : null;
      if (
        !mappedRoomId ||
        mappedRoomId === room.id ||
        !mappedRoom ||
        mappedRoom.status === 'finished'
      ) {
        localIdentityRooms.set(member.key, room.id);
      }
    }
    return;
  }
  const members = [...room.players, ...room.spectators];
  const schedules: { score: number; value: string }[] = [];
  if (room.status === 'waiting' && room.matchmaking && room.readyCheckEndsAt) {
    schedules.push({
      score: room.readyCheckEndsAt,
      value: `ready|${room.id}|0`,
    });
  } else if (room.status === 'starting' && room.nextRoundAt) {
    schedules.push({
      score: room.nextRoundAt,
      value: `start|${room.id}|0`,
    });
  } else if (room.status === 'playing' && room.roundEndsAt) {
    schedules.push({
      score: room.roundEndsAt,
      value: `round|${room.id}|${room.round}`,
    });
  } else if (room.status === 'round_over' && room.nextRoundAt) {
    schedules.push({
      score: room.nextRoundAt,
      value: `next|${room.id}|${room.round}`,
    });
  } else if (room.status === 'finished') {
    schedules.push(
      { score: Date.now(), value: `persist|${room.id}|0` },
      { score: Date.now() + FINISHED_ROOM_TTL_MS, value: `cleanup|${room.id}|0` }
    );
  }
  for (const player of room.players) {
    if (!player.connected && player.disconnectDeadline) {
      schedules.push({
        score: player.disconnectDeadline,
        value: `disconnect|${room.id}|${player.key}`,
      });
    }
  }
  for (const spectator of room.spectators) {
    if (!spectator.connected && spectator.disconnectDeadline) {
      schedules.push({
        score: spectator.disconnectDeadline,
        value: `spectator|${room.id}|${spectator.key}`,
      });
    }
  }
  const result = await evalCachedStateScript(
    'room-save-v5',
    `local incoming = cjson.decode(ARGV[1])
     local identityCount = tonumber(ARGV[6])
     local metaKey = KEYS[4 + identityCount]
     local playersKey = KEYS[5 + identityCount]
     local guessesKey = KEYS[6 + identityCount]
     local eventsKey = KEYS[7 + identityCount]
     local spectatorsKey = KEYS[8 + identityCount]
     local currentRaw = redis.call('GET', KEYS[1])
     local current = nil
     local currentOk = false
     if currentRaw then
       currentOk, current = pcall(cjson.decode, currentRaw)
     end
     local currentRevision = currentOk and tonumber(current.revision or 0) or 0
     local hotRevision = tonumber(redis.call('HGET', metaKey, 'revision') or 0)
     if math.max(currentRevision, hotRevision) >= tonumber(incoming.revision or 0) then return 0 end
     local currentMembers = {}
     if currentOk then
       for _, member in ipairs(current.players or {}) do currentMembers[member.key] = true end
       for _, member in ipairs(current.spectators or {}) do currentMembers[member.key] = true end
     end
     local incomingMembers = {}
     for _, member in ipairs(incoming.players or {}) do table.insert(incomingMembers, member) end
     for _, member in ipairs(incoming.spectators or {}) do table.insert(incomingMembers, member) end
     for index, member in ipairs(incomingMembers) do
       local mappedRoomId = redis.call('GET', KEYS[3 + index])
       if mappedRoomId and mappedRoomId ~= ARGV[2] then
         local mappedRoomRaw = redis.call('GET', ARGV[8] .. mappedRoomId)
         local mappedStatus = redis.call('HGET', ARGV[8] .. mappedRoomId .. ':meta', 'status')
         if mappedStatus then
           if mappedStatus ~= 'finished' and not currentMembers[member.key] then return -1 end
         elseif mappedRoomRaw then
           local mappedOk, mappedRoom = pcall(cjson.decode, mappedRoomRaw)
           if mappedOk and mappedRoom.status ~= 'finished' and not currentMembers[member.key] then
             return -1
           end
         end
       end
     end
     redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
     local function nullableNumber(value)
       if value == nil or value == cjson.null then return '' end
       return tostring(value)
     end
     local function nullableJson(value)
       if value == nil or value == cjson.null then return '' end
       return cjson.encode(value)
     end
     redis.call('HSET', metaKey,
       'targetPlayerId', nullableNumber(incoming.targetPlayerId),
       'status', incoming.status or '',
       'round', tostring(incoming.round or 0),
       'roundEndsAt', nullableNumber(incoming.roundEndsAt),
       'nextRoundAt', nullableNumber(incoming.nextRoundAt),
       'roundResult', nullableJson(incoming.roundResult),
       'matchResult', nullableJson(incoming.matchResult),
       'boType', tostring(incoming.boType or 1),
       'revision', tostring(incoming.revision or 0),
       'updatedAt', tostring(incoming.updatedAt or 0))
     redis.call('DEL', playersKey, guessesKey, eventsKey, spectatorsKey)
     for _, player in ipairs(incoming.players or {}) do
       local playerGuesses = player.guesses or {}
       local metadata = {
         key=player.key, userId=player.userId, name=player.name,
          socketId=player.socketId, ready=player.ready, score=player.score,
          connected=player.connected, disconnectDeadline=player.disconnectDeadline,
          guessCount=#playerGuesses, guessTimes=player.guessTimes or {},
          lastGuessAt=player.lastGuessAt, skipped=player.skipped == true
       }
       redis.call('HSET', playersKey, player.key, cjson.encode(metadata))
       redis.call('HSET', guessesKey, player.key,
         #playerGuesses == 0 and '[]' or cjson.encode(playerGuesses))
     end
     for eventKey, eventIndex in pairs(incoming.eventResults or {}) do
       redis.call('HSET', eventsKey, eventKey, tostring(eventIndex))
     end
     for _, spectator in ipairs(incoming.spectators or {}) do
       redis.call('HSET', spectatorsKey, spectator.key, cjson.encode(spectator))
     end
     redis.call('EXPIRE', metaKey, ARGV[3])
     redis.call('EXPIRE', playersKey, ARGV[3])
     redis.call('EXPIRE', guessesKey, ARGV[3])
     redis.call('EXPIRE', eventsKey, ARGV[3])
     redis.call('EXPIRE', spectatorsKey, ARGV[3])
     if ARGV[4] == '1' then
       redis.call('ZREM', KEYS[2], ARGV[2])
     else
       redis.call('ZADD', KEYS[2], ARGV[5], ARGV[2])
     end
     for index = 1, identityCount do
       local identityKey = KEYS[3 + index]
       local mappedRoomId = redis.call('GET', identityKey)
       local canClaim = not mappedRoomId or mappedRoomId == ARGV[2]
       if not canClaim then
         local mappedRoomRaw = redis.call('GET', ARGV[8] .. mappedRoomId)
         local mappedStatus = redis.call('HGET', ARGV[8] .. mappedRoomId .. ':meta', 'status')
         if mappedStatus then
           canClaim = mappedStatus == 'finished'
         elseif not mappedRoomRaw then
           canClaim = true
         else
           local mappedOk, mappedRoom = pcall(cjson.decode, mappedRoomRaw)
           canClaim = not mappedOk or mappedRoom.status == 'finished'
         end
       end
       if canClaim then redis.call('SET', identityKey, ARGV[2], 'EX', ARGV[3]) end
     end
     local scheduleCount = tonumber(ARGV[7])
     local argumentIndex = 9
     for index = 1, scheduleCount do
       redis.call('ZADD', KEYS[3], ARGV[argumentIndex], ARGV[argumentIndex + 1])
       argumentIndex = argumentIndex + 2
     end
     return 1`,
    {
      keys: [
        roomKey(room.id),
        redisKey('presence:rooms'),
        redisKey('room:schedules'),
        ...members.map((member) => identityKey(member.key)),
        roomMetaKey(room.id),
        roomPlayersKey(room.id),
        roomGuessesKey(room.id),
        roomEventsKey(room.id),
        roomSpectatorsKey(room.id),
      ],
      arguments: [
        JSON.stringify(room),
        room.id,
        String(ROOM_TTL_SECONDS),
        room.status === 'finished' ? '1' : '0',
        String(room.updatedAt + ROOM_TTL_SECONDS * 1000),
        String(members.length),
        String(schedules.length),
        redisKey('room:'),
        ...schedules.flatMap((item) => [String(item.score), item.value]),
      ],
    }
  );
  if (Number(result) === -1) {
    room.revision = previousRevision;
    throw new Error('ROOM_IDENTITY_CONFLICT');
  }
  if (Number(result) !== 1) {
    room.revision = previousRevision;
    throw new Error('STALE_ROOM_WRITE');
  }
  if (room.targetPlayerId) {
    roomTargetCache.set(room.id, { round: room.round, targetPlayerId: room.targetPlayerId });
  } else {
    roomTargetCache.delete(room.id);
  }
}

export async function deleteRoom(room: StoredRoom): Promise<void> {
  const identities = [...room.players, ...room.spectators].map((p) => p.key);
  const client = stateRedis();
  if (!client) {
    localRooms.delete(room.id);
    roomTargetCache.delete(room.id);
    for (const identity of identities) {
      if (localIdentityRooms.get(identity) === room.id) localIdentityRooms.delete(identity);
    }
    return;
  }
  await evalCachedStateScript(
    'room-delete-v1',
    `redis.call('DEL', KEYS[1])
     redis.call('DEL', KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[9])
     redis.call('ZREM', KEYS[2], ARGV[1])
     redis.call('ZREM', KEYS[3], ARGV[1])
     redis.call('ZREM', KEYS[4], ARGV[1])
     for index = 10, #KEYS do
       if redis.call('GET', KEYS[index]) == ARGV[1] then redis.call('DEL', KEYS[index]) end
     end
     return 1`,
    {
      keys: [
        roomKey(room.id),
        redisKey('rooms:active'),
        redisKey(`rooms:active:ip:${room.ownerIp}`),
        redisKey('presence:rooms'),
        roomMetaKey(room.id),
        roomPlayersKey(room.id),
        roomGuessesKey(room.id),
        roomEventsKey(room.id),
        roomSpectatorsKey(room.id),
        ...identities.map(identityKey),
      ],
      arguments: [room.id],
    }
  );
  roomTargetCache.delete(room.id);
}

export async function reserveRoomCapacity(ip: string, roomId: string): Promise<boolean> {
  const client = stateRedis();
  if (!client) return true;
  const result = await evalCachedStateScript(
    'room-capacity-reserve-v1',
    `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
     redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
     if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
     if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return 0 end
     redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
     redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
     redis.call('expire', KEYS[2], ARGV[6])
     return 1`,
    {
      keys: [redisKey('rooms:active'), redisKey(`rooms:active:ip:${ip}`)],
      arguments: [
        String(Date.now() - ROOM_TTL_SECONDS * 1000),
        String(MAX_GLOBAL_ROOMS),
        String(MAX_ROOMS_PER_IP),
        String(Date.now()),
        roomId,
        String(ROOM_TTL_SECONDS),
      ],
    }
  );
  return Number(result) === 1;
}

export async function releaseRoomCapacity(ip: string, roomId: string): Promise<void> {
  const client = stateRedis();
  if (!client) return;
  await Promise.all([
    client.zRem(redisKey('rooms:active'), roomId),
    client.zRem(redisKey(`rooms:active:ip:${ip}`), roomId),
  ]);
}

export async function clearIdentityRoom(identity: string, expectedRoomId?: string): Promise<void> {
  if (!expectedRoomId || localIdentityRooms.get(identity) === expectedRoomId) {
    localIdentityRooms.delete(identity);
  }
  const client = stateRedis();
  if (!client) return;
  if (!expectedRoomId) {
    await client.del(identityKey(identity));
    return;
  }
  await evalCachedStateScript(
    'room-identity-clear-v1',
    `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
     return 0`,
    { keys: [identityKey(identity)], arguments: [expectedRoomId] }
  );
}

async function acquireRedisLock(id: string): Promise<(() => Promise<void>) | null> {
  const client = stateRedis();
  if (!client) return null;
  const token = randomUUID();
  const key = redisKey(`lock:room:${id}`);
  const deadline = Date.now() + config.roomLockWaitMs;
  let attempt = 0;
  do {
    if (await client.set(key, token, { NX: true, PX: 15_000 })) {
      return async () => {
        await evalCachedStateScript(
          'room-lock-release-v1',
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          { keys: [key], arguments: [token] }
        );
      };
    }
    const delay = Math.min(50, 8 + attempt * 4) + Math.floor(Math.random() * 8);
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
  } while (Date.now() < deadline);
  throw new Error('ROOM_BUSY');
}

export async function withRoomLock<T>(
  id: string,
  handler: (room: StoredRoom) => Promise<T> | T,
  shouldSave: (result: T) => boolean = () => true
): Promise<T | null> {
  const releaseRedis = await acquireRedisLock(id);
  if (releaseRedis) {
    try {
      const room = await getRoom(id);
      if (!room) return null;
      const result = await handler(room);
      if (shouldSave(result)) {
        await saveRoom(room);
        syncResultRoomVersion(result, room);
      }
      return result;
    } finally {
      await releaseRedis().catch((err) => logTransientError('[room:lock-release]', err));
    }
  }

  const previous = localLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  localLocks.set(id, queued);
  await previous;
  try {
    const room = await getRoom(id);
    if (!room) return null;
    const result = await handler(room);
    if (shouldSave(result)) {
      await saveRoom(room);
      syncResultRoomVersion(result, room);
    }
    return result;
  } finally {
    release();
    if (localLocks.get(id) === queued) localLocks.delete(id);
  }
}

function syncResultRoomVersion<T>(result: T, room: StoredRoom): void {
  if (!result || typeof result !== 'object' || !('room' in result)) return;
  const snapshot = (result as { room?: StoredRoom }).room;
  if (!snapshot) return;
  snapshot.revision = room.revision;
  snapshot.updatedAt = room.updatedAt;
}

export async function removeExpiredSpectators(
  roomId: string,
  identities: string[],
  now = Date.now()
): Promise<{ room: StoredRoom; removedKeys: string[] } | null> {
  const candidates = new Set(identities);
  const result = await withRoomLock(roomId, (room) => {
    const removedKeys: string[] = [];
    room.spectators = room.spectators.filter((spectator) => {
      if (
        candidates.has(spectator.key) &&
        !spectator.connected &&
        spectator.disconnectDeadline !== null &&
        spectator.disconnectDeadline <= now
      ) {
        removedKeys.push(spectator.key);
        return false;
      }
      return true;
    });
    return { room, removedKeys };
  }, (value) => value.removedKeys.length > 0);
  if (!result) return null;
  await Promise.all(result.removedKeys.map((identity) => clearIdentityRoom(identity, roomId)));
  return result;
}

export async function queueOrTakeOpponent(
  dbType: DbType,
  identity: QueuedIdentity
): Promise<QueuedIdentity | null> {
  const client = stateRedis();
  if (!client) return null;
  const pool = identity.matchmakingPool ?? 'verified';
  const queueName = matchmakingQueueName(dbType, pool);
  const queueKey = matchmakingQueueKey(dbType, pool);
  const profilePrefix = redisKey('match-profile:');
  if (pool === 'restricted') {
    await evalCachedStateScript(
      'matchmaking-queue-restricted-v1',
      `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[6])
       redis.call('ZADD', KEYS[1], ARGV[4], ARGV[1])
       redis.call('SET', ARGV[2] .. ARGV[1], ARGV[5], 'EX', 300)
       redis.call('SET', ARGV[3] .. ARGV[1], ARGV[7], 'EX', 300)
       return 1`,
      {
        keys: [queueKey],
        arguments: [
          identity.key,
          profilePrefix,
          redisKey('match-queue:'),
          String(Date.now()),
          JSON.stringify(identity),
          String(Date.now() - MATCHMAKING_ENTRY_TTL_MS),
          queueName,
        ],
      }
    );
    return null;
  }
  const result = await evalCachedStateScript(
    'matchmaking-take-or-queue-v1',
    `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[8])
     local candidates = redis.call('ZRANGE', KEYS[1], 0, 20)
     for _, candidate in ipairs(candidates) do
       if candidate ~= ARGV[1] and redis.call('ZREM', KEYS[1], candidate) == 1 then
         local profile = redis.call('GET', ARGV[2] .. candidate)
         if profile then
           local decodedOk, decoded = pcall(cjson.decode, profile)
           if decodedOk and decoded.socketId and redis.call('EXISTS', ARGV[3] .. decoded.socketId) == 1 then
             redis.call('DEL', ARGV[2] .. candidate)
             redis.call('DEL', ARGV[6] .. candidate)
             return profile
           end
         end
         redis.call('DEL', ARGV[2] .. candidate)
         redis.call('DEL', ARGV[6] .. candidate)
       end
     end
     redis.call('ZADD', KEYS[1], ARGV[4], ARGV[1])
     redis.call('SET', ARGV[2] .. ARGV[1], ARGV[5], 'EX', 300)
     redis.call('SET', ARGV[6] .. ARGV[1], ARGV[7], 'EX', 300)
     return false`,
    {
      keys: [queueKey],
      arguments: [
        identity.key,
        profilePrefix,
        redisKey('connections:socket:'),
        String(Date.now()),
        JSON.stringify(identity),
        redisKey('match-queue:'),
        queueName,
        String(Date.now() - MATCHMAKING_ENTRY_TTL_MS),
      ],
    }
  );
  return typeof result === 'string' ? JSON.parse(result) as QueuedIdentity : null;
}

export async function requeueCandidate(dbType: DbType, identity: QueuedIdentity): Promise<void> {
  const client = stateRedis();
  if (!client) return;
  const pool = identity.matchmakingPool ?? 'verified';
  const queueName = matchmakingQueueName(dbType, pool);
  await evalCachedStateScript(
    'matchmaking-requeue-v1',
    `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[5])
     if redis.call('EXISTS', KEYS[3]) == 0 then return 0 end
     redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
     redis.call('SET', KEYS[2], ARGV[3], 'EX', 300)
     redis.call('SET', KEYS[4], ARGV[4], 'EX', 300)
     return 1`,
    {
      keys: [
        matchmakingQueueKey(dbType, pool),
        redisKey(`match-profile:${identity.key}`),
        redisKey(`connections:socket:${identity.socketId}`),
        redisKey(`match-queue:${identity.key}`),
      ],
      arguments: [
        identity.key,
        String(Date.now()),
        JSON.stringify(identity),
        queueName,
        String(Date.now() - MATCHMAKING_ENTRY_TTL_MS),
      ],
    }
  );
}

export async function moveQueuedIdentityToPool(
  identity: string,
  pool: MatchmakingPool
): Promise<void> {
  const client = stateRedis();
  if (!client) return;
  const queueIndex = redisKey(`match-queue:${identity}`);
  const oldQueueName = await client.get(queueIndex);
  if (!oldQueueName) return;
  const prefix = oldQueueName.match(/^(restricted|verified):/);
  const dbType = prefix ? oldQueueName.slice(prefix[0].length) : oldQueueName;
  if (!dbType) return;
  const newQueueName = matchmakingQueueName(dbType, pool);
  if (newQueueName === oldQueueName) return;

  await evalCachedStateScript(
    'matchmaking-move-pool-v1',
    `if redis.call('GET', KEYS[4]) ~= ARGV[2] then return 0 end
     local profile = redis.call('GET', KEYS[3])
     if not profile then
       redis.call('ZREM', KEYS[1], ARGV[1])
       redis.call('DEL', KEYS[4])
       return 0
     end
     local decodedOk, decoded = pcall(cjson.decode, profile)
     if not decodedOk then
       redis.call('ZREM', KEYS[1], ARGV[1])
       redis.call('DEL', KEYS[3], KEYS[4])
       return 0
     end
     local score = redis.call('ZSCORE', KEYS[1], ARGV[1]) or ARGV[5]
     redis.call('ZREM', KEYS[1], ARGV[1])
     local targetPool = ARGV[4]
     decoded.matchmakingPool = targetPool
     local destination = KEYS[2]
     local finalQueue = ARGV[3]
     redis.call('ZREMRANGEBYSCORE', destination, '-inf', ARGV[6])
     redis.call('ZADD', destination, score, ARGV[1])
     redis.call('SET', KEYS[3], cjson.encode(decoded), 'EX', 300)
     redis.call('SET', KEYS[4], finalQueue, 'EX', 300)
     return 1`,
    {
      keys: [
        redisKey(`matchmaking:${oldQueueName}`),
        redisKey(`matchmaking:${newQueueName}`),
        redisKey(`match-profile:${identity}`),
        queueIndex,
      ],
      arguments: [
        identity,
        oldQueueName,
        newQueueName,
        pool,
        String(Date.now()),
        String(Date.now() - MATCHMAKING_ENTRY_TTL_MS),
        dbType,
      ],
    }
  );
}

export async function isSocketAlive(socketId: string): Promise<boolean> {
  const client = stateRedis();
  if (!client) return true;
  return (await client.exists(redisKey(`connections:socket:${socketId}`))) === 1;
}

export async function cancelQueue(identity: string, socketId?: string): Promise<void> {
  const client = stateRedis();
  if (!client) return;
  const queueIndex = redisKey(`match-queue:${identity}`);
  const profileKey = redisKey(`match-profile:${identity}`);
  const queueName = await client.get(queueIndex);
  const queueKey = queueName ? redisKey(`matchmaking:${queueName}`) : null;
  if (!queueKey) {
    if (socketId) {
      const rawProfile = await client.get(profileKey);
      if (rawProfile) {
        try {
          const profile = JSON.parse(rawProfile) as { socketId?: unknown };
          if (profile.socketId !== socketId) return;
        } catch {
          return;
        }
      }
    }
    await Promise.all([
      ...DIFFICULTY_LEVELS.map((difficulty) => Promise.all([
        client.zRem(matchmakingQueueKey(difficulty.key, 'restricted'), identity),
        client.zRem(matchmakingQueueKey(difficulty.key, 'verified'), identity),
      ])),
      client.del(profileKey),
      client.del(queueIndex),
    ]);
    return;
  }
  if (socketId) {
    await evalCachedStateScript(
      'matchmaking-cancel-socket-v1',
      `local profile = redis.call('GET', KEYS[2])
       if not profile then return 0 end
       local decodedOk, decoded = pcall(cjson.decode, profile)
       if not decodedOk or decoded.socketId ~= ARGV[2] then return 0 end
       redis.call('ZREM', KEYS[1], ARGV[1])
       redis.call('DEL', KEYS[2], KEYS[3])
       return 1`,
      {
        keys: [
          queueKey,
          profileKey,
          queueIndex,
        ],
        arguments: [identity, socketId],
      }
    );
    return;
  }
  await Promise.all([
    queueKey ? client.zRem(queueKey, identity) : Promise.resolve(0),
    client.del(profileKey),
    client.del(queueIndex),
  ]);
}

export async function schedule(
  kind: string,
  roomId: string,
  discriminator: string,
  at: number
): Promise<boolean> {
  const client = stateRedis();
  if (!client) return false;
  await client.zAdd(redisKey('room:schedules'), {
    score: at,
    value: `${kind}|${roomId}|${discriminator}`,
  });
  return true;
}

export async function claimDueSchedules(limit = 100): Promise<string[]> {
  const client = stateRedis();
  if (!client) return [];
  const now = Date.now();
  return evalCachedStateScript(
    'room-schedule-claim-v1',
    `local items = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
     for _, item in ipairs(items) do
       redis.call('ZADD', KEYS[1], 'XX', ARGV[3], item)
     end
     return items`,
    {
      keys: [redisKey('room:schedules')],
      arguments: [String(now), String(limit), String(now + 15_000)],
    }
  ) as Promise<string[]>;
}

export async function acknowledgeSchedule(item: string): Promise<void> {
  await stateRedis()?.zRem(redisKey('room:schedules'), item);
}

export async function beginMaintenanceWindow(durationMs = 90_000): Promise<number> {
  const until = Date.now() + durationMs;
  const client = stateRedis();
  if (client) {
    await client.set(redisKey('maintenance:until'), String(until), {
      PX: durationMs,
    });
  }
  return until;
}

export async function getMaintenanceUntil(): Promise<number> {
  const client = stateRedis();
  if (!client) return 0;
  return Number(await client.get(redisKey('maintenance:until'))) || 0;
}

export async function setRecoveryWindow(durationMs: number): Promise<void> {
  const client = stateRedis();
  if (!client) return;
  if (durationMs <= 0) {
    await client.del(redisKey('maintenance:until'));
    return;
  }
  const until = Date.now() + durationMs;
  await client.set(redisKey('maintenance:until'), String(until), { PX: durationMs });
}
