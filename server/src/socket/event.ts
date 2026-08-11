import { Socket } from 'socket.io';
import { z } from 'zod';
import { isRedisTimeoutError } from '../redis';
import { StoredIdentity, getRoomForIdentity } from '../services/roomStore';
import { logTransientWarning } from '../services/transientLog';
import { publicRoom } from './roomView';

export type SocketAck = (value: any) => void;

export function registerSocketEvent<T = any>(
  socket: Socket,
  event: string,
  handler: (payload: T, ack?: SocketAck) => Promise<void>,
  schema?: z.ZodTypeAny
): void {
  socket.on(event, (payload: any, ack?: SocketAck) => {
    const parsed = schema?.safeParse(payload);
    if (parsed && !parsed.success) return ack?.({ code: 'VALIDATION_FAILED' });
    const validatedPayload = (parsed ? parsed.data : payload) as T;
    const pendingEvents = Number(socket.data.pendingEvents ?? 0);
    if (pendingEvents >= 8) return ack?.({ code: 'RATE_LIMITED' });
    socket.data.pendingEvents = pendingEvents + 1;
    void handler(validatedPayload, ack).catch(async (err) => {
      if (err instanceof Error && err.message === 'ROOM_IDENTITY_CONFLICT') {
        const identity = socket.data.identity as StoredIdentity | undefined;
        const room = identity ? await getRoomForIdentity(identity.key).catch(() => null) : null;
        ack?.({
          code: 'ALREADY_IN_ROOM',
          room: room && identity ? publicRoom(room, identity.key) : undefined,
          role: room && identity
            ? room.players.some((player) => player.key === identity.key) ? 'player' : 'spectator'
            : undefined,
        });
        return;
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
      ack?.({ code });
    }).finally(() => {
      socket.data.pendingEvents = Math.max(0, Number(socket.data.pendingEvents ?? 1) - 1);
    });
  });
}
