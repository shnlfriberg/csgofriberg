import { config } from '../../config';
import {
  cancelQueue,
  getRoomForIdentity,
  withRoomLock,
} from '../../services/roomStore';
import { logTransientError } from '../../services/transientLog';
import { releaseConnectionSlot } from '../connection';
import { cancelLocalMatchmaking } from '../matchmakingQueue';
import { connectedSpectatorCount, emitRoomPatch } from '../roomView';
import { setLocalTimer } from '../timers';
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
    const result = await withRoomLock(room.id, (locked) => {
      const spectator = locked.spectators.find((candidate) => candidate.key === me.key);
      if (spectator?.socketId === socket.id) {
        spectator.connected = false;
        spectator.disconnectDeadline = Date.now() + config.disconnectForfeitMs;
        return { spectator: true, room: locked };
      }
      const player = locked.players.find((candidate) => candidate.key === me.key);
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
        lifecycle.emitRematchUpdate(io, result.room, 'cancelled', me.key, {
          key: me.key,
          connected: false,
        });
      } else {
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
