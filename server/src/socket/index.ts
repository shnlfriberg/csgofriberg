import { Server, Socket } from 'socket.io';
import { isIP } from 'net';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  authenticateCookie,
  getGuestFromCookie,
  hasAuthSessionCookie,
  guestNameFromKey,
  userNameFromUsername,
} from '../middleware/auth';
import { consumeRateLimit } from '../middleware/rateLimit';
import { compareGuess, completeGuessFeedback, MAX_GUESSES } from '../services/gameService';
import {
  getEnabledPlayer,
  getPlayer,
  isDifficultyAvailable,
} from '../services/playerCache';
import {
  BoType,
  DbType,
  StoredIdentity,
  QueuedIdentity,
  StoredPlayer,
  StoredRoom,
  StoredMatchReport,
  applyRoomGuess,
  acknowledgeSchedule,
  beginMaintenanceWindow,
  cancelQueue,
  claimDueSchedules,
  clearIdentityRoom,
  deleteRoom,
  getRoom,
  getRoomForIdentity,
  getRoomGuessTarget,
  getRoomIdForIdentity,
  getMaintenanceUntil,
  setRecoveryWindow,
  isSocketAlive,
  queueOrTakeOpponent,
  requeueCandidate,
  removeExpiredSpectators,
  releaseRoomCapacity,
  reserveRoomCapacity,
  saveRoom,
  schedule,
  withRoomLock,
} from '../services/roomStore';
import {
  evalCommandScript,
  isRedisAvailable,
  isRedisTimeoutError,
  redis,
  redisKey,
} from '../redis';
import { enqueueMatchResult } from '../services/matchResultQueue';
import { getPresenceStats, ONLINE_STALE_MS, PresenceStats } from '../services/presence';
import { GuessFeedback, Player } from '../types';
import { config } from '../config';
import { logTransientError, logTransientWarning } from '../services/transientLog';
import { getResourceVersionNotice } from '../services/resourceVersion';
import { getPlayerPerformance } from '../services/playerPerformance';
import {
  clearMatchmakingCooldown,
  getMatchmakingCooldown,
  readyExitPenaltyMultiplier,
  recordMatchmakingExit,
} from '../services/matchmakingCooldown';
import { isMatchmakingRestricted } from '../services/matchmakingRestriction';
import { isGuestBanned, isGuestMatchmakingRestricted, recordGuestSeen } from '../services/guestAccounts';
import { pickTargetAvoidingRecent, rememberTargetSelection } from '../services/targetSelection';

const NEXT_ROUND_DELAY_MS = 6_000;
const ROUND_TIME_MS = 120_000;
const MULTI_GUESS_INTERVAL_MS = 1_500;
const FINISHED_ROOM_TTL_MS = 5 * 60_000;
const LOCAL_GUESS_LIMIT = 12;
const LOCAL_GUESS_WINDOW_MS = 10_000;
const localGuessBuckets = new Map<string, { count: number; expiresAt: number }>();

function allowLocalGuess(identity: string): boolean {
  const now = Date.now();
  const current = localGuessBuckets.get(identity);
  if (!current || current.expiresAt <= now) {
    if (localGuessBuckets.size >= 10_000) {
      for (const [key, bucket] of localGuessBuckets) {
        if (bucket.expiresAt <= now) localGuessBuckets.delete(key);
      }
    }
    localGuessBuckets.set(identity, { count: 1, expiresAt: now + LOCAL_GUESS_WINDOW_MS });
    return true;
  }
  if (current.count >= LOCAL_GUESS_LIMIT) return false;
  current.count += 1;
  return true;
}
const MAX_SPECTATORS = 100;
const MAX_CONNECTIONS_PER_IDENTITY = 3;
const MAX_CONNECTIONS_PER_IP = 20;
const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const localQueue = new Map<string, QueuedIdentity[]>();
const timers = new Map<string, NodeJS.Timeout>();
const difficultyKeySchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const roomPlayerStatsPayloadSchema = z.object({
  playerKey: z.string().min(1).max(256),
});
const roomCreatePayloadSchema = z.object({
  dbType: difficultyKeySchema,
  boType: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)]).default(3),
  allowSpectators: z.boolean().default(false),
  verifiedOnly: z.boolean().default(false),
  anonymous: z.boolean().default(false),
});
const roomJoinPayloadSchema = z.object({
  roomId: z.string().trim().toUpperCase().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/),
  spectate: z.boolean().default(false),
});
const rematchResponsePayloadSchema = z.object({ accept: z.boolean() });
const roomReadyPayloadSchema = z.object({ ready: z.boolean().optional() }).default({});
const matchReportPayloadSchema = z.object({
  description: z.string().trim().max(50).default(''),
});
const gameGuessPayloadSchema = z.object({
  playerId: z.number().int().positive(),
  roundId: z.number().int().nonnegative(),
  eventId: z.string().regex(/^[\w-]{16,80}$/),
});
const activeRoundPayloadSchema = z.object({ roundId: z.number().int().positive() });
const matchStartPayloadSchema = z.object({
  dbType: difficultyKeySchema,
  anonymous: z.boolean().default(false),
  verifiedOnly: z.boolean().default(false),
});

function validForwardedIp(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : null;
}

/** Match Express `trust proxy = 1`: trust only the address appended by the nearest proxy. */
export function resolveSocketIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  realIp: string | string[] | undefined,
  trustProxy: boolean
): string {
  if (trustProxy) {
    const forwarded = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const nearestForwarded = forwarded?.split(',').at(-1);
    const fromForwarded = validForwardedIp(nearestForwarded);
    if (fromForwarded) return fromForwarded;

    const real = Array.isArray(realIp) ? realIp.at(-1) : realIp;
    const fromRealIp = validForwardedIp(real);
    if (fromRealIp) return fromRealIp;
  }
  return validForwardedIp(remoteAddress) ?? 'unknown';
}

function winsNeeded(bo: BoType): number {
  return Math.ceil(bo / 2);
}

function identityChannel(key: string): string {
  return `identity:${key}`;
}

function spectatorChannel(roomId: string): string {
  return `room:${roomId}:spectators`;
}

function joinRoomChannels(socket: Socket, room: StoredRoom, identity: string): void {
  socket.join(room.id);
  if (room.spectators.some((spectator) => spectator.key === identity)) {
    socket.join(spectatorChannel(room.id));
  } else {
    socket.leave(spectatorChannel(room.id));
  }
}

function visibleGuess(feedback: GuessFeedback) {
  const { region: _region, ...attributes } = feedback.attributes;
  return { ...feedback, attributes };
}

function hiddenGuess(feedback: GuessFeedback) {
  const hideAttribute = ({ level, hint }: GuessFeedback['attributes']['team']) => ({
    level,
    ...(hint ? { hint } : {}),
  });
  return {
    hidden: true as const,
    correct: feedback.correct,
    attributes: {
      nationality: hideAttribute(feedback.attributes.nationality),
      team: hideAttribute(feedback.attributes.team),
      age: hideAttribute(feedback.attributes.age),
      role: hideAttribute(feedback.attributes.role),
      majorChampionships: hideAttribute(feedback.attributes.majorChampionships),
      majorAppearances: hideAttribute(feedback.attributes.majorAppearances),
      isActive: hideAttribute(feedback.attributes.isActive),
    },
  };
}

function connectedSpectatorCount(room: StoredRoom): number {
  return room.spectators.reduce((count, spectator) => count + (spectator.connected ? 1 : 0), 0);
}

function identityDisplayName(identity: StoredIdentity): string {
  if (identity.userId !== null) {
    return /^用户#[0-9A-Z]{5}$/.test(identity.name)
      ? identity.name
      : userNameFromUsername(identity.name);
  }
  if (identity.key.startsWith('g:')) {
    return /^访客#[0-9A-Z]{5}$/.test(identity.name)
      ? identity.name
      : guestNameFromKey(identity.key.slice(2));
  }
  return identity.name;
}

function replayAnswer(target: Player) {
  return {
    id: target.id,
    nickname: target.nickname,
    nationality: target.nationality,
    region: target.region,
    team: target.team,
    age: target.age,
    role: target.role,
    majorChampionships: target.major_championships,
    majorAppearances: target.major_appearances,
    isActive: Boolean(target.is_active),
  };
}

function replayGuesses(target: Player, playerIds: number[]) {
  return playerIds.slice(0, MAX_GUESSES).flatMap((playerId) => {
    const guess = getPlayer(playerId);
    return guess ? [visibleGuess(compareGuess(guess, target))] : [];
  });
}

function buildMatchReplay(room: StoredRoom, viewerKey: string) {
  if (room.status !== 'finished' || !room.matchResult || room.players.length !== 2) return null;
  const me = room.players.find((player) => player.key === viewerKey);
  const opponent = room.players.find((player) => player.key !== viewerKey);
  if (!me || !opponent) return null;

  return {
    id: room.recordId,
    mode: room.dbType,
    boType: room.boType,
    finishedAt: new Date(room.updatedAt).toISOString(),
    result: room.matchResult.winnerKey === me.key
      ? 'won' as const
      : room.matchResult.winnerKey === opponent.key
        ? 'lost' as const
        : 'draw' as const,
    me: { score: me.score },
    opponent: {
      displayId: identityDisplayName(opponent),
      score: opponent.score,
    },
    rounds: room.replayRounds.flatMap((round) => {
      const target = getPlayer(round.targetPlayerId);
      if (!target) return [];
      return [{
        round: round.round,
        reason: round.reason,
        winner: round.winnerKey === me.key
          ? 'me' as const
          : round.winnerKey === opponent.key
            ? 'opponent' as const
            : null,
        answer: replayAnswer(target),
        me: { guesses: replayGuesses(target, round.guessesByPlayer[me.key] ?? []) },
        opponent: {
          guesses: replayGuesses(target, round.guessesByPlayer[opponent.key] ?? []),
        },
      }];
    }),
  };
}

