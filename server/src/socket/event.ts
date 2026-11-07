import { Socket } from 'socket.io';
import { z } from 'zod';
import { isRedisTimeoutError } from '../redis';
import { StoredIdentity, getRoomForIdentity } from '../services/roomStore';
import { logTransientWarning } from '../services/transientLog';
import { registerKernelEvent, type SocketAck } from '../rooms/kernel/events';
import { isOccupiedError, lookupOccupancy } from '../rooms/kernel/occupancy';
import { publicRoom } from './roomView';

export type { SocketAck } from '../rooms/kernel/events';

/** Classic room events: raw acknowledgements, validated before the pending cap. */
export function registerSocketEvent<T = any>(
  socket: Socket,
  event: string,
  handler: (payload: T, ack?: SocketAck) => Promise<void>,
  schema?: z.ZodTypeAny
): void {
  registerKernelEvent<T>(socket, {
    event,
    schema,
    ack: 'classic',
    order: 'validate-then-pending',
    pendingField: 'pendingEvents',
    handler: (payload, ack) => handler(payload, ack),
    mapError: async (err) => {
      if (isOccupiedError(err)) return { code: 'ALREADY_IN_ROOM', occupied: err.occupied };
      if (err instanceof Error && err.message === 'ROOM_IDENTITY_CONFLICT') {
        const identity = socket.data.identity as StoredIdentity | undefined;
        const room = identity ? await getRoomForIdentity(identity.key).catch(() => null) : null;
        const foreign = !room && identity ? await lookupOccupancy(identity.key).catch(() => null) : null;
        return {
          code: 'ALREADY_IN_ROOM',
          room: room && identity ? publicRoom(room, identity.key) : undefined,
          role: room && identity
            ? room.players.some((player) => player.key === identity.key) ? 'player' : 'spectator'
            : undefined,
          ...(foreign && foreign.game !== 'classic' ? { occupied: foreign } : {}),
        };
      }
      const code = isRedisTimeoutError(err)
        ? 'REDIS_UNAVAILABLE'
        : err instanceof Error && [
          'ROOM_BUSY',
          'REDIS_UNAVAILABLE',
          'STALE_ROOM_WRITE',
        ].includes(err.message)
          ? err.message === 'STALE_ROOM_WRITE' ? 'ROOM_BUSY' : err.message
          : 'INTERNAL_ERROR';
      if (code === 'ROOM_BUSY' || code === 'REDIS_UNAVAILABLE') {
        logTransientWarning(`[socket:${event}]`, code);
      } else {
        console.error(`[socket:${event}]`, err);
      }
      return { code };
    },
  });
}
