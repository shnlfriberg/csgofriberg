import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import { reduceMatchmakingCooldown } from '../services/matchmakingCooldown';
import { enqueueMatchResult } from '../services/matchResultQueue';
import {
  StoredRoom,
  acknowledgeSchedule,
  withRoomLock,
} from '../services/roomStore';
import { FINISHED_ROOM_TTL_MS } from './constants';
import { cleanupRoom } from './roomMaintenance';
import {
  emitRoomViews,
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
  if ((room.matchResult?.reason ?? 'score') === 'score') {
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
  if (room.status !== 'finished' || !room.matchResult || room.players.length !== 2) {
    return 'REMATCH_NOT_AVAILABLE';
  }
  const player = room.players.find((candidate) => candidate.key === identity);
  if (!player) return 'REMATCH_NOT_AVAILABLE';
  if (player.socketId !== socketId) return 'STALE_CONNECTION';
  if (!room.players.every((candidate) => candidate.connected)) return 'REMATCH_NOT_AVAILABLE';
  return null;
}

export function emitRematchUpdate(
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

export function resetForRematch(room: StoredRoom): void {
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