function buildPublicRoom(room: StoredRoom, viewerKey: string) {
  const viewerIsSpectator = room.spectators.some((spectator) => spectator.key === viewerKey);
  const roundIsComplete = room.status === 'round_over' || room.status === 'finished';
  const target = room.targetPlayerId ? getPlayer(room.targetPlayerId) : undefined;
  const matchReplay = buildMatchReplay(room, viewerKey);
  return {
    id: room.id,
    hostKey: room.hostKey,
    status: room.status === 'starting' ? 'waiting' : room.status,
    matchmaking: room.matchmaking,
    readyCheckEndsAt: room.readyCheckEndsAt,
    dbType: room.dbType,
    boType: room.boType,
    rematchAllowed: room.rematchAllowed,
    rematchInvite: room.rematchInviterKey
      ? { inviterKey: room.rematchInviterKey }
      : null,
    allowSpectators: room.allowSpectators,
    verifiedOnly: room.verifiedOnly,
    anonymous: room.anonymous,
    round: room.round,
    winsNeeded: winsNeeded(room.boType),
    maxGuesses: MAX_GUESSES,
    roundEndsAt: room.roundEndsAt,
    matchStartsAt: room.status === 'starting' ? room.nextRoundAt : null,
    roundId: room.round,
    stateVersion: room.revision,
    spectatorCount: connectedSpectatorCount(room),
    roundResult: room.matchResult || !room.roundResult
      ? null
      : {
          winnerKey: room.roundResult.winnerKey,
          reason: room.roundResult.reason,
          nextRoundAt: room.roundResult.nextRoundAt,
          answer: answerView(room.targetPlayerId),
        },
    matchResult: room.matchResult
      ? {
          winnerKey: room.matchResult.winnerKey,
          reason: room.matchResult.reason,
          answer: answerView(room.targetPlayerId),
        }
      : null,
    reportSubmitted: room.matchmaking && room.reports.some((report) => report.reporterKey === viewerKey),
    ...(matchReplay ? { matchReplay } : {}),
    players: room.players.map((p) => {
      const guesses = p.guesses.map((feedback) => {
        const guess = getPlayer(feedback.playerId);
        return completeGuessFeedback(feedback, guess, target);
      });
      return {
        key: p.key,
        name: identityDisplayName(p),
        ready: p.ready,
        connected: p.connected,
        score: p.score,
        skipped: p.skipped,
        guessCount: guesses.length,
        guesses: viewerIsSpectator || roundIsComplete || p.key === viewerKey
          ? guesses.map(visibleGuess)
          : guesses.map(hiddenGuess),
      };
    }),
  };
}

type PublicRoom = ReturnType<typeof buildPublicRoom>;
type RoomPatchChanges = {
  hostKey?: string;
  players?: {
    added?: PublicRoom['players'];
    updated?: Array<Partial<PublicRoom['players'][number]> & { key: string }>;
    removed?: string[];
  };
  spectatorCount?: number;
};
const publicRoomCache = new WeakMap<StoredRoom, {
  revision: number;
  views: Map<string, PublicRoom>;
}>();

function publicRoom(room: StoredRoom, viewerKey: string): PublicRoom {
  const spectator = room.spectators.some((candidate) => candidate.key === viewerKey);
  const cacheKey = spectator ? 'spectator' : viewerKey;
  let cached = publicRoomCache.get(room);
  if (!cached || cached.revision !== room.revision) {
    cached = { revision: room.revision, views: new Map() };
    publicRoomCache.set(room, cached);
  }
  const existing = cached.views.get(cacheKey);
  if (existing) return existing;
  const view = buildPublicRoom(room, viewerKey);
  cached.views.set(cacheKey, view);
  return view;
}

function emitRoomViews<T>(
  io: Server,
  room: StoredRoom,
  event: string,
  payload: (viewerKey: string) => T
): void {
  for (const player of room.players) {
    io.to(identityChannel(player.key)).emit(event, payload(player.key));
  }
  if (room.spectators.length) {
    const channels = room.spectators.map((spectator) => identityChannel(spectator.key));
    io.to(channels).emit(event, payload(room.spectators[0].key));
  }
}

function emitRoomPatch(io: Server, room: StoredRoom, changes: RoomPatchChanges): void {
  const channels = [...room.players, ...room.spectators]
    .map((member) => identityChannel(member.key));
  if (!channels.length) return;
  io.to(channels).emit('room:patch', {
    roomId: room.id,
    baseVersion: Math.max(0, room.revision - 1),
    stateVersion: room.revision,
    ...changes,
  });
}

function answerView(targetPlayerId: number | null) {
  const target = targetPlayerId ? getPlayer(targetPlayerId) : null;
  return target
    ? {
        nickname: target.nickname,
        team: target.team,
        nationality: target.nationality,
        region: target.region,
        role: target.role,
        majorChampionships: target.major_championships,
        majorAppearances: target.major_appearances,
      }
    : null;
}

async function genRoomId(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = Array.from(
      { length: 5 },
      () => ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)]
    ).join('');
    if (!(await getRoom(id))) return id;
  }
  throw new Error('ROOM_ID_EXHAUSTED');
}

function makePlayer(identity: StoredIdentity, socketId: string, ready: boolean): StoredPlayer {
  return {
    key: identity.key,
    userId: identity.userId,
    name: identity.name,
    socketId,
    ready,
    score: 0,
    guesses: [],
    guessTimes: [],
    lastGuessAt: null,
    skipped: false,
    connected: true,
    disconnectDeadline: null,
  };
}

function appendReplayRound(room: StoredRoom): void {
  const result = room.roundResult;
  if (!result || !room.targetPlayerId) return;
  if (room.replayRounds.some((round) => round.round === result.round)) return;
  room.replayRounds.push({
    round: result.round,
    targetPlayerId: room.targetPlayerId,
    winnerKey: result.winnerKey,
    reason: result.reason,
    guessesByPlayer: Object.fromEntries(
      room.players.map((player) => [player.key, player.guesses.map((guess) => guess.playerId)])
    ),
    guessTimesByPlayer: Object.fromEntries(
      room.players.map((player) => [player.key, player.guessTimes.slice()])
    ),
  });
  if (room.replayRounds.length > 30) room.replayRounds = room.replayRounds.slice(-30);
}

async function recordReplayRound(roomId: string, expectedRound: number): Promise<StoredRoom | null> {
  const result = await withRoomLock(roomId, (room) => {
    if (room.round !== expectedRound || !room.roundResult) return null;
    appendReplayRound(room);
    return { room };
  }, (value) => Boolean(value));
  return result?.room ?? null;
}

function setLocalTimer(key: string, delay: number, handler: () => void | Promise<unknown>) {
  const old = timers.get(key);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    timers.delete(key);
    void Promise.resolve()
      .then(handler)
      .catch((err) => logTransientError(`[timer:${key.split(':', 1)[0]}]`, err));
  }, Math.max(0, delay));
  timer.unref?.();
  timers.set(key, timer);
}

async function persistMatch(
  room: StoredRoom,
  winnerKey: string | null,
  forfeitedKey: string | null = room.matchResult?.forfeitedKey ?? null
) {
  await enqueueMatchResult({
    recordId: room.recordId,
    dbType: room.dbType,
    boType: room.boType,
    winnerKey,
    reason: room.matchResult?.reason ?? 'score',
    forfeitedKey,
    participants: room.players.map((player) => ({
      key: player.key,
      userId: player.userId,
      name: identityDisplayName(player),
      score: player.score,
    })),
    reports: room.reports,
    rounds: room.replayRounds,
  });
  await Promise.allSettled(room.players.map((player) => clearMatchmakingCooldown(player.key)));
  await acknowledgeSchedule(`persist|${room.id}|0`);
}

type RematchOutcome = 'invited' | 'cancelled' | 'declined' | 'accepted';

function rematchError(room: StoredRoom, identity: string, socketId: string): string | null {
  if (!room.rematchAllowed) return 'REMATCH_NOT_ALLOWED';
  if (room.status !== 'finished' || !room.matchResult || room.players.length !== 2) {
    return 'REMATCH_NOT_AVAILABLE';
  }
  const player = room.players.find((candidate) => candidate.key === identity);
  if (!player) return 'REMATCH_NOT_AVAILABLE';
  if (player.socketId !== socketId) return 'STALE_CONNECTION';
  if (!room.players.every((candidate) => candidate.connected)) return 'REMATCH_NOT_AVAILABLE';
  return null;
}

function emitRematchUpdate(
  io: Server,
  room: StoredRoom,
  outcome: RematchOutcome,
  actorKey: string,
  playerUpdate?: { key: string; connected: boolean }
): void {
  const channels = [...room.players, ...room.spectators]
    .map((member) => identityChannel(member.key));
  if (!channels.length) return;
  io.to(channels).emit('match:rematch:update', {
    roomId: room.id,
    stateVersion: room.revision,
    outcome,
    actorKey,
    ...(playerUpdate ? { player: playerUpdate } : {}),
  });
}

function resetForRematch(room: StoredRoom): void {
  const now = Date.now();
  room.recordId = randomUUID();
  room.status = 'waiting';
  room.matchmaking = false;
  room.readyCheckEndsAt = null;
  room.round = 0;
  room.targetPlayerId = null;
  room.roundEndsAt = null;
  room.nextRoundAt = null;
  room.eventResults = {};
  room.roundResult = null;
  room.matchResult = null;
  room.reports = [];
  room.rematchInviterKey = null;
  room.replayRounds = [];
  room.createdAt = now;
  for (const player of room.players) {
    player.ready = player.key === room.hostKey;
    player.score = 0;
    player.guesses = [];
    player.guessTimes = [];
    player.lastGuessAt = null;
    player.skipped = false;
    player.disconnectDeadline = null;
  }
}

async function finishMatch(
  io: Server,
  roomId: string,
  winnerKey: string | null,
  reason: string,
  actor?: { key: string; socketId: string }
): Promise<'finished' | 'stale' | 'ignored'> {
  const result = await withRoomLock(roomId, (room) => {
    if (actor) {
      const player = room.players.find((candidate) => candidate.key === actor.key);
      if (!player || player.socketId !== actor.socketId) return { stale: true as const };
      player.connected = false;
    }
    if (room.status === 'finished') return null;
    room.status = 'finished';
    room.roundEndsAt = null;
    room.nextRoundAt = null;
    room.eventResults = {};
    room.roundResult = null;
    room.matchResult = { winnerKey, reason, forfeitedKey: actor?.key ?? null };
    return { room };
  }, (value) => Boolean(value && !('stale' in value)));
  if (!result) return 'ignored';
  if ('stale' in result) return 'stale';
  emitRoomViews(io, result.room, 'match:over', (viewerKey) => ({
    room: publicRoom(result.room, viewerKey),
    serverNow: Date.now(),
  }));
  void persistMatch(result.room, winnerKey, actor?.key ?? null)
    .catch((err) => console.error('[match:persist]', err));
  setLocalTimer(`cleanup:${roomId}`, FINISHED_ROOM_TTL_MS, () => {
    return cleanupRoom(roomId);
  });
  return 'finished';
}

