import { randomUUID } from 'crypto';
import { z } from 'zod';
import { isDifficultyAvailable } from '../../services/playerCache';
import { getPlayerPerformance } from '../../services/playerPerformance';
import {
  readyExitPenaltyMultiplier,
  recordMatchmakingExit,
} from '../../services/matchmakingCooldown';
import {
  StoredRoom,
  acknowledgeSchedule,
  clearIdentityRoom,
  deleteRoom,
  getRoom,
  getRoomForIdentity,
  releaseRoomCapacity,
  reserveRoomCapacity,
  saveRoom,
  withRoomLock,
} from '../../services/roomStore';
import { logTransientError } from '../../services/transientLog';
import { socketAllowed, socketAllowedWithIp } from '../connection';
import { MAX_SPECTATORS } from '../constants';
import { registerSocketEvent, SocketAck } from '../event';
import { generateRoomId, makeRoomPlayer } from '../roomFactory';
import {
  connectedSpectatorCount,
  emitRoomPatch,
  identityChannel,
  identityDisplayName,
  joinRoomChannels,
  publicRoom,
  spectatorChannel,
} from '../roomView';
import {
  roomCreatePayloadSchema,
  roomJoinPayloadSchema,
  roomPlayerStatsPayloadSchema,
  roomReadyPayloadSchema,
} from '../schemas';
import { SocketEventContext, SocketLifecycle } from './context';
import { cancelLocalTimer } from '../timers';

type RoomEventContext = SocketEventContext & {
  refreshIdentityEmailState: () => Promise<void>;
  lifecycle: SocketLifecycle;
};

