import { Server } from 'socket.io';
import { recordMatchmakingExit } from '../services/matchmakingCooldown';
import {
  acknowledgeSchedule,
  clearIdentityRoom,
  deleteRoom,
  getMaintenanceUntil,
  getRoom,
  removeExpiredSpectators,
  schedule,
  withRoomLock,
} from '../services/roomStore';
import { FINISHED_ROOM_TTL_MS } from './constants';
import { appendReplayRound, persistMatch } from './matchLifecycle';
import { cleanupRoom } from './roomMaintenance';
import { finishRound, startRound } from './roundLifecycle';
import {
  connectedSpectatorCount,
  emitRoomPatch,
  emitRoomViews,
  identityChannel,
  publicRoom,
} from './roomView';
import { setLocalTimer } from './timers';

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

    if (room.gameMode === 'relay') {
      return { kind: 'relay_abort' as const, room };
    }

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
  }, (value) => Boolean(value && (
    value.kind === 'waiting' || value.kind === 'finished' || value.kind === 'relay_abort'
  )));

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
  if (result.kind === 'relay_abort') {
    for (const member of [...result.room.players, ...result.room.spectators]) {
      await clearIdentityRoom(member.key, roomId);
    }
    await deleteRoom(result.room);
    io.to(roomId).emit('relay:aborted', {
      roomId,
      reason: 'disconnect_timeout',
      playerKey: disconnectedKey,
      serverNow: Date.now(),
    });
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

export async function processReadyCheck(io: Server, roomId: string): Promise<number | null> {
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
    // Guess Lua can enqueue persistence before the event handler records the
    // terminal round. Rebuild it from authoritative room state if necessary.
    appendReplayRound(room);
    await persistMatch(room, room.matchResult.winnerKey);
  }
  return null;
}

export async function handleScheduledItem(io: Server, item: string): Promise<void> {
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

export async function handleScheduledGroup(io: Server, items: string[]): Promise<void> {
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
