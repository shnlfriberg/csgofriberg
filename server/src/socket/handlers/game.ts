import { z } from 'zod';
import { compareGuess } from '../../services/gameService';
import { getEnabledPlayer, getPlayer } from '../../services/playerCache';
import {
  applyRoomGuess,
  getRoom,
  getRoomForIdentity,
  getRoomGuessTarget,
  getRoomIdForIdentity,
  withRoomLock,
} from '../../services/roomStore';
import { allowLocalGuess, socketAllowed } from '../connection';
import {
  FINISHED_ROOM_TTL_MS,
  NEXT_ROUND_DELAY_MS,
  ROUND_TIME_MS,
} from '../constants';
import { registerSocketEvent, SocketAck } from '../event';
import {
  emitRoomViews,
  hiddenGuess,
  identityChannel,
  publicRoom,
  spectatorChannel,
  visibleGuess,
} from '../roomView';
import { activeRoundPayloadSchema, gameGuessPayloadSchema } from '../schemas';
import { setLocalTimer } from '../timers';
import { SocketEventContext, SocketLifecycle } from './context';

type GameEventContext = SocketEventContext & {
  lifecycle: SocketLifecycle;
};

export async function handleGameStart(
  context: GameEventContext,
  _payload: unknown,
  ack?: SocketAck
): Promise<void> {
  const { io, socket, me, restorePromise, lifecycle } = context;
  await restorePromise;
  if (!(await socketAllowed('start', me.key, 8, 10))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const room = await getRoomForIdentity(me.key);
  if (!room) {
    ack?.({ code: 'ROOM_NOT_READY' });
    return;
  }
  const result = await withRoomLock(room.id, (locked) => {
    if (locked.hostKey !== me.key) return 'NOT_HOST';
    if (locked.players.find((player) => player.key === me.key)?.socketId !== socket.id) {
      return 'STALE_CONNECTION';
    }
    if (locked.status === 'starting' || locked.status === 'playing') return 'ALREADY_STARTED';
    if (locked.status !== 'waiting') return 'ROOM_NOT_READY';
    if (locked.players.length < 2) return 'NEED_TWO_PLAYERS';
    if (!locked.players.every((player) => player.ready && player.connected)) {
      return 'PLAYERS_NOT_READY';
    }
    locked.status = 'starting';
    return 'OK';
  }, (value) => value === 'OK');
  if (result === 'ALREADY_STARTED') {
    if (room.status === 'starting') await lifecycle.startRound(io, room.id);
    const current = await getRoom(room.id);
    ack?.(current
      ? { ok: true, room: publicRoom(current, me.key) }
      : { code: 'ROOM_NOT_READY' });
    return;
  }
  if (result !== 'OK') {
    ack?.({ code: result ?? 'ROOM_NOT_READY' });
    return;
  }
  const started = await lifecycle.startRound(io, room.id);
  ack?.(started ? { ok: true } : { code: 'EMPTY_PLAYER_POOL' });
}

export async function handleGameGuess(
  context: GameEventContext,
  payload: z.infer<typeof gameGuessPayloadSchema>,
  ack?: SocketAck
): Promise<void> {
  const { io, socket, me, restorePromise, lifecycle } = context;
  await restorePromise;
  if (!allowLocalGuess(me.key)) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const roomId = String(socket.data.roomId || await getRoomIdForIdentity(me.key) || '');
  if (!roomId) {
    ack?.({ code: 'NO_ACTIVE_ROUND', reason: 'identity_room_missing' });
    return;
  }
  socket.data.roomId = roomId;
  const guess = getEnabledPlayer(payload.playerId);
  if (!guess) {
    ack?.({ code: 'PLAYER_NOT_FOUND' });
    return;
  }
  const { roundId, eventId } = payload;
  const targetState = await getRoomGuessTarget(roomId, roundId);
  if (!targetState) {
    ack?.({ code: 'NO_ACTIVE_ROUND', reason: 'target_missing' });
    return;
  }
  if (targetState.round !== roundId) {
    ack?.({ code: 'STALE_ROUND', reason: 'round_id_mismatch' });
    return;
  }
  const target = getPlayer(targetState.targetPlayerId);
  if (!target) {
    ack?.({ code: 'INTERNAL_ERROR' });
    return;
  }
  const result = await applyRoomGuess({
    roomId,
    identity: me.key,
    socketId: socket.id,
    expectedRound: roundId,
    eventId,
    targetPlayerId: targetState.targetPlayerId,
    feedback: compareGuess(guess, target),
    maxGuesses: targetState.maxGuesses,
    roundDurationMs: ROUND_TIME_MS,
    nextRoundDelayMs: NEXT_ROUND_DELAY_MS,
    minGuessIntervalMs: targetState.guessIntervalMs,
    rateLimit: 12,
    rateWindowSeconds: 10,
    gameMode: targetState.gameMode,
  });
  if (result.kind === 'error') {
    if (result.code === 'GUESS_COOLDOWN') {
      ack?.({ code: result.code, retryAfterMs: result.retryAfterMs });
      return;
    }
    if (result.reason === 'deadline_passed') {
      await lifecycle.finishRound(io, roomId, null, 'timeout', roundId);
      const latest = await getRoom(roomId);
      ack?.({
        code: result.code,
        reason: result.reason,
        room: latest ? publicRoom(latest, me.key) : undefined,
      });
      return;
    }
    ack?.({ code: result.code, reason: result.reason });
    return;
  }
  const delta = {
    roomId,
    roundId: result.round,
    key: me.key,
    stateVersion: result.revision,
  };
  if (result.kind === 'duplicate') {
    ack?.({ cooldownMs: targetState.guessIntervalMs });
    if (targetState.gameMode === 'relay') {
      const current = await getRoom(roomId);
      if (current && result.relayGuess) socket.emit('game:guess:applied', {
        ...delta,
        feedback: visibleGuess(result.feedback),
        guessedAt: result.relayGuess.guessedAt,
        currentTurnKey: current.currentTurnKey,
        serverNow: Date.now(),
      });
      return;
    }
    socket.emit('game:guess:applied', { ...delta, feedback: visibleGuess(result.feedback) });
    return;
  }
  let finishedRoom = result.shouldFinish ? result.room : undefined;
  if (result.shouldFinish) {
    finishedRoom = await lifecycle.recordReplayRound(roomId, result.round) ?? finishedRoom;
  }
  ack?.({ cooldownMs: targetState.guessIntervalMs });
  if (!result.shouldFinish) {
    if (result.room?.gameMode === 'relay') {
      if (!result.relayGuess) throw new Error('MISSING_RELAY_GUESS_DELTA');
      emitRoomViews(io, result.room, 'game:guess:applied', () => ({
        ...delta,
        feedback: visibleGuess(result.feedback),
        guessedAt: result.relayGuess!.guessedAt,
        currentTurnKey: result.room!.currentTurnKey,
        serverNow: Date.now(),
      }));
      return;
    }
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
  if (!result.shouldFinish) return;
  if (!finishedRoom) throw new Error('MISSING_FINISHED_ROOM_SNAPSHOT');
  const winnerKey = finishedRoom.gameMode === 'relay' ? null : result.correct ? me.key : null;
  if (result.matchOver) {
    emitRoomViews(io, finishedRoom, 'match:over', (viewerKey) => ({
      room: publicRoom(finishedRoom, viewerKey),
      serverNow: Date.now(),
    }));
    void lifecycle.persistMatch(finishedRoom, winnerKey)
      .catch((err) => console.error('[match:persist]', err));
    setLocalTimer(`cleanup:${roomId}`, FINISHED_ROOM_TTL_MS, () => {
      return lifecycle.cleanupRoom(roomId);
    });
  } else {
    emitRoomViews(io, finishedRoom, 'round:over', (viewerKey) => ({
      room: publicRoom(finishedRoom, viewerKey),
      serverNow: Date.now(),
    }));
    setLocalTimer(`next:${roomId}`, NEXT_ROUND_DELAY_MS, () => {
      return lifecycle.startRound(io, roomId);
    });
  }
}

export async function handleGameSkipRound(
  context: GameEventContext,
  payload: z.infer<typeof activeRoundPayloadSchema>,
  ack?: SocketAck
): Promise<void> {
  const { io, socket, me, restorePromise, lifecycle } = context;
  await restorePromise;
  const activeRoom = await getRoomForIdentity(me.key);
  if (activeRoom?.gameMode === 'relay') {
    ack?.({ code: 'RELAY_SKIP_DISABLED' });
    return;
  }
  if (!(await socketAllowed('skip-round', me.key, 5, 60))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const roomId = String(socket.data.roomId || await getRoomIdForIdentity(me.key) || '');
  if (!roomId) {
    ack?.({ code: 'NO_ACTIVE_ROUND' });
    return;
  }
  const { roundId } = payload;
  const result = await lifecycle.skipRound(io, roomId, me.key, socket.id, roundId);
  if (result === 'stale') {
    ack?.({ code: 'STALE_CONNECTION' });
    return;
  }
  if (!result) {
    const latest = await getRoom(roomId);
    ack?.({
      code: latest?.round !== roundId ? 'STALE_ROUND' : 'NO_ACTIVE_ROUND',
      room: latest ? publicRoom(latest, me.key) : undefined,
    });
    return;
  }
  ack?.({ ok: true, room: publicRoom(result.room, me.key) });
}

export function registerGameEvents(context: GameEventContext): void {
  registerSocketEvent(
    context.socket,
    'game:start',
    (payload, ack) => handleGameStart(context, payload, ack)
  );
  registerSocketEvent(
    context.socket,
    'game:guess',
    (payload, ack) => handleGameGuess(context, payload, ack),
    gameGuessPayloadSchema
  );
  registerSocketEvent(
    context.socket,
    'game:skip-round',
    (payload, ack) => handleGameSkipRound(context, payload, ack),
    activeRoundPayloadSchema
  );
}