async function startRound(io: Server, roomId: string) {
  const result = await withRoomLock(roomId, async (room) => {
    if (room.status !== 'waiting' && room.status !== 'round_over' && room.status !== 'starting') {
      return null;
    }
    if (room.players.length < 2 || !room.players.every((player) => player.connected)) {
      return { waitingForReconnect: true as const };
    }
    if (room.status === 'starting' && room.nextRoundAt && room.nextRoundAt > Date.now()) {
      return { waitingForStart: room.nextRoundAt };
    }
    const identities = room.players.map((player) => player.key);
    const previousTargets = [
      ...room.replayRounds.map((round) => round.targetPlayerId),
      ...(room.targetPlayerId ? [room.targetPlayerId] : []),
    ];
    const target = await pickTargetAvoidingRecent({
      mode: room.dbType,
      identities,
      hardExcludedIds: previousTargets,
    });
    if (!target) return { error: 'EMPTY_PLAYER_POOL' as const };
    room.status = 'playing';
    room.readyCheckEndsAt = null;
    room.round += 1;
    room.targetPlayerId = target.id;
    room.roundEndsAt = Date.now() + ROUND_TIME_MS;
    room.nextRoundAt = null;
    room.eventResults = {};
    room.roundResult = null;
    room.matchResult = null;
    for (const player of room.players) {
      player.guesses = [];
      player.guessTimes = [];
      player.lastGuessAt = null;
      player.skipped = false;
    }
    return { room, targetSelection: { identities, playerId: target.id } };
  }, (value) => Boolean(
    value && !('waitingForReconnect' in value) && !('waitingForStart' in value)
  ));
  if (!result) return false;
  if ('waitingForReconnect' in result) return false;
  if ('waitingForStart' in result) return false;
  if ('error' in result) {
    io.to(roomId).emit('room:error', { code: result.error });
    return false;
  }
  const room = result.room;
  await rememberTargetSelection({
    mode: room.dbType,
    identities: result.targetSelection.identities,
    playerId: result.targetSelection.playerId,
  });
  emitRoomViews(io, room, 'round:start', (viewerKey) => ({
    room: publicRoom(room, viewerKey),
    serverNow: Date.now(),
  }));
  setLocalTimer(`round:${roomId}`, ROUND_TIME_MS, () => {
    return finishRound(io, roomId, null, 'timeout', room.round);
  });
  return true;
}

async function finishRound(
  io: Server,
  roomId: string,
  winnerKey: string | null,
  reason: 'guessed' | 'exhausted' | 'timeout',
  expectedRound: number
) {
  const result = await withRoomLock(roomId, (room) => {
    if (room.status !== 'playing' || room.round !== expectedRound) return null;
    const winner = room.players.find((p) => p.key === winnerKey);
    if (winner) winner.score += 1;
    room.roundEndsAt = null;
    const matchOver = Boolean(winner && winner.score >= winsNeeded(room.boType));
    if (matchOver) room.status = 'finished';
    else {
      room.status = 'round_over';
      room.nextRoundAt = Date.now() + NEXT_ROUND_DELAY_MS;
    }
    room.roundResult = {
      round: room.round,
      winnerKey,
      reason,
      matchOver,
      nextRoundAt: room.nextRoundAt,
    };
    appendReplayRound(room);
    if (matchOver) room.matchResult = { winnerKey, reason: 'score', forfeitedKey: null };
    return { room, matchOver };
  }, (value) => Boolean(value));
  if (!result) return;
  const { room, matchOver } = result;
  if (matchOver) {
    emitRoomViews(io, room, 'match:over', (viewerKey) => ({
      room: publicRoom(room, viewerKey),
      serverNow: Date.now(),
    }));
    void persistMatch(room, winnerKey).catch((err) => console.error('[match:persist]', err));
    setLocalTimer(`cleanup:${roomId}`, FINISHED_ROOM_TTL_MS, () => {
      return cleanupRoom(roomId);
    });
    return;
  }
  emitRoomViews(io, room, 'round:over', (viewerKey) => ({
    room: publicRoom(room, viewerKey),
    serverNow: Date.now(),
  }));
  setLocalTimer(`next:${roomId}`, NEXT_ROUND_DELAY_MS, () => startRound(io, roomId));
}

async function skipRound(
  io: Server,
  roomId: string,
  playerKey: string,
  socketId: string,
  expectedRound: number
): Promise<{ room: StoredRoom; roundFinished: boolean; alreadySkipped: boolean } | 'stale' | null> {
  const result = await withRoomLock(roomId, (room) => {
    if (room.status !== 'playing' || room.round !== expectedRound) return null;
    const player = room.players.find((candidate) => candidate.key === playerKey);
    if (!player || player.socketId !== socketId) return { stale: true as const };
    if (player.skipped) {
      return { room, roundFinished: false, alreadySkipped: true };
    }

    player.skipped = true;
    const roundFinished = room.players.every(
      (candidate) => candidate.skipped || candidate.guesses.length >= MAX_GUESSES
    );
    if (roundFinished) {
      room.roundEndsAt = null;
      room.status = 'round_over';
      room.nextRoundAt = Date.now() + NEXT_ROUND_DELAY_MS;
      room.roundResult = {
        round: room.round,
        winnerKey: null,
        reason: 'skipped',
        matchOver: false,
        nextRoundAt: room.nextRoundAt,
      };
      appendReplayRound(room);
    }
    return { room, roundFinished, alreadySkipped: false };
  }, (value) => Boolean(value && !('stale' in value) && !value.alreadySkipped));

  if (!result) return null;
  if ('stale' in result) return 'stale';
  if (result.roundFinished) {
    emitRoomViews(io, result.room, 'round:over', (viewerKey) => ({
      room: publicRoom(result.room, viewerKey),
      serverNow: Date.now(),
    }));
    setLocalTimer(`next:${roomId}`, NEXT_ROUND_DELAY_MS, () => startRound(io, roomId));
  } else if (!result.alreadySkipped) {
    emitRoomPatch(io, result.room, {
      players: { updated: [{ key: playerKey, skipped: true }] },
    });
  }
  return result;
}

async function cleanupRoom(roomId: string) {
  const room = await getRoom(roomId);
  if (room?.status === 'finished') await deleteRoom(room);
}

async function processDisconnectedPlayer(
  io: Server,
  roomId: string,
  disconnectedKey: string
): Promise<number | null> {
  const result = await withRoomLock(roomId, (room) => {
    if (room.status === 'finished') return null;
    const disconnected = room.players.find((player) => player.key === disconnectedKey);
    if (
      !disconnected ||
      disconnected.connected ||
      !disconnected.disconnectDeadline ||
      disconnected.disconnectDeadline > Date.now()
    ) return null;

    if (room.status === 'waiting' && room.matchmaking) {
      return { kind: 'ready' as const, retryAt: room.readyCheckEndsAt ?? Date.now() };
    }
    if (room.status === 'waiting') {
      room.players = room.players.filter((player) => player.key !== disconnectedKey);
      if (room.players.length && room.hostKey === disconnectedKey) {
        room.hostKey = room.players[0].key;
      }
      if (room.players.length === 1) room.players[0].ready = true;
      return { kind: 'waiting' as const, room };
    }
    if (!['starting', 'playing', 'round_over'].includes(room.status)) return null;

    const opponent = room.players.find((player) => player.key !== disconnectedKey);
    let winnerKey = opponent?.key ?? null;
    let forfeitedKey: string | null = disconnectedKey;
    if (opponent && !opponent.connected) {
      const retryAt = Math.max(
        disconnected.disconnectDeadline,
        opponent.disconnectDeadline ?? disconnected.disconnectDeadline
      );
      if (retryAt > Date.now()) return { kind: 'retry' as const, retryAt };
      winnerKey = null;
      forfeitedKey = null;
    }

    room.status = 'finished';
    room.roundEndsAt = null;
    room.nextRoundAt = null;
    room.eventResults = {};
    room.roundResult = null;
    room.matchResult = {
      winnerKey,
      reason: 'disconnect_timeout',
      forfeitedKey,
    };
    return { kind: 'finished' as const, room, winnerKey, forfeitedKey };
  }, (value) => Boolean(value && (value.kind === 'waiting' || value.kind === 'finished')));

  if (!result) return null;
  if (result.kind === 'ready') return result.retryAt;
  if (result.kind === 'retry') return result.retryAt;
  if (result.kind === 'waiting') {
    await clearIdentityRoom(disconnectedKey, roomId);
    if (!result.room.players.length && !result.room.spectators.length) {
      await deleteRoom(result.room);
    } else {
      emitRoomPatch(io, result.room, {
        hostKey: result.room.hostKey,
        players: {
          removed: [disconnectedKey],
          updated: result.room.players.length === 1
            ? [{ key: result.room.players[0].key, ready: result.room.players[0].ready }]
            : [],
        },
      });
    }
    return null;
  }

  emitRoomViews(io, result.room, 'match:over', (viewerKey) => ({
    room: publicRoom(result.room, viewerKey),
    serverNow: Date.now(),
  }));
  void persistMatch(result.room, result.winnerKey, result.forfeitedKey)
    .catch((err) => console.error('[match:persist]', err));
  setLocalTimer(`cleanup:${roomId}`, FINISHED_ROOM_TTL_MS, () => cleanupRoom(roomId));
  return null;
}

async function processReadyCheck(io: Server, roomId: string): Promise<number | null> {
  const result = await withRoomLock(roomId, async (room) => {
    if (room.status !== 'waiting' || !room.matchmaking || !room.readyCheckEndsAt) return null;
    if (room.readyCheckEndsAt > Date.now()) {
      return { kind: 'retry' as const, retryAt: room.readyCheckEndsAt };
    }
    const penalizedKeys = room.players
      .filter((player) => !player.ready || !player.connected)
      .map((player) => player.key);
    await deleteRoom(room);
    return { kind: 'expired' as const, room, penalizedKeys };
  }, () => false);
  if (!result) return null;
  if (result.kind === 'retry') return result.retryAt;

  const penalties = new Map<string, Awaited<ReturnType<typeof recordMatchmakingExit>>>();
  await Promise.all(result.penalizedKeys.map(async (key) => {
    penalties.set(key, await recordMatchmakingExit(key));
  }));
  for (const player of result.room.players) {
    io.to(identityChannel(player.key)).emit('match:ready-ended', {
      roomId: result.room.id,
      reason: 'timeout',
      penalized: penalties.has(player.key),
      retryAt: penalties.get(player.key)?.retryAt ?? null,
      serverNow: Date.now(),
    });
  }
  return null;
}

