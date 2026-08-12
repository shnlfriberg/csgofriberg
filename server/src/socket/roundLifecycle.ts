import { Server } from 'socket.io';
import { StoredRoom, withRoomLock } from '../services/roomStore';
import { pickTargetAvoidingRecent, rememberTargetSelection } from '../services/targetSelection';
import {
  FINISHED_ROOM_TTL_MS,
  NEXT_ROUND_DELAY_MS,
  ROUND_TIME_MS,
} from './constants';
import { appendReplayRound, persistMatch } from './matchLifecycle';
import { cleanupRoom } from './roomMaintenance';
import { emitRoomPatch, emitRoomViews, publicRoom } from './roomView';
import { winsNeeded } from './roomRules';
import { setLocalTimer } from './timers';

export async function startRound(io: Server, roomId: string): Promise<boolean> {
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
    room.relayGuesses = [];
    room.currentTurnKey = room.gameMode === 'relay'
      ? room.players[Math.floor(Math.random() * room.players.length)]?.key ?? null
      : null;
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

export async function finishRound(
  io: Server,
  roomId: string,
  winnerKey: string | null,
  reason: 'guessed' | 'exhausted' | 'timeout',
  expectedRound: number
): Promise<void> {
  const result = await withRoomLock(roomId, (room) => {
    if (room.status !== 'playing' || room.round !== expectedRound) return null;
    const winner = room.players.find((player) => player.key === winnerKey);
    if (winner) winner.score += 1;
    room.roundEndsAt = null;
    room.currentTurnKey = null;
    if (room.gameMode === 'relay' && winnerKey) room.relaySolvedRounds += 1;
    const matchOver = room.gameMode === 'relay'
      ? room.round >= room.totalRounds
      : Boolean(winner && winner.score >= winsNeeded(room.boType));
    if (matchOver) room.status = 'finished';
    else {
      room.status = 'round_over';
      room.nextRoundAt = Date.now() + NEXT_ROUND_DELAY_MS;
    }
    room.roundResult = {
      round: room.round,
      winnerKey: room.gameMode === 'relay' ? null : winnerKey,
      reason,
      matchOver,
      nextRoundAt: room.nextRoundAt,
    };
    appendReplayRound(room);
    if (matchOver) room.matchResult = room.gameMode === 'relay'
      ? { winnerKey: null, reason: 'cooperative_score', forfeitedKey: null }
      : { winnerKey, reason: 'score', forfeitedKey: null };
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
    setLocalTimer(`cleanup:${roomId}`, FINISHED_ROOM_TTL_MS, () => cleanupRoom(roomId));
    return;
  }
  emitRoomViews(io, room, 'round:over', (viewerKey) => ({
    room: publicRoom(room, viewerKey),
    serverNow: Date.now(),
  }));
  setLocalTimer(`next:${roomId}`, NEXT_ROUND_DELAY_MS, () => startRound(io, roomId));
}

export async function skipRound(
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
      (candidate) => candidate.skipped || candidate.guesses.length >= room.maxGuesses
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
