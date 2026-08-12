import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import { reduceMatchmakingCooldown } from '../services/matchmakingCooldown';
import { enqueueMatchResult } from '../services/matchResultQueue';
import {
  StoredRoom,
  acknowledgeSchedule,
  withRoomLock,
} from '../services/roomStore';
import { FINISHED_ROOM_TTL_MS, NEXT_ROUND_DELAY_MS } from './constants';
import { cleanupRoom } from './roomMaintenance';
import {
  emitRoomViews,
  emitRoomPatch,
  identityChannel,
  identityDisplayName,
  publicRoom,
} from './roomView';
import { setLocalTimer } from './timers';

export function appendReplayRound(room: StoredRoom): void {
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
    ...(room.gameMode === 'relay' ? {
      sharedGuesses: room.relayGuesses.map((guess) => ({
        actorKey: guess.actorKey,
        playerId: guess.playerId,
        guessedAt: guess.guessedAt,
        guessTime: guess.guessTime,
      })),
    } : {}),
  });
  if (room.replayRounds.length > 30) room.replayRounds = room.replayRounds.slice(-30);
}

export async function recordReplayRound(
  roomId: string,
  expectedRound: number
): Promise<StoredRoom | null> {
  const result = await withRoomLock(roomId, (room) => {
    if (room.round !== expectedRound || !room.roundResult) return null;
    appendReplayRound(room);
    return { room };
  }, (value) => Boolean(value));
  return result?.room ?? null;
}

export async function persistMatch(
  room: StoredRoom,
  winnerKey: string | null,
  forfeitedKey: string | null = room.matchResult?.forfeitedKey ?? null
): Promise<void> {
  await enqueueMatchResult({
    recordId: room.recordId,
    dbType: room.dbType,
    boType: room.boType,
    gameMode: room.gameMode,
    totalRounds: room.totalRounds,
    relaySolvedRounds: room.relaySolvedRounds,
    winnerKey,
    reason: room.matchResult?.reason ?? 'score',
    forfeitedKey,
    participants: room.players.map((player) => ({
      key: player.key,
      userId: player.userId,
      name: identityDisplayName(player),
      score: player.score,
      eliminated: player.eliminated,
      eliminationReason: player.eliminationReason,
    })),
    reports: room.reports,
    rounds: room.replayRounds,
  });
  if (room.gameMode === 'classic' && (room.matchResult?.reason ?? 'score') === 'score') {
    await Promise.allSettled(room.players.map((player) => reduceMatchmakingCooldown(player.key)));
  }
  await acknowledgeSchedule(`persist|${room.id}|0`);
}

export type RematchOutcome = 'invited' | 'cancelled' | 'declined' | 'accepted';

export function rematchError(
  room: StoredRoom,
  identity: string,
  socketId: string
): string | null {
  if (!room.rematchAllowed) return 'REMATCH_NOT_ALLOWED';
  if (room.status !== 'finished' || !room.matchResult) {
    return 'REMATCH_NOT_AVAILABLE';
  }
  const eligible = room.players.filter((candidate) => candidate.connected && !candidate.eliminated);
  if (eligible.length < 2) return 'REMATCH_NOT_AVAILABLE';
  const player = eligible.find((candidate) => candidate.key === identity);
  if (!player) return 'REMATCH_NOT_AVAILABLE';
  if (player.socketId !== socketId) return 'STALE_CONNECTION';
  return null;
}

export function emitRematchUpdate(
  io: Server,
  room: StoredRoom,
  outcome: RematchOutcome,
  actorKey: string,
  playerUpdate?: { key: string; connected: boolean }
): void {
  const channels = [...room.players.filter((player) => !player.eliminated), ...room.spectators]
    .map((member) => identityChannel(member.key));
  if (!channels.length) return;
  io.to(channels).emit('match:rematch:update', {
    roomId: room.id,
    stateVersion: room.revision,
    outcome,
    actorKey,
    inviterKey: room.rematchInviterKey,
    acceptedKeys: room.rematchAcceptedKeys,
    requiredKeys: room.rematchRequiredKeys,
    ...(playerUpdate ? { player: playerUpdate } : {}),
  });
}

