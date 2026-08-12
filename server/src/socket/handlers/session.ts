import { Server, Socket } from 'socket.io';
import { db } from '../../db/knex';
import { authenticateCookie } from '../../middleware/auth';
import {
  StoredIdentity,
  clearIdentityRoom,
  getRoomForIdentity,
  withRoomLock,
} from '../../services/roomStore';
import { getResourceVersionNotice } from '../../services/resourceVersion';
import { logTransientError } from '../../services/transientLog';
import {
  connectedSpectatorCount,
  emitRoomPatch,
  identityChannel,
  joinRoomChannels,
} from '../roomView';
import { SocketLifecycle } from './context';
import { registerDisconnectHandler } from './disconnect';
import { registerGameEvents } from './game';
import { registerMatchmakingEvents } from './matchmaking';
import { registerPresenceEvents } from './presence';
import { registerRematchEvents } from './rematch';
import { registerRoomEvents } from './room';

type SocketSessionContext = {
  io: Server;
  presenceSubscribers: Set<string>;
  heartbeatEntries: Map<string, { ip: string; identity: string; socketId: string }>;
  lifecycle: SocketLifecycle;
  trackBackground: <T>(task: Promise<T>, label: string) => void;
};

export function handleSocketConnection(
  context: SocketSessionContext,
  socket: Socket
): void {
  const {
    io,
    presenceSubscribers,
    heartbeatEntries,
    lifecycle,
    trackBackground,
  } = context;
  const me = socket.data.identity as StoredIdentity;
  const refreshIdentityEmailState = async () => {
    if (!me.userId) return;
    const current = await authenticateCookie(socket.handshake.headers.cookie);
    if (current?.id !== me.userId) {
      me.emailVerified = false;
      return;
    }
    // Match eligibility must reflect a verification completed in another request
    // even when invalidating the shared auth cache has transiently failed.
    const user = await db('users')
      .where({ id: me.userId })
      .first('email', 'email_verified_at');
    me.emailVerified = Boolean(user?.email && user.email_verified_at);
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
    if (existing.status !== 'finished' || existing.rematchAllowed || existing.matchmaking) {
      const restored = await withRoomLock(existing.id, (room) => {
        const player = room.players.find((candidate) => candidate.key === me.key);
        const spectator = room.spectators.find((candidate) => candidate.key === me.key);
        if (player) {
          player.socketId = socket.id;
          player.connected = true;
          player.disconnectDeadline = null;
          if (room.status === 'finished') lifecycle.syncRematchPreferences(room);
          return { role: 'player' as const, room, rematchUpdated: room.status === 'finished' };
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
      if (restored.role === 'player' && restored.rematchUpdated) {
        lifecycle.emitRematchUpdate(io, refreshed, 'updated', me.key, {
          key: me.key,
          connected: true,
        });
      } else {
        emitRoomPatch(io, refreshed, restored.role === 'player'
          ? { players: { updated: [{ key: me.key, connected: true }] } }
          : { spectatorCount: connectedSpectatorCount(refreshed) });
      }
    }
    joinRoomChannels(socket, refreshed, me.key);
    socket.data.roomId = refreshed.id;
    if (
      refreshed.players.filter((player) => !player.eliminated).length >= 2 &&
      refreshed.players.filter((player) => !player.eliminated).every((player) => player.connected) &&
      (
        refreshed.status === 'starting' ||
        (refreshed.status === 'round_over' && (refreshed.nextRoundAt ?? 0) <= Date.now())
      )
    ) {
      await lifecycle.startRound(io, refreshed.id);
    }
  }).catch((err) => console.error('[socket:reconnect]', err));

  const eventContext = {
    io,
    socket,
    me,
    restorePromise,
    refreshIdentityEmailState,
    lifecycle,
  };
  registerRoomEvents(eventContext);
  registerPresenceEvents({ ...eventContext, presenceSubscribers });
  registerRematchEvents(eventContext);
  registerGameEvents(eventContext);
  registerMatchmakingEvents(eventContext);
  registerDisconnectHandler({
    io,
    socket,
    me,
    presenceSubscribers,
    heartbeatEntries,
    lifecycle,
    trackBackground,
  });
}
