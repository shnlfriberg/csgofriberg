import { randomUUID } from 'crypto';
import { z } from 'zod';
import { config } from '../../config';
import { isRedisAvailable } from '../../redis';
import { getMatchmakingCooldown } from '../../services/matchmakingCooldown';
import { isMatchmakingRestricted } from '../../services/matchmakingRestriction';
import { isDifficultyAvailable } from '../../services/playerCache';
import {
  DbType,
  QueuedIdentity,
  StoredRoom,
  DEFAULT_ROOM_GUESS_INTERVAL_MS,
  DEFAULT_ROOM_MAX_GUESSES,
  cancelQueue,
  getRoom,
  getRoomForIdentity,
  isSocketAlive,
  queueOrTakeOpponent,
  requeueCandidate,
  releaseRoomCapacity,
  reserveRoomCapacity,
  saveRoom,
  withRoomLock,
} from '../../services/roomStore';
import { socketAllowed, socketAllowedWithIp } from '../connection';
import { registerSocketEvent, SocketAck } from '../event';
import { cancelLocalMatchmaking, queueOrTakeLocalOpponent } from '../matchmakingQueue';
import { generateRoomId, makeRoomPlayer } from '../roomFactory';
import { emitRoomViews, identityChannel, publicRoom } from '../roomView';
import { matchStartPayloadSchema } from '../schemas';
import { setLocalTimer } from '../timers';
import { SocketEventContext, SocketLifecycle } from './context';

type MatchmakingEventContext = SocketEventContext & {
  refreshIdentityEmailState: () => Promise<void>;
  lifecycle: SocketLifecycle;
};

export async function handleMatchStart(
  context: MatchmakingEventContext,
  payload: z.infer<typeof matchStartPayloadSchema>,
  ack?: SocketAck
): Promise<void> {
  const { io, socket, me, restorePromise, refreshIdentityEmailState, lifecycle } = context;
  await restorePromise;
  await refreshIdentityEmailState();
  if (!(await socketAllowed('match', me.key, 10, 60))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const currentRoom = await getRoomForIdentity(me.key);
  if (currentRoom) {
    ack?.({
      queued: false,
      room: publicRoom(currentRoom, me.key),
      serverNow: Date.now(),
    });
    return;
  }
  if (!me.userId || !me.emailVerified) {
    await cancelQueue(me.key);
    ack?.({ code: 'EMAIL_VERIFICATION_REQUIRED' });
    return;
  }
  const cooldown = await getMatchmakingCooldown(me.key);
  if (cooldown) {
    ack?.({
      code: 'MATCHMAKING_COOLDOWN',
      retryAt: cooldown.retryAt,
      serverNow: Date.now(),
    });
    return;
  }
  await cancelQueue(me.key);
  const dbType: DbType = payload.dbType;
  if (!isDifficultyAvailable(dbType)) {
    ack?.({ code: 'DIFFICULTY_UNAVAILABLE' });
    return;
  }
  const queuedMe: QueuedIdentity = {
    ...me,
    socketId: socket.id,
    anonymous: payload.anonymous,
    matchmakingPool: me.userId && await isMatchmakingRestricted(me.userId)
      ? 'restricted'
      : 'verified',
  };
  let opponent = isRedisAvailable() ? await queueOrTakeOpponent(dbType, queuedMe) : null;
  if (isRedisAvailable() && !opponent) {
    ack?.({ queued: true });
    return;
  }
  if (!isRedisAvailable() && !opponent) {
    opponent = queueOrTakeLocalOpponent(dbType, queuedMe);
    if (!opponent) {
      ack?.({ queued: true });
      return;
    }
  }
  if (!opponent) {
    ack?.({ queued: true });
    return;
  }
  if (!socket.connected) {
    await requeueCandidate(dbType, opponent);
    return;
  }
  const now = Date.now();
  const roomId = await generateRoomId();
  if (!(await reserveRoomCapacity(String(socket.data.ip), roomId))) {
    await requeueCandidate(dbType, opponent);
    ack?.({ code: 'ROOM_CAPACITY_REACHED' });
    return;
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
    maxGuesses: DEFAULT_ROOM_MAX_GUESSES,
    guessIntervalMs: DEFAULT_ROOM_GUESS_INTERVAL_MS,
    rematchAllowed: true,
    rematchInviterKey: null,
    allowSpectators: false,
    verifiedOnly: true,
    anonymous: Boolean(queuedMe.anonymous || opponent.anonymous),
    round: 0,
    players: [
      makeRoomPlayer(opponent, opponent.socketId, false),
      makeRoomPlayer(me, socket.id, false),
    ],
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
        ack?.({
          queued: false,
          room: publicRoom(myRoom, me.key),
          serverNow: Date.now(),
        });
        return;
      }
      ack?.({ queued: true });
      return;
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
    return lifecycle.handleScheduledItem(io, `ready|${savedRoom.id}|0`);
  });
}

export async function handleMatchCancel(
  context: MatchmakingEventContext,
  _payload: unknown,
  ack?: SocketAck
): Promise<void> {
  const { socket, me, restorePromise } = context;
  await restorePromise;
  if (!(await socketAllowedWithIp(socket, 'match-cancel', me.key, 10, 160, 10))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  await cancelQueue(me.key);
  cancelLocalMatchmaking(me.key);
  ack?.({ ok: true });
}

export function registerMatchmakingEvents(context: MatchmakingEventContext): void {
  registerSocketEvent(
    context.socket,
    'match:start',
    (payload, ack) => handleMatchStart(context, payload, ack),
    matchStartPayloadSchema
  );
  registerSocketEvent(
    context.socket,
    'match:cancel',
    (payload, ack) => handleMatchCancel(context, payload, ack)
  );
}
