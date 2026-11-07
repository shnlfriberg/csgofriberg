import type { Socket } from 'socket.io';
import type { z } from 'zod';
import { countKernel } from './metrics';

export type SocketAck = (value: any) => void;

export interface KernelEventContext {
  socket: Socket;
  event: string;
}

export interface KernelEventSpec<T> {
  event: string;
  schema?: z.ZodTypeAny;
  /**
   * `classic`: the handler acknowledges by itself with a raw payload.
   * `envelope`: the kernel acknowledges `{ ok: true, data }` with the handler result.
   */
  ack: 'classic' | 'envelope';
  /**
   * `validate-then-pending`: reject invalid payloads before counting them as pending
   * (classic rooms). `pending-then-validate`: count first, then run `before`
   * (rate limits, re-authentication) and validate (图寻 rooms).
   */
  order: 'validate-then-pending' | 'pending-then-validate';
  /** socket.data field counting in-flight events for this game family. */
  pendingField: string;
  maxPending?: number;
  /** Runs before validation in `pending-then-validate` order; throw to reject. */
  before?(ctx: KernelEventContext): Promise<void>;
  /** Map a thrown error to the acknowledgement payload (or undefined to stay silent). */
  mapError(err: unknown, ctx: KernelEventContext): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  handler(payload: T, ack: SocketAck | undefined, ctx: KernelEventContext): Promise<unknown>;
  /** Optional tracking for graceful shutdown. */
  track?(task: Promise<unknown>): void;
}

/**
 * One event wrapper for every room game: validation, a per-socket pending cap,
 * consistent error mapping and acknowledgement style. The two ack styles keep
 * each game's historical wire contract unchanged.
 */
export function registerKernelEvent<T = any>(socket: Socket, spec: KernelEventSpec<T>): void {
  const maxPending = spec.maxPending ?? 8;
  const ctx: KernelEventContext = { socket, event: spec.event };
  socket.on(spec.event, (raw: any, maybeAck?: SocketAck) => {
    const ack = typeof maybeAck === 'function' ? maybeAck : undefined;
    let payload: T = raw;
    if (spec.order === 'validate-then-pending' && spec.schema) {
      const parsed = spec.schema.safeParse(raw);
      if (!parsed.success) return ack?.({ code: 'VALIDATION_FAILED' });
      payload = parsed.data as T;
    }
    const pending = Number(socket.data[spec.pendingField] ?? 0);
    if (pending >= maxPending) {
      countKernel('events.rejectedPending');
      return ack?.(spec.ack === 'envelope' ? { ok: false, code: 'RATE_LIMITED' } : { code: 'RATE_LIMITED' });
    }
    socket.data[spec.pendingField] = pending + 1;
    const task = (async () => {
      if (spec.order === 'pending-then-validate') {
        await spec.before?.(ctx);
        if (spec.schema) {
          const parsed = spec.schema.safeParse(raw);
          if (!parsed.success) throw Object.assign(new Error('VALIDATION_FAILED'), { code: 'VALIDATION_FAILED', status: 400 });
          payload = parsed.data as T;
        }
      }
      const result = await spec.handler(payload, ack, ctx);
      if (spec.ack === 'envelope') ack?.({ ok: true, data: result });
    })()
      .catch(async (err) => {
        const mapped = await Promise.resolve(spec.mapError(err, ctx)).catch(() => (
          spec.ack === 'envelope' ? { ok: false, code: 'INTERNAL_ERROR' } : { code: 'INTERNAL_ERROR' }
        ));
        if (mapped) ack?.(mapped);
      })
      .finally(() => {
        socket.data[spec.pendingField] = Math.max(0, Number(socket.data[spec.pendingField] ?? 1) - 1);
      });
    spec.track?.(task);
  });
}