async function processSchedule(io: Server, item: string): Promise<number | null> {
  const [kind, roomId, discriminator] = item.split('|');
  const room = await getRoom(roomId);
  if (!room) return null;
  if (kind === 'round' && room.status === 'playing' && room.round === Number(discriminator)) {
    await finishRound(io, roomId, null, 'timeout', room.round);
  } else if (kind === 'start' && room.status === 'starting') {
    await startRound(io, roomId);
  } else if (kind === 'next' && room.status === 'round_over' && room.round === Number(discriminator)) {
    await startRound(io, roomId);
  } else if (kind === 'ready') {
    return processReadyCheck(io, roomId);
  } else if (kind === 'disconnect') {
    const maintenanceUntil = await getMaintenanceUntil();
    if (maintenanceUntil > Date.now()) return maintenanceUntil;
    return processDisconnectedPlayer(io, roomId, discriminator);
  } else if (kind === 'spectator') {
    const spectator = room.spectators.find((candidate) => candidate.key === discriminator);
    if (
      spectator &&
      !spectator.connected &&
      spectator.disconnectDeadline &&
      spectator.disconnectDeadline <= Date.now()
    ) {
      const updated = await withRoomLock(roomId, (locked) => {
        const current = locked.spectators.find((candidate) => candidate.key === discriminator);
        if (
          !current ||
          current.connected ||
          !current.disconnectDeadline ||
          current.disconnectDeadline > Date.now()
        ) return null;
        locked.spectators = locked.spectators.filter((candidate) => candidate.key !== discriminator);
        return { room: locked };
      }, (value) => Boolean(value));
      if (updated) {
        await clearIdentityRoom(discriminator, roomId);
        if (!updated.room.players.length && !updated.room.spectators.length) {
          await deleteRoom(updated.room);
        } else {
          emitRoomPatch(io, updated.room, {
            spectatorCount: connectedSpectatorCount(updated.room),
          });
        }
      }
    }
  } else if (kind === 'cleanup') {
    await cleanupRoom(roomId);
  } else if (kind === 'persist') {
    if (room.status !== 'finished' || !room.matchResult) return null;
    await persistMatch(room, room.matchResult.winnerKey);
  }
  return null;
}

async function handleScheduledItem(io: Server, item: string): Promise<void> {
  let retryAt: number | null;
  try {
    retryAt = await processSchedule(io, item);
  } catch (err) {
    if (err instanceof Error && err.message === 'STALE_ROOM_WRITE') {
      await acknowledgeSchedule(item);
      return;
    }
    throw err;
  }
  if (retryAt) {
    const [kind, roomId, discriminator] = item.split('|');
    await schedule(kind, roomId, discriminator, retryAt);
    return;
  }
  await acknowledgeSchedule(item);
}

async function handleScheduledGroup(io: Server, items: string[]): Promise<void> {
  const spectatorItems = items.filter((item) => item.startsWith('spectator|'));
  if (spectatorItems.length) {
    const roomId = spectatorItems[0].split('|')[1] ?? '';
    const identities = spectatorItems
      .map((item) => item.split('|')[2] ?? '')
      .filter(Boolean);
    const result = roomId
      ? await removeExpiredSpectators(roomId, identities)
      : null;
    if (result?.removedKeys.length) {
      if (!result.room.players.length && !result.room.spectators.length) {
        await deleteRoom(result.room);
      } else {
        emitRoomPatch(io, result.room, {
          spectatorCount: connectedSpectatorCount(result.room),
        });
      }
    }
    await Promise.all(spectatorItems.map(acknowledgeSchedule));
  }

  for (const item of items) {
    if (!item.startsWith('spectator|')) await handleScheduledItem(io, item);
  }
}

function safeOn<T = any>(
  socket: Socket,
  event: string,
  handler: (payload: T, ack?: (value: any) => void) => Promise<void>,
  schema?: z.ZodTypeAny
) {
  socket.on(event, (payload: any, ack?: (value: any) => void) => {
    const parsed = schema?.safeParse(payload);
    if (parsed && !parsed.success) return ack?.({ code: 'VALIDATION_FAILED' });
    const validatedPayload = (parsed ? parsed.data : payload) as T;
    const pendingEvents = Number(socket.data.pendingEvents ?? 0);
    if (pendingEvents >= 8) return ack?.({ code: 'RATE_LIMITED' });
    socket.data.pendingEvents = pendingEvents + 1;
    void handler(validatedPayload, ack).catch(async (err) => {
      if (err instanceof Error && err.message === 'ROOM_IDENTITY_CONFLICT') {
        const identity = socket.data.identity as StoredIdentity | undefined;
        const room = identity ? await getRoomForIdentity(identity.key).catch(() => null) : null;
        ack?.({
          code: 'ALREADY_IN_ROOM',
          room: room && identity ? publicRoom(room, identity.key) : undefined,
          role: room && identity
            ? room.players.some((player) => player.key === identity.key) ? 'player' : 'spectator'
            : undefined,
        });
        return;
      }
      const code = isRedisTimeoutError(err)
        ? 'REDIS_UNAVAILABLE'
        : err instanceof Error && [
          'ROOM_BUSY',
          'REDIS_UNAVAILABLE',
          'STALE_ROOM_WRITE',
        ].includes(err.message)
          ? err.message === 'STALE_ROOM_WRITE' ? 'ROOM_BUSY' : err.message
          : 'INTERNAL_ERROR';
      if (code === 'ROOM_BUSY' || code === 'REDIS_UNAVAILABLE') {
        logTransientWarning(`[socket:${event}]`, code);
      } else {
        console.error(`[socket:${event}]`, err);
      }
      ack?.({ code });
    }).finally(() => {
      socket.data.pendingEvents = Math.max(0, Number(socket.data.pendingEvents ?? 1) - 1);
    });
  });
}

async function socketAllowed(event: string, identity: string, limit: number, seconds: number) {
  return consumeRateLimit(`socket:${event}`, identity, limit, seconds);
}

async function socketAllowedWithIp(
  socket: Socket,
  event: string,
  identity: string,
  identityLimit: number,
  ipLimit: number,
  seconds: number
): Promise<boolean> {
  if (!(await socketAllowed(event, identity, identityLimit, seconds))) return false;
  return consumeRateLimit(`socket:${event}:ip`, String(socket.data.ip), ipLimit, seconds);
}

async function acquireConnectionSlot(ip: string, identity: string, socketId: string): Promise<boolean> {
  const client = redis();
  if (!client) return true;
  const result = await evalCommandScript(
    'connection-slot-acquire-v1',
    `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
     redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
     local ipCount = redis.call('ZCARD', KEYS[1])
     local identityCount = redis.call('ZCARD', KEYS[2])
     if ipCount >= tonumber(ARGV[2]) or identityCount >= tonumber(ARGV[3]) then return 0 end
     redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
     redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
     redis.call('ZADD', KEYS[3], ARGV[4], ARGV[6])
     redis.call('SET', KEYS[4], '1', 'EX', 180)
     redis.call('expire', KEYS[1], 900); redis.call('expire', KEYS[2], 900)
     return 1`,
    [
      redisKey(`connections:ip:${ip}`),
      redisKey(`connections:identity:${identity}`),
      redisKey('presence:online'),
      redisKey(`connections:socket:${socketId}`),
    ],
    [
      String(Date.now() - ONLINE_STALE_MS),
      String(MAX_CONNECTIONS_PER_IP),
      String(MAX_CONNECTIONS_PER_IDENTITY),
      String(Date.now()),
      socketId,
      identity,
    ]
  );
  return Number(result) === 1;
}

async function releaseConnectionSlot(ip: string, identity: string, socketId: string): Promise<void> {
  const client = redis();
  if (!client) return;
  await evalCommandScript(
    'connection-slot-release-v1',
    `redis.call('ZREM', KEYS[1], ARGV[1])
     redis.call('ZREM', KEYS[2], ARGV[1])
     redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
     redis.call('DEL', KEYS[4])
     if redis.call('ZCARD', KEYS[2]) == 0 then
       redis.call('ZREM', KEYS[3], ARGV[2])
     else
       redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
     end
     return 1`,
    [
      redisKey(`connections:ip:${ip}`),
      redisKey(`connections:identity:${identity}`),
      redisKey('presence:online'),
      redisKey(`connections:socket:${socketId}`),
    ],
    [
      socketId,
      identity,
      String(Date.now() - ONLINE_STALE_MS),
      String(Date.now()),
    ]
  );
}

async function refreshConnectionSlots(
  entries: { ip: string; identity: string; socketId: string }[]
): Promise<void> {
  if (!entries.length) return;
  const client = redis();
  if (!client) return;
  const now = Date.now();
  await evalCommandScript(
    'connection-slot-refresh-v1',
    `for index = 2, #ARGV, 3 do
       local ip = ARGV[index]
       local identity = ARGV[index + 1]
       local socketId = ARGV[index + 2]
       local ipKey = KEYS[2] .. ip
       local identityKey = KEYS[3] .. identity
       redis.call('ZADD', ipKey, ARGV[1], socketId)
       redis.call('ZADD', identityKey, ARGV[1], socketId)
       redis.call('ZADD', KEYS[1], ARGV[1], identity)
       redis.call('SET', KEYS[4] .. socketId, '1', 'EX', 180)
       redis.call('EXPIRE', ipKey, 900)
       redis.call('EXPIRE', identityKey, 900)
     end
     return #ARGV`,
    [
      redisKey('presence:online'),
      redisKey('connections:ip:'),
      redisKey('connections:identity:'),
      redisKey('connections:socket:'),
    ],
    [
      String(now),
      ...entries.flatMap((entry) => [entry.ip, entry.identity, entry.socketId]),
    ]
  );
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function processGroupsWithLimit(
  groups: string[][],
  limit: number,
  handler: (group: string[]) => Promise<void>
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, groups.length) }, async () => {
    while (cursor < groups.length) {
      const group = groups[cursor++];
      await handler(group);
      await yieldEventLoop();
    }
  }));
}

