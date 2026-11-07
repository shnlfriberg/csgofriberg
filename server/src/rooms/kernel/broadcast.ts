import type { Server } from 'socket.io';
import { countEmit } from './metrics';

/** Every socket of one identity (all tabs); used by every room game. */
export function identityChannel(key: string): string {
  return `identity:${key}`;
}

/** Emit to a channel and count it (sampled byte metrics). */
export function emitTo(io: Server, channel: string | string[], event: string, payload: unknown, metric = event): void {
  io.to(channel).emit(event, payload);
  countEmit(`emit.${metric}`, payload);
}