export function resetForRematch(room: StoredRoom): void {
  const now = Date.now();
  const retainedKeys = new Set(room.rematchRequiredKeys);
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
  room.rematchAcceptedKeys = [];
  room.rematchRequiredKeys = [];
  room.replayRounds = [];
  room.currentTurnKey = null;
  room.relaySolvedRounds = 0;
  room.relayGuesses = [];
  room.createdAt = now;
  if (retainedKeys.size) room.players = room.players.filter((player) => retainedKeys.has(player.key));
  if (!room.players.some((player) => player.key === room.hostKey)) {
    room.hostKey = room.players[0]?.key ?? room.hostKey;
  }
  for (const player of room.players) {
    player.ready = player.key === room.hostKey;
    player.score = 0;
    player.guesses = [];
    player.guessTimes = [];
    player.lastGuessAt = null;
    player.skipped = false;
    player.disconnectDeadline = null;
    player.eliminated = false;
    player.eliminationReason = null;
  }
}

export async function eliminatePlayer(
  io: Server,
  roomId: string,
  playerKey: string,
  reason: 'player_left' | 'disconnect_timeout',
  socketId?: string
): Promise<'eliminated' | 'finished' | 'stale' | 'ignored'> {
  const result = await withRoomLock(roomId, (room) => {
    if (!['starting', 'playing', 'round_over'].includes(room.status) || room.gameMode !== 'classic') {
      return null;
    }
    const player = room.players.find((candidate) => candidate.key === playerKey);
    if (!player || player.eliminated) return null;
    if (socketId && player.socketId !== socketId) return { stale: true as const };
    if (
      reason === 'disconnect_timeout'
      && (player.connected || !player.disconnectDeadline || player.disconnectDeadline > Date.now())
    ) return null;
    player.connected = false;
    player.disconnectDeadline = null;
    player.eliminated = true;
    player.eliminationReason = reason;
    room.rematchInviterKey = null;
    room.rematchAcceptedKeys = [];
    room.rematchRequiredKeys = [];
    const remaining = room.players.filter((candidate) => !candidate.eliminated);
    if (remaining.length > 1) {
      const roundFinished = room.status === 'playing' && remaining.every(
        (candidate) => candidate.skipped || candidate.guesses.length >= room.maxGuesses
      );
      if (roundFinished) {
        room.status = 'round_over';
        room.roundEndsAt = null;
        room.nextRoundAt = Date.now() + NEXT_ROUND_DELAY_MS;
        room.roundResult = {
          round: room.round,
          winnerKey: null,
          reason: remaining.some((candidate) => candidate.skipped) ? 'skipped' : 'exhausted',
          matchOver: false,
          nextRoundAt: room.nextRoundAt,
        };
        appendReplayRound(room);
      }
      return { room, finished: false as const, roundFinished };
    }
    const winnerKey = remaining[0]?.key ?? null;
    if (room.status === 'playing' && room.targetPlayerId) {
      room.roundResult = {
        round: room.round,
        winnerKey,
        reason: 'surrender',
        matchOver: true,
        nextRoundAt: null,
      };
      appendReplayRound(room);
    }
    room.status = 'finished';
    room.roundEndsAt = null;
    room.nextRoundAt = null;
    room.currentTurnKey = null;
    room.eventResults = {};
    room.roundResult = null;
    room.matchResult = {
      winnerKey,
      reason: 'last_player_standing',
      forfeitedKey: playerKey,
    };
    return { room, finished: true as const, winnerKey };
  }, (value) => Boolean(value && !('stale' in value)));
  if (!result) return 'ignored';
  if ('stale' in result) return 'stale';
  if (result.finished) {
    emitRoomViews(io, result.room, 'match:over', (viewerKey) => ({
      room: publicRoom(result.room, viewerKey),
      serverNow: Date.now(),
    }));
    void persistMatch(result.room, result.winnerKey, playerKey)
      .catch((err) => console.error('[match:persist]', err));
    setLocalTimer(`cleanup:${roomId}`, FINISHED_ROOM_TTL_MS, () => cleanupRoom(roomId));
    return 'finished';
  }
  emitRoomPatch(io, result.room, {
    players: {
      updated: [{
        key: playerKey,
        connected: false,
        eliminated: true,
        eliminationReason: reason,
      }],
    },
    rematchInvite: null,
  });
  if (result.roundFinished) {
    emitRoomViews(io, result.room, 'round:over', (viewerKey) => ({
      room: publicRoom(result.room, viewerKey),
      serverNow: Date.now(),
    }));
    setLocalTimer(`next:${roomId}`, NEXT_ROUND_DELAY_MS, () => startRoundAfterElimination(io, roomId));
  }
  return 'eliminated';
}

async function startRoundAfterElimination(io: Server, roomId: string): Promise<void> {
  const { startRound } = await import('./roundLifecycle');
  await startRound(io, roomId);
}

export async function finishMatch(
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
  setLocalTimer(`cleanup:${roomId}`, FINISHED_ROOM_TTL_MS, () => cleanupRoom(roomId));
  return 'finished';
}