export function setupSocket(io: Server) {
  const backgroundTasks = new Set<Promise<unknown>>();
  const trackBackground = <T>(task: Promise<T>, label: string): void => {
    backgroundTasks.add(task);
    void task.catch((err) => logTransientError(label, err)).finally(() => backgroundTasks.delete(task));
  };
  const presenceSubscribers = new Set<string>();
  const heartbeatEntries = new Map<string, { ip: string; identity: string; socketId: string }>();
  let heartbeatRequest: Promise<void> | null = null;
  let lastPresence: Omit<PresenceStats, 'updatedAt'> | null = null;
  let presenceRequest: Promise<PresenceStats> | null = null;
  const presenceWorker = setInterval(() => {
    if (!presenceSubscribers.size) return;
    presenceRequest ??= getPresenceStats().finally(() => {
      presenceRequest = null;
    });
    void presenceRequest.then((stats) => {
      const comparable = {
        onlineUsers: stats.onlineUsers,
        multiplayerRooms: stats.multiplayerRooms,
        singleGames: stats.singleGames,
      };
      if (lastPresence && JSON.stringify(lastPresence) === JSON.stringify(comparable)) return;
      lastPresence = comparable;
      for (const socketId of presenceSubscribers) io.to(socketId).emit('presence:stats', stats);
    }).catch((err) => logTransientError('[presence]', err));
  }, 2000);
  presenceWorker.unref?.();
  const presenceCleanupWorker = setInterval(() => {
    void getPresenceStats().catch((err) => logTransientError('[presence:cleanup]', err));
  }, 60_000);
  presenceCleanupWorker.unref?.();
  let scheduleRequest: Promise<void> | null = null;
  const worker = setInterval(() => {
    if (scheduleRequest) return;
    scheduleRequest = claimDueSchedules(40)
      .then(async (items) => {
        const byRoom = new Map<string, string[]>();
        for (const item of items) {
          const roomId = item.split('|')[1] ?? '';
          const group = byRoom.get(roomId) ?? [];
          group.push(item);
          byRoom.set(roomId, group);
        }
        await processGroupsWithLimit([...byRoom.values()], 8, async (group) => {
          await handleScheduledGroup(io, group);
        });
      })
      .then(() => undefined)
      .catch((err) => logTransientError('[schedule]', err))
      .finally(() => {
        scheduleRequest = null;
      });
  }, 1000);
  worker.unref?.();
  const heartbeatWorker = setInterval(() => {
    if (heartbeatRequest) return;
    const entries = [...heartbeatEntries.values()];
    heartbeatRequest = (async () => {
      for (let index = 0; index < entries.length; index += 100) {
        await refreshConnectionSlots(entries.slice(index, index + 100));
        await yieldEventLoop();
      }
    })().catch((err) => logTransientError('[presence:heartbeat]', err)).finally(() => {
      heartbeatRequest = null;
    });
  }, 60_000);
  heartbeatWorker.unref?.();

  io.use(async (socket, next) => {
    try {
      const user = await authenticateCookie(socket.handshake.headers.cookie);
      const guest = getGuestFromCookie(socket.handshake.headers.cookie);
      if (
        !user &&
        (hasAuthSessionCookie(socket.handshake.headers.cookie) ||
          socket.handshake.auth?.authenticated === true)
      ) {
        return next(new Error('AUTH_EXPIRED'));
      }
      let identity: StoredIdentity | null = null;
      if (user) {
        identity = {
          key: `u:${user.id}`,
          userId: user.id,
          name: userNameFromUsername(user.username),
          emailVerified: Boolean(user.email && user.emailVerified),
        };
      } else if (guest) {
        if (await isGuestBanned(guest.key)) return next(new Error('USER_BANNED'));
        void recordGuestSeen(guest.key, guest.name).catch(() => undefined);
        identity = {
          key: `g:${guest.key}`,
          userId: null,
          name: guest.name,
        };
      }
      if (!identity) return next(new Error('IDENTITY_REQUIRED'));
      const ip = resolveSocketIp(
        socket.handshake.address,
        socket.handshake.headers['x-forwarded-for'],
        socket.handshake.headers['x-real-ip'],
        config.trustProxy
      );
      if (!(await consumeRateLimit('socket:connect', `${ip}:${identity.key}`, 30, 60))) {
        return next(new Error('RATE_LIMITED'));
      }
      if (!(await acquireConnectionSlot(ip, identity.key, socket.id))) {
        return next(new Error('TOO_MANY_CONNECTIONS'));
      }
      socket.data.identity = identity;
      socket.data.ip = ip;
      socket.data.connectionSlot = true;
      next();
    } catch (err) {
      console.error('[socket:connect]', err);
      next(new Error(err instanceof Error && err.message === 'REDIS_UNAVAILABLE'
        ? 'REDIS_UNAVAILABLE'
        : 'INTERNAL_ERROR'));
    }
  });

  io.on('connection', (socket) => {
    const me = socket.data.identity as StoredIdentity;
    const refreshIdentityEmailState = async () => {
      if (!me.userId) return;
      const current = await authenticateCookie(socket.handshake.headers.cookie);
      if (current?.id === me.userId) me.emailVerified = Boolean(current.email && current.emailVerified);
    };
    socket.emit('identity:self', { key: me.key });
    void getResourceVersionNotice()
      .then((notice) => {
        if (notice && socket.connected) socket.emit('resource:version', notice);
      })
      .catch((err) => logTransientError('[resource-version:restore]', err));
    heartbeatEntries.set(socket.id, {
      ip: String(socket.data.ip),
      identity: me.key,
      socketId: socket.id,
    });
    socket.join(identityChannel(me.key));
    const restorePromise = getRoomForIdentity(me.key, true).then(async (existing) => {
      if (!existing) return;
      let refreshed = existing;
      if (existing.status !== 'finished' || existing.rematchAllowed) {
        const restored = await withRoomLock(existing.id, (room) => {
          const player = room.players.find((p) => p.key === me.key);
          const spectator = room.spectators.find((p) => p.key === me.key);
          if (player) {
            player.socketId = socket.id;
            player.connected = true;
            player.disconnectDeadline = null;
            return { role: 'player' as const, room };
          }
          if (spectator) {
            spectator.socketId = socket.id;
            spectator.connected = true;
            spectator.disconnectDeadline = null;
            return { role: 'spectator' as const, room };
          }
          return null;
        }, (value) => Boolean(value));
        if (!restored) {
          await clearIdentityRoom(me.key, existing.id);
          return;
        }
        refreshed = restored.room;
        emitRoomPatch(io, refreshed, restored.role === 'player'
          ? { players: { updated: [{ key: me.key, connected: true }] } }
          : { spectatorCount: connectedSpectatorCount(refreshed) });
      }
      joinRoomChannels(socket, refreshed, me.key);
      socket.data.roomId = refreshed.id;
      if (
        refreshed.players.length === 2 &&
        refreshed.players.every((player) => player.connected) &&
        (
          refreshed.status === 'starting' ||
          (refreshed.status === 'round_over' && (refreshed.nextRoundAt ?? 0) <= Date.now())
        )
      ) {
        await startRound(io, refreshed.id);
      }
    }).catch((err) => console.error('[socket:reconnect]', err));

    safeOn(socket, 'room:sync', async (_payload, ack) => {
      await restorePromise;
      if (!(await socketAllowedWithIp(socket, 'sync', me.key, 20, 300, 10))) {
        return ack?.({ code: 'RATE_LIMITED' });
      }
      const room = await getRoomForIdentity(me.key, true);
      if (!room) {
        socket.data.roomId = undefined;
        return ack?.({ code: 'NOT_IN_ROOM' });
      }
      joinRoomChannels(socket, room, me.key);
      socket.data.roomId = room.id;
      ack?.({
        room: publicRoom(room, me.key),
        role: room.players.some((p) => p.key === me.key) ? 'player' : 'spectator',
        selfKey: me.key,
        serverNow: Date.now(),
      });
    });

    safeOn(socket, 'room:player-stats', async (payload: z.infer<typeof roomPlayerStatsPayloadSchema>, ack) => {
      await restorePromise;
      if (!(await socketAllowedWithIp(socket, 'player-stats', me.key, 20, 60, 60))) {
        return ack?.({ code: 'RATE_LIMITED' });
      }
      const room = await getRoomForIdentity(me.key, true);
      if (!room) return ack?.({ code: 'NOT_IN_ROOM' });

      const requesterIsPlayer = room.players.some((player) => player.key === me.key);
      const requesterIsSpectator = room.spectators.some((spectator) => spectator.key === me.key);
      const target = room.players.find((player) => player.key === payload.playerKey);
      const allowed = Boolean(
        target && (
          requesterIsSpectator ||
          (requesterIsPlayer && target.key !== me.key)
        )
      );
      if (!allowed || !target) return ack?.({ code: 'FORBIDDEN' });

      ack?.({
        playerKey: target.key,
        displayId: identityDisplayName(target),
        stats: await getPlayerPerformance(target),
      });
    }, roomPlayerStatsPayloadSchema);

    safeOn(socket, 'presence:subscribe', async (_payload, ack) => {
      const user = await authenticateCookie(socket.handshake.headers.cookie);
      if (!user || user.role !== 'admin') return ack?.({ code: 'FORBIDDEN' });
      presenceSubscribers.add(socket.id);
      const stats = await getPresenceStats();
      socket.emit('presence:stats', stats);
      ack?.({ ok: true, stats });
    });

    safeOn(socket, 'presence:unsubscribe', async (_payload, ack) => {
      presenceSubscribers.delete(socket.id);
      ack?.({ ok: true });
    });

    safeOn(socket, 'room:create', async (payload: z.infer<typeof roomCreatePayloadSchema>, ack) => {
      await restorePromise;
      await refreshIdentityEmailState();
      if (!(await socketAllowed('create', me.key, 5, 60))) return ack?.({ code: 'RATE_LIMITED' });
      const existing = await getRoomForIdentity(me.key);
      if (existing) return ack?.({
        code: 'ALREADY_IN_ROOM',
        room: publicRoom(existing, me.key),
        role: existing.players.some((player) => player.key === me.key) ? 'player' : 'spectator',
      });
      const boType = payload.boType;
      const dbType = payload.dbType;
      if (!isDifficultyAvailable(dbType)) return ack?.({ code: 'DIFFICULTY_UNAVAILABLE' });
      const now = Date.now();
      const roomId = await genRoomId();
      if (!(await reserveRoomCapacity(String(socket.data.ip), roomId))) {
        return ack?.({ code: 'ROOM_CAPACITY_REACHED' });
      }
      const room: StoredRoom = {
        id: roomId,
        recordId: randomUUID(),
        ownerIp: String(socket.data.ip),
        hostKey: me.key,
        status: 'waiting',
        matchmaking: false,
        readyCheckEndsAt: null,
        dbType,
        boType,
        rematchAllowed: true,
        rematchInviterKey: null,
        allowSpectators: payload.allowSpectators,
        verifiedOnly: payload.verifiedOnly,
        anonymous: payload.anonymous,
        round: 0,
        players: [makePlayer(me, socket.id, true)],
        spectators: [],
        targetPlayerId: null,
        roundEndsAt: null,
        nextRoundAt: null,
        eventResults: {},
        roundResult: null,
        matchResult: null,
        reports: [],
        replayRounds: [],
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await saveRoom(room);
      } catch (err) {
        await releaseRoomCapacity(room.ownerIp, room.id);
        if (err instanceof Error && err.message === 'ROOM_IDENTITY_CONFLICT') {
          const current = await getRoomForIdentity(me.key);
          return ack?.({
            code: 'ALREADY_IN_ROOM',
            room: current ? publicRoom(current, me.key) : undefined,
            role: current
              ? current.players.some((player) => player.key === me.key) ? 'player' : 'spectator'
              : undefined,
          });
        }
        throw err;
      }
      joinRoomChannels(socket, room, me.key);
      socket.data.roomId = room.id;
      ack?.({ room: publicRoom(room, me.key) });
    }, roomCreatePayloadSchema);

    safeOn(socket, 'room:join', async (payload: z.infer<typeof roomJoinPayloadSchema>, ack) => {
      await restorePromise;
      await refreshIdentityEmailState();
      if (!(await socketAllowed('join', me.key, 20, 60))) return ack?.({ code: 'RATE_LIMITED' });
      const roomId = payload.roomId;
      const current = await getRoomForIdentity(me.key);
      if (current && current.id !== roomId) return ack?.({
        code: 'ALREADY_IN_ROOM',
        room: publicRoom(current, me.key),
        role: current.players.some((player) => player.key === me.key) ? 'player' : 'spectator',
      });
      const role = await withRoomLock(roomId, (room) => {
        if (room.status === 'finished') return { code: 'ROOM_NOT_FOUND' };
        const player = room.players.find((p) => p.key === me.key);
        if (player) {
          if (player.connected && player.socketId !== socket.id) {
            return { code: 'STALE_CONNECTION' };
          }
          player.socketId = socket.id;
          player.connected = true;
          player.disconnectDeadline = null;
          return { role: 'player' as const, room, existing: true };
        }
        const existingSpectator = room.spectators.find((p) => p.key === me.key);
        if (room.verifiedOnly && me.key !== room.hostKey && !me.emailVerified) {
          return { code: 'EMAIL_VERIFICATION_REQUIRED' };
        }
        const asSpectator = Boolean(
          existingSpectator || payload.spectate || room.status !== 'waiting' || room.players.length >= 2
        );
        if (asSpectator) {
          if (!existingSpectator && !room.allowSpectators) return { code: 'SPECTATING_DISABLED' };
          if (!existingSpectator && room.spectators.length >= MAX_SPECTATORS) return { code: 'ROOM_FULL' };
          if (existingSpectator && existingSpectator.socketId !== socket.id) {
            return { code: 'STALE_CONNECTION' };
          }
          if (existingSpectator) {
            existingSpectator.socketId = socket.id;
            existingSpectator.connected = true;
            existingSpectator.disconnectDeadline = null;
          } else {
            room.spectators.push({
              ...me,
              socketId: socket.id,
              connected: true,
              disconnectDeadline: null,
            });
          }
          return { role: 'spectator' as const, room, existing: true };
        }
        room.players.push(makePlayer(me, socket.id, false));
        return { role: 'player' as const, room, existing: false };
      }, (value) => 'role' in value);
      if (!role) return ack?.({ code: 'ROOM_NOT_FOUND' });
      if ('code' in role) return ack?.({ code: role.code });
      joinRoomChannels(socket, role.room, me.key);
      socket.data.roomId = roomId;
      const joinedView = publicRoom(role.room, me.key);
      if (role.role === 'player') {
        const player = joinedView.players.find((candidate) => candidate.key === me.key);
        emitRoomPatch(io, role.room, role.existing
          ? { players: { updated: [{ key: me.key, connected: true }] } }
          : { players: { added: player ? [player] : [] } });
      } else {
        emitRoomPatch(io, role.room, {
          spectatorCount: connectedSpectatorCount(role.room),
        });
      }
      ack?.({ room: publicRoom(role.room, me.key), role: role.role });
    }, roomJoinPayloadSchema);

    safeOn(socket, 'match:report', async (payload: z.infer<typeof matchReportPayloadSchema>, ack) => {
      await restorePromise;
      if (!(await socketAllowedWithIp(socket, 'match-report', me.key, 6, 60, 30))) {
        return ack?.({ code: 'RATE_LIMITED' });
      }
      const room = await getRoomForIdentity(me.key, true);
      if (!room || !room.matchmaking || room.status !== 'finished' || room.players.length !== 2) {
        return ack?.({ code: 'REPORT_NOT_AVAILABLE' });
      }
      const result = await withRoomLock(room.id, (locked) => {
        if (!locked.matchmaking || locked.status !== 'finished' || locked.players.length !== 2) {
          return { code: 'REPORT_NOT_AVAILABLE' };
        }
        const reporter = locked.players.find((player) => player.key === me.key);
        const reported = locked.players.find((player) => player.key !== me.key);
        if (!reporter || !reported || reporter.socketId !== socket.id) {
          return { code: 'REPORT_NOT_AVAILABLE' };
        }
        if (locked.reports.some((report) => report.reporterKey === me.key)) {
          return { code: 'REPORT_ALREADY_SUBMITTED' };
        }
        const report: StoredMatchReport = {
          reporterKey: me.key,
          reportedKey: reported.key,
          description: payload.description,
          createdAt: Date.now(),
        };
        locked.reports.push(report);
        return { room: locked };
      }, (value) => 'room' in value);
      if (!result || 'code' in result) return ack?.({ code: result?.code ?? 'REPORT_NOT_AVAILABLE' });
      void persistMatch(result.room, result.room.matchResult?.winnerKey ?? null).catch((error) => {
        console.error('[match:report-persist]', error);
      });
      ack?.({ ok: true, reportSubmitted: true });
    }, matchReportPayloadSchema);

    safeOn(socket, 'match:rematch-invite', async (_payload, ack) => {
      await restorePromise;
      if (!(await socketAllowedWithIp(socket, 'rematch-invite', me.key, 6, 80, 60))) {
        return ack?.({ code: 'RATE_LIMITED' });
      }
      const room = await getRoomForIdentity(me.key, true);
      if (!room) return ack?.({ code: 'REMATCH_NOT_AVAILABLE' });
      const result = await withRoomLock(room.id, (locked) => {
        const code = rematchError(locked, me.key, socket.id);
        if (code) return { code };
        if (locked.rematchInviterKey && locked.rematchInviterKey !== me.key) {
          return { code: 'REMATCH_INVITE_PENDING' };
        }
        locked.rematchInviterKey = me.key;
        return { room: locked, outcome: 'invited' as const };
      }, (value) => 'room' in value);
      if (!result || 'code' in result) {
        return ack?.({ code: result?.code ?? 'REMATCH_NOT_AVAILABLE' });
      }
      emitRematchUpdate(io, result.room, result.outcome, me.key);
      ack?.({ ok: true, stateVersion: result.room.revision });
    });

    safeOn(socket, 'match:rematch-cancel', async (_payload, ack) => {
      await restorePromise;
      if (!(await socketAllowed('rematch-cancel', me.key, 8, 60))) {
        return ack?.({ code: 'RATE_LIMITED' });
      }
      const room = await getRoomForIdentity(me.key, true);
      if (!room) return ack?.({ code: 'REMATCH_NOT_AVAILABLE' });
      const result = await withRoomLock(room.id, (locked) => {
        const code = rematchError(locked, me.key, socket.id);
        if (code) return { code };
        if (locked.rematchInviterKey !== me.key) return { code: 'REMATCH_INVITE_NOT_FOUND' };
        locked.rematchInviterKey = null;
        return { room: locked, outcome: 'cancelled' as const };
      }, (value) => 'room' in value);
      if (!result || 'code' in result) {
        return ack?.({ code: result?.code ?? 'REMATCH_NOT_AVAILABLE' });
      }
      emitRematchUpdate(io, result.room, result.outcome, me.key);
      ack?.({ ok: true, stateVersion: result.room.revision });
    });

    safeOn(socket, 'match:rematch-respond', async (payload: z.infer<typeof rematchResponsePayloadSchema>, ack) => {
      await restorePromise;
      if (!(await socketAllowedWithIp(socket, 'rematch-respond', me.key, 8, 80, 60))) {
        return ack?.({ code: 'RATE_LIMITED' });
      }
      const room = await getRoomForIdentity(me.key, true);
      if (!room) return ack?.({ code: 'REMATCH_NOT_AVAILABLE' });
      const result = await withRoomLock(room.id, async (locked) => {
        const code = rematchError(locked, me.key, socket.id);
        if (code) return { code };
        if (!locked.rematchInviterKey) return { code: 'REMATCH_INVITE_NOT_FOUND' };
        if (locked.rematchInviterKey === me.key) return { code: 'REMATCH_RESPONSE_NOT_ALLOWED' };
        if (!payload.accept) {
          locked.rematchInviterKey = null;
          return { room: locked, outcome: 'declined' as const };
        }
        await persistMatch(locked, locked.matchResult!.winnerKey);
        resetForRematch(locked);
        return { room: locked, outcome: 'accepted' as const };
      }, (value) => 'room' in value);
      if (!result || 'code' in result) {
        return ack?.({ code: result?.code ?? 'REMATCH_NOT_AVAILABLE' });
      }
      if (result.outcome === 'accepted') {
        const cleanupTimer = timers.get(`cleanup:${result.room.id}`);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        timers.delete(`cleanup:${result.room.id}`);
        await acknowledgeSchedule(`cleanup|${result.room.id}|0`);
      }
      emitRematchUpdate(io, result.room, result.outcome, me.key);
      ack?.({ ok: true, stateVersion: result.room.revision });
    }, rematchResponsePayloadSchema);

    safeOn(socket, 'room:ready', async (payload: z.infer<typeof roomReadyPayloadSchema>, ack) => {
      await restorePromise;
      if (!(await socketAllowedWithIp(socket, 'ready', me.key, 8, 160, 10))) {
        return ack?.({ code: 'RATE_LIMITED' });
      }
      const room = await getRoomForIdentity(me.key);
      if (!room) return ack?.({ code: 'NOT_IN_WAITING_ROOM' });
      if (room.status !== 'waiting') return ack?.({ code: 'NOT_IN_WAITING_ROOM' });
      const changed = await withRoomLock(room.id, (locked) => {
        if (locked.status !== 'waiting') return false;
        if (locked.matchmaking && locked.readyCheckEndsAt && locked.readyCheckEndsAt <= Date.now()) {
          return 'READY_CHECK_EXPIRED' as const;
        }
        const player = locked.players.find((p) => p.key === me.key);
        if (!player) return false;
        if (player.socketId !== socket.id) return 'STALE_CONNECTION' as const;
        player.ready = payload.ready ?? !player.ready;
        const startNow = locked.matchmaking && locked.players.length === 2 &&
          locked.players.every((candidate) => candidate.ready && candidate.connected);
        if (startNow) locked.status = 'starting';
        return {
          room: locked,
          startNow,
        };
      }, (value) => typeof value === 'object');
      if (changed === 'STALE_CONNECTION') return ack?.({ code: changed });
      if (changed === 'READY_CHECK_EXPIRED') {
        await processReadyCheck(io, room.id);
        return ack?.({ code: changed });
      }
      if (!changed) return ack?.({ code: 'NOT_IN_WAITING_ROOM' });
      const changedPlayer = changed.room.players.find((player) => player.key === me.key);
      emitRoomPatch(io, changed.room, {
        players: {
          updated: changedPlayer
            ? [{ key: me.key, ready: changedPlayer.ready }]
            : [],
        },
      });
      if (changed.startNow) {
        const started = await startRound(io, changed.room.id);
        if (!started) return ack?.({ code: 'ROOM_NOT_READY' });
      }
      ack?.({ ok: true });
    }, roomReadyPayloadSchema);

    safeOn(socket, 'game:start', async (_payload, ack) => {
      await restorePromise;
      if (!(await socketAllowed('start', me.key, 8, 10))) {
        return ack?.({ code: 'RATE_LIMITED' });
      }
      const room = await getRoomForIdentity(me.key);
      if (!room) return ack?.({ code: 'ROOM_NOT_READY' });
      const result = await withRoomLock(room.id, (locked) => {
        if (locked.hostKey !== me.key) return 'NOT_HOST';
        if (locked.players.find((player) => player.key === me.key)?.socketId !== socket.id) {
          return 'STALE_CONNECTION';
        }
        if (locked.status === 'starting' || locked.status === 'playing') return 'ALREADY_STARTED';
        if (locked.status !== 'waiting') return 'ROOM_NOT_READY';
        if (locked.players.length < 2) return 'NEED_TWO_PLAYERS';
        if (!locked.players.every((p) => p.ready && p.connected)) return 'PLAYERS_NOT_READY';
        locked.status = 'starting';
        return 'OK';
      }, (value) => value === 'OK');
      if (result === 'ALREADY_STARTED') {
        if (room.status === 'starting') await startRound(io, room.id);
        const current = await getRoom(room.id);
        return ack?.(current
          ? { ok: true, room: publicRoom(current, me.key) }
          : { code: 'ROOM_NOT_READY' });
      }
      if (result !== 'OK') return ack?.({ code: result ?? 'ROOM_NOT_READY' });
      const started = await startRound(io, room.id);
      ack?.(started ? { ok: true } : { code: 'EMPTY_PLAYER_POOL' });
    });

    safeOn(socket, 'game:guess', async (payload: z.infer<typeof gameGuessPayloadSchema>, ack) => {
      await restorePromise;
      if (!allowLocalGuess(me.key)) return ack?.({ code: 'RATE_LIMITED' });
      const roomId = String(socket.data.roomId || await getRoomIdForIdentity(me.key) || '');
      if (!roomId) return ack?.({ code: 'NO_ACTIVE_ROUND', reason: 'identity_room_missing' });
      socket.data.roomId = roomId;
      const guess = getEnabledPlayer(payload.playerId);
      if (!guess) return ack?.({ code: 'PLAYER_NOT_FOUND' });
      const { roundId, eventId } = payload;
      const targetState = await getRoomGuessTarget(roomId, roundId);
      if (!targetState) return ack?.({ code: 'NO_ACTIVE_ROUND', reason: 'target_missing' });
      if (targetState.round !== roundId) {
        return ack?.({ code: 'STALE_ROUND', reason: 'round_id_mismatch' });
      }
      const target = getPlayer(targetState.targetPlayerId);
      if (!target) return ack?.({ code: 'INTERNAL_ERROR' });
      const result = await applyRoomGuess({
        roomId,
        identity: me.key,
        socketId: socket.id,
        expectedRound: roundId,
        eventId,
        targetPlayerId: targetState.targetPlayerId,
        feedback: compareGuess(guess, target),
        maxGuesses: MAX_GUESSES,
        roundDurationMs: ROUND_TIME_MS,
        nextRoundDelayMs: NEXT_ROUND_DELAY_MS,
        minGuessIntervalMs: MULTI_GUESS_INTERVAL_MS,
        rateLimit: 12,
        rateWindowSeconds: 10,
      });
      if (result.kind === 'error') {
        if (result.code === 'GUESS_COOLDOWN') {
          return ack?.({ code: result.code, retryAfterMs: result.retryAfterMs });
        }
        if (result.reason === 'deadline_passed') {
          await finishRound(io, roomId, null, 'timeout', roundId);
          const latest = await getRoom(roomId);
          return ack?.({
            code: result.code,
            reason: result.reason,
            room: latest ? publicRoom(latest, me.key) : undefined,
          });
        }
        return ack?.({ code: result.code, reason: result.reason });
      }
      const delta = {
        roomId,
        roundId: result.round,
        key: me.key,
        stateVersion: result.revision,
      };
      if (result.kind === 'duplicate') {
        ack?.({ cooldownMs: MULTI_GUESS_INTERVAL_MS });
        socket.emit('game:guess:applied', { ...delta, feedback: visibleGuess(result.feedback) });
        return;
      }
      let finishedRoom = result.shouldFinish ? result.room : undefined;
      if (result.shouldFinish) {
        finishedRoom = await recordReplayRound(roomId, result.round) ?? finishedRoom;
      }
      ack?.({ cooldownMs: MULTI_GUESS_INTERVAL_MS });
      if (!result.shouldFinish) {
        for (const playerKey of result.playerKeys) {
          io.to(identityChannel(playerKey)).emit('game:guess:applied', {
            ...delta,
            feedback: playerKey === me.key ? visibleGuess(result.feedback) : hiddenGuess(result.feedback),
          });
        }
        io.to(spectatorChannel(roomId)).emit('game:guess:applied', {
          ...delta,
          feedback: visibleGuess(result.feedback),
        });
      }
      if (result.shouldFinish) {
        if (!finishedRoom) throw new Error('MISSING_FINISHED_ROOM_SNAPSHOT');
        const winnerKey = result.correct ? me.key : null;
        if (result.matchOver) {
          emitRoomViews(io, finishedRoom, 'match:over', (viewerKey) => ({
            room: publicRoom(finishedRoom, viewerKey),
            serverNow: Date.now(),
          }));
          void persistMatch(finishedRoom, winnerKey).catch((err) => console.error('[match:persist]', err));
          setLocalTimer(`cleanup:${roomId}`, FINISHED_ROOM_TTL_MS, () => {
            return cleanupRoom(roomId);
          });
        } else {
          emitRoomViews(io, finishedRoom, 'round:over', (viewerKey) => ({
            room: publicRoom(finishedRoom, viewerKey),
            serverNow: Date.now(),
          }));
          setLocalTimer(`next:${roomId}`, NEXT_ROUND_DELAY_MS, () => startRound(io, roomId));
        }
      }
    }, gameGuessPayloadSchema);

    const handleSkipRound = async (payload: z.infer<typeof activeRoundPayloadSchema>, ack?: (value: any) => void) => {
      await restorePromise;
      if (!(await socketAllowed('skip-round', me.key, 5, 60))) {
        return ack?.({ code: 'RATE_LIMITED' });
      }
      const roomId = String(socket.data.roomId || await getRoomIdForIdentity(me.key) || '');
      if (!roomId) return ack?.({ code: 'NO_ACTIVE_ROUND' });
      const { roundId } = payload;
      const result = await skipRound(io, roomId, me.key, socket.id, roundId);
      if (result === 'stale') return ack?.({ code: 'STALE_CONNECTION' });
      if (!result) {
        const latest = await getRoom(roomId);
        return ack?.({
          code: latest?.round !== roundId ? 'STALE_ROUND' : 'NO_ACTIVE_ROUND',
          room: latest ? publicRoom(latest, me.key) : undefined,
        });
      }
      ack?.({ ok: true, room: publicRoom(result.room, me.key) });
    };
    safeOn(socket, 'game:skip-round', handleSkipRound, activeRoundPayloadSchema);
    // Rolling-upgrade compatibility for clients that still send the old event name.
    safeOn(socket, 'game:surrender-round', handleSkipRound, activeRoundPayloadSchema);

    safeOn(socket, 'room:leave', async (_payload, ack) => {
      await restorePromise;
      let room = await getRoomForIdentity(me.key, true);
      if (!room) return ack?.({ ok: true });
      if (room.status === 'finished') {
        const left = await withRoomLock(room.id, (locked) => {
          const player = locked.players.find((candidate) => candidate.key === me.key);
          if (!player) return null;
          if (player.socketId !== socket.id && locked.rematchAllowed) {
            return { stale: true as const };
          }
          const cancelledInvite = locked.rematchInviterKey !== null;
          player.connected = false;
          locked.rematchInviterKey = null;
          return { room: locked, cancelledInvite };
        }, (value) => Boolean(value && !('stale' in value)));
        if (left && 'stale' in left) return ack?.({ code: 'STALE_CONNECTION' });
        if (left) {
          if (left.cancelledInvite) {
            emitRematchUpdate(io, left.room, 'cancelled', me.key, {
              key: me.key,
              connected: false,
            });
          }
          else {
            emitRoomPatch(io, left.room, {
              players: { updated: [{ key: me.key, connected: false }] },
            });
          }
        }
        await clearIdentityRoom(me.key, room.id);
        socket.leave(room.id);
        socket.leave(spectatorChannel(room.id));
        socket.data.roomId = undefined;
        return ack?.({ ok: true });
      }
      const player = room.players.find((p) => p.key === me.key);
      if (player && room.status === 'waiting' && room.matchmaking) {
        const opponent = room.players.find((candidate) => candidate.key !== me.key);
        let penaltyMultiplier: 0 | 0.5 | 1 = 1;
        if (opponent) {
          try {
            const performance = await getPlayerPerformance(opponent);
            penaltyMultiplier = readyExitPenaltyMultiplier(
              performance.multi.recentAverageWinningGuesses
            );
          } catch (err) {
            logTransientError('[match:ready-exit-performance]', err);
          }
        }
        const abandoned = await withRoomLock(room.id, async (locked) => {
          if (locked.status !== 'waiting' || !locked.matchmaking) return 'CHANGED' as const;
          const current = locked.players.find((candidate) => candidate.key === me.key);
          if (!current || current.socketId !== socket.id) return 'STALE_CONNECTION' as const;
          await deleteRoom(locked);
          return { room: locked };
        }, () => false);
        if (abandoned === 'STALE_CONNECTION') return ack?.({ code: abandoned });
        if (abandoned && abandoned !== 'CHANGED') {
          const cooldown = penaltyMultiplier === 0
            ? null
            : await recordMatchmakingExit(me.key, penaltyMultiplier);
          for (const other of abandoned.room.players) {
            if (other.key === me.key) continue;
            io.to(identityChannel(other.key)).emit('match:ready-ended', {
              roomId: abandoned.room.id,
              reason: 'opponent_left',
              penalized: false,
              retryAt: null,
              serverNow: Date.now(),
            });
          }
          socket.leave(room.id);
          socket.data.roomId = undefined;
          return ack?.({
            ok: true,
            retryAt: cooldown?.retryAt ?? null,
            serverNow: Date.now(),
          });
        }
        room = await getRoomForIdentity(me.key, true);
        if (!room) return ack?.({ ok: true });
      }
      const currentPlayer = room.players.find((p) => p.key === me.key);
      if (currentPlayer && (room.status === 'playing' || room.status === 'round_over' || room.status === 'starting')) {
        const opponent = room.players.find((p) => p.key !== me.key);
        const finished = await finishMatch(io, room.id, opponent?.key ?? null, 'opponent_left', {
          key: me.key,
          socketId: socket.id,
        });
        if (finished === 'stale') return ack?.({ code: 'STALE_CONNECTION' });
        await clearIdentityRoom(me.key, room.id);
      } else {
        const left = await withRoomLock(room.id, (locked) => {
          const currentPlayer = locked.players.find((candidate) => candidate.key === me.key);
          const currentSpectator = locked.spectators.find((candidate) => candidate.key === me.key);
          if (
            (currentPlayer && currentPlayer.socketId !== socket.id) ||
            (currentSpectator && currentSpectator.socketId !== socket.id)
          ) return 'STALE_CONNECTION' as const;
          locked.players = locked.players.filter((p) => p.key !== me.key);
          locked.spectators = locked.spectators.filter((p) => p.key !== me.key);
          if (locked.players.length && locked.hostKey === me.key) locked.hostKey = locked.players[0].key;
          if (locked.players.length === 1) locked.players[0].ready = true;
          return { room: locked };
        }, (value) => typeof value === 'object');
        if (left === 'STALE_CONNECTION') return ack?.({ code: left });
        if (!left) return ack?.({ ok: true });
        await clearIdentityRoom(me.key, room.id);
        if (!left.room.players.length && !left.room.spectators.length) {
          await deleteRoom(left.room);
        } else {
          emitRoomPatch(io, left.room, {
            hostKey: left.room.hostKey,
            players: {
              removed: [me.key],
              updated: left.room.players.length === 1
                ? [{ key: left.room.players[0].key, ready: left.room.players[0].ready }]
                : [],
            },
            spectatorCount: connectedSpectatorCount(left.room),
          });
        }
      }
      socket.leave(room.id);
      socket.leave(spectatorChannel(room.id));
      socket.data.roomId = undefined;
      ack?.({ ok: true });
    });

    safeOn(socket, 'match:start', async (payload: z.infer<typeof matchStartPayloadSchema>, ack) => {
      await restorePromise;
      await refreshIdentityEmailState();
      if (!(await socketAllowed('match', me.key, 10, 60))) return ack?.({ code: 'RATE_LIMITED' });
      const currentRoom = await getRoomForIdentity(me.key);
      if (currentRoom) return ack?.({
        queued: false,
        room: publicRoom(currentRoom, me.key),
        serverNow: Date.now(),
      });
      if (!me.userId || !me.emailVerified) {
        await cancelQueue(me.key);
        return ack?.({ code: 'EMAIL_VERIFICATION_REQUIRED' });
      }
      const cooldown = await getMatchmakingCooldown(me.key);
      if (cooldown) return ack?.({
        code: 'MATCHMAKING_COOLDOWN',
        retryAt: cooldown.retryAt,
        serverNow: Date.now(),
      });
      await cancelQueue(me.key);
      const dbType: DbType = payload.dbType;
      if (!isDifficultyAvailable(dbType)) return ack?.({ code: 'DIFFICULTY_UNAVAILABLE' });
      const queuedMe: QueuedIdentity = {
        ...me,
        socketId: socket.id,
        anonymous: payload.anonymous,
        verifiedOnly: true,
        matchmakingPool: (me.userId
          ? await isMatchmakingRestricted(me.userId)
          : await isGuestMatchmakingRestricted(me.key.slice(2)))
          ? 'verified-restricted'
          : 'verified',
      };
      let opponent = isRedisAvailable() ? await queueOrTakeOpponent(dbType, queuedMe) : null;
      if (isRedisAvailable() && !opponent) return ack?.({ queued: true });
      if (!isRedisAvailable() && !opponent) {
        const localQueueKey = `${queuedMe.matchmakingPool}:${dbType}`;
        const queue = localQueue.get(localQueueKey) ?? [];
        if (queuedMe.matchmakingPool === 'restricted') {
          localQueue.set(localQueueKey, [...queue.filter((item) => item.key !== me.key), queuedMe]);
          return ack?.({ queued: true });
        }
        opponent = queue.find((item) => item.key !== me.key) ?? null;
        if (opponent) localQueue.set(localQueueKey, queue.filter((item) => item.key !== opponent!.key));
        else {
          localQueue.set(localQueueKey, [...queue.filter((item) => item.key !== me.key), queuedMe]);
          return ack?.({ queued: true });
        }
      }
      if (!opponent) return ack?.({ queued: true });
      if (!socket.connected) {
        await requeueCandidate(dbType, opponent);
        return;
      }
      const now = Date.now();
      const roomId = await genRoomId();
      if (!(await reserveRoomCapacity(String(socket.data.ip), roomId))) {
        await requeueCandidate(dbType, opponent);
        return ack?.({ code: 'ROOM_CAPACITY_REACHED' });
      }
      const room: StoredRoom = {
        id: roomId,
        recordId: randomUUID(),
        ownerIp: String(socket.data.ip),
        hostKey: opponent.key,
        status: 'waiting',
        matchmaking: true,
        readyCheckEndsAt: now + config.matchReadyTimeoutMs,
        dbType,
        boType: 3,
        rematchAllowed: false,
        rematchInviterKey: null,
        allowSpectators: false,
        verifiedOnly: true,
        anonymous: Boolean(queuedMe.anonymous || opponent.anonymous),
        round: 0,
        players: [makePlayer(opponent, opponent.socketId, false), makePlayer(me, socket.id, false)],
        spectators: [],
        targetPlayerId: null,
        roundEndsAt: null,
        nextRoundAt: null,
        eventResults: {},
        roundResult: null,
        matchResult: null,
        reports: [],
        replayRounds: [],
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await saveRoom(room);
      } catch (err) {
        await releaseRoomCapacity(room.ownerIp, room.id);
        if (err instanceof Error && err.message === 'ROOM_IDENTITY_CONFLICT') {
          const [myRoom, opponentRoom] = await Promise.all([
            getRoomForIdentity(me.key),
            getRoomForIdentity(opponent.key),
          ]);
          await Promise.allSettled([
            myRoom ? Promise.resolve() : requeueCandidate(dbType, queuedMe),
            opponentRoom ? Promise.resolve() : requeueCandidate(dbType, opponent),
          ]);
          if (myRoom) {
            return ack?.({
              queued: false,
              room: publicRoom(myRoom, me.key),
              serverNow: Date.now(),
            });
          }
          return ack?.({ queued: true });
        }
        await requeueCandidate(dbType, opponent).catch(() => undefined);
        throw err;
      }
      const [opponentAlive, currentAlive] = await Promise.all([
        isSocketAlive(opponent.socketId),
        isSocketAlive(socket.id),
      ]);
      if (!opponentAlive || !currentAlive) {
        await withRoomLock(room.id, (locked) => {
          const deadline = locked.readyCheckEndsAt ?? Date.now() + config.disconnectForfeitMs;
          for (const player of locked.players) {
            const alive = player.key === me.key ? currentAlive : opponentAlive;
            if (!alive) {
              player.connected = false;
              player.disconnectDeadline = deadline;
            }
          }
        });
      }
      const savedRoom = await getRoom(room.id);
      if (!savedRoom) throw new Error('ROOM_NOT_FOUND');
      await io.in(identityChannel(opponent.key)).socketsJoin(room.id);
      socket.join(room.id);
      socket.data.roomId = room.id;
      ack?.({ queued: false });
      emitRoomViews(io, savedRoom, 'match:found', (viewerKey) => ({
        room: publicRoom(savedRoom, viewerKey),
        serverNow: Date.now(),
      }));
      setLocalTimer(`ready:${savedRoom.id}`, config.matchReadyTimeoutMs + 10, () => {
        return handleScheduledItem(io, `ready|${savedRoom.id}|0`);
      });
    }, matchStartPayloadSchema);

    safeOn(socket, 'match:cancel', async (_payload, ack) => {
      await restorePromise;
      if (!(await socketAllowedWithIp(socket, 'match-cancel', me.key, 10, 160, 10))) {
        return ack?.({ code: 'RATE_LIMITED' });
      }
      await cancelQueue(me.key);
      for (const [key, queue] of localQueue) {
        localQueue.set(key, queue.filter((item) => item.key !== me.key));
      }
      ack?.({ ok: true });
    });

    socket.on('disconnect', () => {
      presenceSubscribers.delete(socket.id);
      heartbeatEntries.delete(socket.id);
      if (socket.data.connectionSlot) {
        socket.data.connectionSlot = false;
        void releaseConnectionSlot(String(socket.data.ip), me.key, socket.id)
          .catch((err) => logTransientError('[presence:release]', err));
      }
      void cancelQueue(me.key, socket.id).catch((err) => logTransientError('[match:cancel-disconnect]', err));
      for (const [key, queue] of localQueue) {
        localQueue.set(
          key,
          queue.filter((item) => item.key !== me.key || item.socketId !== socket.id)
        );
      }
      const disconnectTask = getRoomForIdentity(me.key, true).then(async (room) => {
        if (!room) return;
        const result = await withRoomLock(room.id, (locked) => {
          const spectator = locked.spectators.find((p) => p.key === me.key);
          if (spectator?.socketId === socket.id) {
            spectator.connected = false;
            spectator.disconnectDeadline = Date.now() + config.disconnectForfeitMs;
            return { spectator: true, room: locked };
          }
          const player = locked.players.find((p) => p.key === me.key);
          if (!player || player.socketId !== socket.id) return null;
          if (locked.status === 'finished') {
            const cancelledInvite = locked.rematchInviterKey !== null;
            player.connected = false;
            player.disconnectDeadline = null;
            locked.rematchInviterKey = null;
            return { finished: true as const, cancelledInvite, room: locked };
          }
          player.connected = false;
          player.disconnectDeadline = locked.status === 'waiting' && locked.matchmaking
            ? locked.readyCheckEndsAt
            : Date.now() + config.disconnectForfeitMs;
          return { deadline: player.disconnectDeadline, room: locked };
        }, (value) => Boolean(value));
        if (!result) return;
        if ('spectator' in result) {
          emitRoomPatch(io, result.room, {
            spectatorCount: connectedSpectatorCount(result.room),
          });
          return;
        }
        if ('finished' in result) {
          if (result.cancelledInvite) {
            emitRematchUpdate(io, result.room, 'cancelled', me.key, {
              key: me.key,
              connected: false,
            });
          }
          else {
            emitRoomPatch(io, result.room, {
              players: { updated: [{ key: me.key, connected: false }] },
            });
          }
          return;
        }
        emitRoomPatch(io, result.room, {
          players: { updated: [{ key: me.key, connected: false }] },
        });
        const disconnectDeadline = result.deadline ?? Date.now();
        io.to(room.id).emit('player:offline', {
          key: me.key,
          graceMs: Math.max(0, disconnectDeadline - Date.now()),
        });
        setLocalTimer(`disconnect:${room.id}:${me.key}`, Math.max(0, disconnectDeadline - Date.now()), () => {
          return handleScheduledItem(io, `disconnect|${room.id}|${me.key}`);
        });
      });
      trackBackground(disconnectTask, '[socket:disconnect]');
    });
  });

  return async () => {
    clearInterval(worker);
    clearInterval(heartbeatWorker);
    clearInterval(presenceWorker);
    clearInterval(presenceCleanupWorker);
    presenceSubscribers.clear();
    await Promise.allSettled([
      heartbeatRequest ?? Promise.resolve(),
      ...backgroundTasks,
    ]);
  };
}

export { beginMaintenanceWindow, setRecoveryWindow };