export async function handleRoomSync(
  context: RoomEventContext,
  _payload: unknown,
  ack?: SocketAck
): Promise<void> {
  const { socket, me, restorePromise } = context;
  await restorePromise;
  if (!(await socketAllowedWithIp(socket, 'sync', me.key, 20, 300, 10))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const room = await getRoomForIdentity(me.key, true);
  if (!room) {
    socket.data.roomId = undefined;
    ack?.({ code: 'NOT_IN_ROOM' });
    return;
  }
  joinRoomChannels(socket, room, me.key);
  socket.data.roomId = room.id;
  ack?.({
    room: publicRoom(room, me.key),
    role: room.players.some((player) => player.key === me.key) ? 'player' : 'spectator',
    selfKey: me.key,
    serverNow: Date.now(),
  });
}

export async function handleRoomPlayerStats(
  context: RoomEventContext,
  payload: z.infer<typeof roomPlayerStatsPayloadSchema>,
  ack?: SocketAck
): Promise<void> {
  const { socket, me, restorePromise } = context;
  await restorePromise;
  if (!(await socketAllowedWithIp(socket, 'player-stats', me.key, 20, 60, 60))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const room = await getRoomForIdentity(me.key, true);
  if (!room) {
    ack?.({ code: 'NOT_IN_ROOM' });
    return;
  }

  const requesterIsPlayer = room.players.some((player) => player.key === me.key);
  const requesterIsSpectator = room.spectators.some((spectator) => spectator.key === me.key);
  const target = room.players.find((player) => player.key === payload.playerKey);
  const allowed = Boolean(
    target && (
      requesterIsSpectator ||
      (requesterIsPlayer && target.key !== me.key)
    )
  );
  if (!allowed || !target) {
    ack?.({ code: 'FORBIDDEN' });
    return;
  }

  ack?.({
    playerKey: target.key,
    displayId: identityDisplayName(target),
    stats: await getPlayerPerformance(target),
  });
}

export async function handleRoomCreate(
  context: RoomEventContext,
  payload: z.infer<typeof roomCreatePayloadSchema>,
  ack?: SocketAck
): Promise<void> {
  const { socket, me, restorePromise, refreshIdentityEmailState } = context;
  await restorePromise;
  await refreshIdentityEmailState();
  if (!(await socketAllowed('create', me.key, 5, 60))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const existing = await getRoomForIdentity(me.key);
  if (existing) {
    ack?.({
      code: 'ALREADY_IN_ROOM',
      room: publicRoom(existing, me.key),
      role: existing.players.some((player) => player.key === me.key) ? 'player' : 'spectator',
    });
    return;
  }
  const boType = payload.boType;
  const gameMode = payload.gameMode;
  const totalRounds = gameMode === 'relay' ? payload.totalRounds : boType;
  const dbType = payload.dbType;
  if (!isDifficultyAvailable(dbType)) {
    ack?.({ code: 'DIFFICULTY_UNAVAILABLE' });
    return;
  }
  const now = Date.now();
  const roomId = await generateRoomId();
  if (!(await reserveRoomCapacity(String(socket.data.ip), roomId))) {
    ack?.({ code: 'ROOM_CAPACITY_REACHED' });
    return;
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
    gameMode,
    totalRounds,
    maxPlayers: gameMode === 'classic' ? payload.maxPlayers : 2,
    currentTurnKey: null,
    relaySolvedRounds: 0,
    relayGuesses: [],
    maxGuesses: payload.maxGuesses,
    guessIntervalMs: payload.guessIntervalMs,
    rematchAllowed: true,
    rematchInviterKey: null,
    rematchAcceptedKeys: [],
    rematchRequiredKeys: [],
    allowSpectators: payload.allowSpectators,
    verifiedOnly: payload.verifiedOnly,
    anonymous: payload.anonymous,
    round: 0,
    players: [makeRoomPlayer(me, socket.id, true)],
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
      ack?.({
        code: 'ALREADY_IN_ROOM',
        room: current ? publicRoom(current, me.key) : undefined,
        role: current
          ? current.players.some((player) => player.key === me.key) ? 'player' : 'spectator'
          : undefined,
      });
      return;
    }
    throw err;
  }
  joinRoomChannels(socket, room, me.key);
  socket.data.roomId = room.id;
  ack?.({ room: publicRoom(room, me.key) });
}

export async function handleRoomJoin(
  context: RoomEventContext,
  payload: z.infer<typeof roomJoinPayloadSchema>,
  ack?: SocketAck
): Promise<void> {
  const { io, socket, me, restorePromise, refreshIdentityEmailState } = context;
  await restorePromise;
  await refreshIdentityEmailState();
  if (!(await socketAllowed('join', me.key, 20, 60))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const roomId = payload.roomId;
  const current = await getRoomForIdentity(me.key);
  if (current && current.id !== roomId) {
    ack?.({
      code: 'ALREADY_IN_ROOM',
      room: publicRoom(current, me.key),
      role: current.players.some((player) => player.key === me.key) ? 'player' : 'spectator',
    });
    return;
  }
  const role = await withRoomLock(roomId, (room) => {
    if (room.status === 'finished') return { code: 'ROOM_NOT_FOUND' };
    const player = room.players.find((candidate) => candidate.key === me.key);
    if (player) {
      if (player.eliminated) return { code: 'PLAYER_ELIMINATED' };
      if (player.connected && player.socketId !== socket.id) {
        return { code: 'STALE_CONNECTION' };
      }
      player.socketId = socket.id;
      player.connected = true;
      player.disconnectDeadline = null;
      return { role: 'player' as const, room, existing: true };
    }
    const existingSpectator = room.spectators.find((candidate) => candidate.key === me.key);
    if (room.verifiedOnly && me.key !== room.hostKey && !me.emailVerified) {
      return { code: 'ROOM_VERIFIED_EMAIL_ONLY' };
    }
    const asSpectator = Boolean(
      existingSpectator || payload.spectate || room.status !== 'waiting' || room.players.length >= room.maxPlayers
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
    room.players.push(makeRoomPlayer(me, socket.id, false));
    return { role: 'player' as const, room, existing: false };
  }, (value) => 'role' in value);
  if (!role) {
    ack?.({ code: 'ROOM_NOT_FOUND' });
    return;
  }
  if ('code' in role) {
    ack?.({ code: role.code });
    return;
  }
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
}

export async function handleRoomReady(
  context: RoomEventContext,
  payload: z.infer<typeof roomReadyPayloadSchema>,
  ack?: SocketAck
): Promise<void> {
  const { io, socket, me, restorePromise, lifecycle } = context;
  await restorePromise;
  if (!(await socketAllowedWithIp(socket, 'ready', me.key, 8, 160, 10))) {
    ack?.({ code: 'RATE_LIMITED' });
    return;
  }
  const room = await getRoomForIdentity(me.key);
  if (!room || room.status !== 'waiting') {
    ack?.({ code: 'NOT_IN_WAITING_ROOM' });
    return;
  }
  const changed = await withRoomLock(room.id, (locked) => {
    if (locked.status !== 'waiting') return false;
    if (locked.matchmaking && locked.readyCheckEndsAt && locked.readyCheckEndsAt <= Date.now()) {
      return 'READY_CHECK_EXPIRED' as const;
    }
    const player = locked.players.find((candidate) => candidate.key === me.key);
    if (!player) return false;
    if (player.socketId !== socket.id) return 'STALE_CONNECTION' as const;
    player.ready = payload.ready ?? !player.ready;
    const startNow = locked.matchmaking && locked.players.length === 2 &&
      locked.players.every((candidate) => candidate.ready && candidate.connected);
    if (startNow) locked.status = 'starting';
    return { room: locked, startNow };
  }, (value) => typeof value === 'object');
  if (changed === 'STALE_CONNECTION') {
    ack?.({ code: changed });
    return;
  }
  if (changed === 'READY_CHECK_EXPIRED') {
    await lifecycle.processReadyCheck(io, room.id);
    ack?.({ code: changed });
    return;
  }
  if (!changed) {
    ack?.({ code: 'NOT_IN_WAITING_ROOM' });
    return;
  }
  const changedPlayer = changed.room.players.find((player) => player.key === me.key);
  emitRoomPatch(io, changed.room, {
    players: {
      updated: changedPlayer
        ? [{ key: me.key, ready: changedPlayer.ready }]
        : [],
    },
  });
  if (changed.startNow) {
    const started = await lifecycle.startRound(io, changed.room.id);
    if (!started) {
      ack?.({ code: 'ROOM_NOT_READY' });
      return;
    }
  }
  ack?.({ ok: true });
}

export async function handleRoomLeave(
  context: RoomEventContext,
  _payload: unknown,
  ack?: SocketAck
): Promise<void> {
  const { io, socket, me, restorePromise, lifecycle } = context;
  await restorePromise;
  let room = await getRoomForIdentity(me.key, true);
  if (!room) {
    ack?.({ ok: true });
    return;
  }
  if (room.status === 'finished') {
    const left = await withRoomLock(room.id, async (locked) => {
      const player = locked.players.find((candidate) => candidate.key === me.key);
      if (!player) return null;
      if (player.socketId !== socket.id && locked.rematchAllowed) {
        return { stale: true as const };
      }
      player.connected = false;
      const requiredKeys = lifecycle.syncRematchPreferences(locked);
      const startNow = requiredKeys.length >= 2
        && requiredKeys.every((key) => locked.rematchAcceptedKeys.includes(key));
      if (startNow) {
        await lifecycle.persistMatch(locked, locked.matchResult!.winnerKey);
        lifecycle.resetForRematch(locked, true);
      }
      return { room: locked, startNow };
    }, (value) => Boolean(value && !('stale' in value)));
    if (left && 'stale' in left) {
      ack?.({ code: 'STALE_CONNECTION' });
      return;
    }
    if (left) {
      lifecycle.emitRematchUpdate(
        io,
        left.room,
        left.startNow ? 'started' : 'updated',
        me.key,
        { key: me.key, connected: false }
      );
      if (left.startNow) {
        cancelLocalTimer(`cleanup:${left.room.id}`);
        await acknowledgeSchedule(`cleanup|${left.room.id}|0`);
        await lifecycle.startRound(io, left.room.id);
      }
    }
    await clearIdentityRoom(me.key, room.id);
    socket.leave(room.id);
    socket.leave(spectatorChannel(room.id));
    socket.data.roomId = undefined;
    ack?.({ ok: true });
    return;
  }
  const player = room.players.find((candidate) => candidate.key === me.key);
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
    if (abandoned === 'STALE_CONNECTION') {
      ack?.({ code: abandoned });
      return;
    }
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
      ack?.({
        ok: true,
        retryAt: cooldown?.retryAt ?? null,
        serverNow: Date.now(),
      });
      return;
    }
    room = await getRoomForIdentity(me.key, true);
    if (!room) {
      ack?.({ ok: true });
      return;
    }
  }
  const currentPlayer = room.players.find((candidate) => candidate.key === me.key);
  if (currentPlayer && (
    room.status === 'playing' || room.status === 'round_over' || room.status === 'starting'
  )) {
    if (room.gameMode === 'relay') {
      const aborted = await withRoomLock(room.id, async (locked) => {
        const player = locked.players.find((candidate) => candidate.key === me.key);
        if (!player || player.socketId !== socket.id) return 'STALE_CONNECTION' as const;
        await deleteRoom(locked);
        return { room: locked };
      }, () => false);
      if (aborted === 'STALE_CONNECTION') {
        ack?.({ code: aborted });
        return;
      }
      if (aborted && typeof aborted === 'object') {
        await Promise.all([...aborted.room.players, ...aborted.room.spectators]
          .map((member) => clearIdentityRoom(member.key, aborted.room.id)));
        io.to(aborted.room.id).emit('relay:aborted', {
          roomId: aborted.room.id,
          reason: 'player_left',
          playerKey: me.key,
          serverNow: Date.now(),
        });
      }
      socket.leave(room.id);
      socket.leave(spectatorChannel(room.id));
      socket.data.roomId = undefined;
      ack?.({ ok: true });
      return;
    }
    const outcome = room.maxPlayers > 2
      ? await lifecycle.eliminatePlayer(io, room.id, me.key, 'player_left', socket.id)
      : await lifecycle.finishMatch(
          io,
          room.id,
          room.players.find((candidate) => candidate.key !== me.key)?.key ?? null,
          'opponent_left',
          { key: me.key, socketId: socket.id }
        );
    if (outcome === 'stale') {
      ack?.({ code: 'STALE_CONNECTION' });
      return;
    }
    await clearIdentityRoom(me.key, room.id);
  } else {
    const left = await withRoomLock(room.id, (locked) => {
      const lockedPlayer = locked.players.find((candidate) => candidate.key === me.key);
      const currentSpectator = locked.spectators.find((candidate) => candidate.key === me.key);
      if (
        (lockedPlayer && lockedPlayer.socketId !== socket.id) ||
        (currentSpectator && currentSpectator.socketId !== socket.id)
      ) return 'STALE_CONNECTION' as const;
      locked.players = locked.players.filter((candidate) => candidate.key !== me.key);
      locked.spectators = locked.spectators.filter((candidate) => candidate.key !== me.key);
      if (locked.players.length && locked.hostKey === me.key) locked.hostKey = locked.players[0].key;
      if (locked.players.length === 1) locked.players[0].ready = true;
      return { room: locked };
    }, (value) => typeof value === 'object');
    if (left === 'STALE_CONNECTION') {
      ack?.({ code: left });
      return;
    }
    if (!left) {
      ack?.({ ok: true });
      return;
    }
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
}

export function registerRoomEvents(context: RoomEventContext): void {
  registerSocketEvent(
    context.socket,
    'room:sync',
    (payload, ack) => handleRoomSync(context, payload, ack)
  );
  registerSocketEvent(
    context.socket,
    'room:player-stats',
    (payload, ack) => handleRoomPlayerStats(context, payload, ack),
    roomPlayerStatsPayloadSchema
  );
  registerSocketEvent(
    context.socket,
    'room:create',
    (payload, ack) => handleRoomCreate(context, payload, ack),
    roomCreatePayloadSchema
  );
  registerSocketEvent(
    context.socket,
    'room:join',
    (payload, ack) => handleRoomJoin(context, payload, ack),
    roomJoinPayloadSchema
  );
  registerSocketEvent(
    context.socket,
    'room:ready',
    (payload, ack) => handleRoomReady(context, payload, ack),
    roomReadyPayloadSchema
  );
  registerSocketEvent(
    context.socket,
    'room:leave',
    (payload, ack) => handleRoomLeave(context, payload, ack)
  );
}
