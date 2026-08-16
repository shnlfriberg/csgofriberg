import { config } from '../../config';
import {
  acknowledgeSchedule,
  cancelQueue,
  getRoomForIdentity,
  withRoomLock,
} from '../../services/roomStore';
import { logTransientError } from '../../services/transientLog';
import { releaseConnectionSlot } from '../connection';
import { cancelLocalMatchmaking } from '../matchmakingQueue';
import { connectedSpectatorCount, emitRoomPatch, emitRoomViews, publicRoom } from '../roomView';
import { cancelLocalTimer, setLocalTimer } from '../timers';
import { SocketEventContext, SocketLifecycle } from './context';

type DisconnectContext = Omit<SocketEventContext, 'restorePromise'> & {
  presenceSubscribers: Set<string>;
  heartbeatEntries: Map<string, { ip: string; identity: string; socketId: string }>;
  lifecycle: SocketLifecycle;
  trackBackground: <T>(task: Promise<T>, label: string) => void;
};

export function handleSocketDisconnect(context: DisconnectContext): void {
  const {
    io,
    socket,
    me,
    presenceSubscribers,
    heartbeatEntries,
    lifecycle,
    trackBackground,
  } = context;
  presenceSubscribers.delete(socket.id);
  heartbeatEntries.delete(socket.id);
  if (socket.data.connectionSlot) {
    socket.data.connectionSlot = false;
    void releaseConnectionSlot(String(socket.data.ip), me.key, socket.id)
      .catch((err) => logTransientError('[presence:release]', err));
  }
  void cancelQueue(me.key, socket.id)
    .catch((err) => logTransientError('[match:cancel-disconnect]', err));
  cancelLocalMatchmaking(me.key, socket.id);
  const disconnectTask = getRoomForIdentity(me.key, true).then(async (room) => {
    if (!room) return;
      const result = await withRoomLock(room.id, async (locked) => {
      const spectator = locked.spectators.find((candidate) => candidate.key === me.key);
      if (spectator?.socketId === socket.id) {
        spectator.connected = false;
        spectator.disconnectDeadline = Date.now() + config.disconnectForfeitMs;
        return { spectator: true, room: locked };
      }
      const player = locked.players.find((candidate) => candidate.key === me.key);
      if (!player || player.socketId !== socket.id) return null;
      if (locked.status === 'finished') {
        if (locked.gameMode === 'relay2v2' && player.key === locked.hostKey) {
          player.connected = false;
          player.disconnectDeadline = null;
          locked.rematchAllowed = false;
          locked.rematchInviterKey = null;
          locked.rematchAcceptedKeys = [];
          locked.rematchRequiredKeys = [];
          return { hostLeft: true as const, room: locked };
        }
        player.connected = false;
        player.disconnectDeadline = null;
        const requiredKeys = lifecycle.syncRematchPreferences(locked);
        const startNow = requiredKeys.length >= 2
          && requiredKeys.every((key) => locked.rematchAcceptedKeys.includes(key));
        if (startNow) {
          await lifecycle.persistMatch(locked, locked.matchResult!.winnerKey);
          lifecycle.resetForRematch(locked, !(locked.gameMode === 'relay2v2' && requiredKeys.length < 4));
        }
        return {
          finished: true as const,
          startNow: startNow && !(locked.gameMode === 'relay2v2' && requiredKeys.length < 4),
          waitingForPlayers: startNow && locked.gameMode === 'relay2v2' && requiredKeys.length < 4,
          room: locked,
        };
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
    if ('hostLeft' in result) {
      emitRoomViews(io, result.room, 'match:over', (viewerKey) => ({
        room: publicRoom(result.room, viewerKey),
        serverNow: Date.now(),
      }));
      return;
    }
    if ('finished' in result) {
      lifecycle.emitRematchUpdate(
        io,
        result.room,
        result.startNow ? 'started' : result.waitingForPlayers ? 'waiting' : 'updated',
        me.key,
        { key: me.key, connected: false }
      );
      if (result.startNow || result.waitingForPlayers) {
        cancelLocalTimer(`cleanup:${result.room.id}`);
        await acknowledgeSchedule(`cleanup|${result.room.id}|0`);
        if (result.startNow) await lifecycle.startRound(io, result.room.id);
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
    setLocalTimer(
      `disconnect:${room.id}:${me.key}`,
      Math.max(0, disconnectDeadline - Date.now()),
      () => lifecycle.handleScheduledItem(io, `disconnect|${room.id}|${me.key}`)
    );
  });
  trackBackground(disconnectTask, '[socket:disconnect]');
}

export function registerDisconnectHandler(context: DisconnectContext): void {
  context.socket.on('disconnect', () => handleSocketDisconnect(context));
}
