import type { IncomingMessage } from 'node:http';
import type { ServerOptions } from 'socket.io';
import { config } from '../config';
import { getGuestFromCookie, hasAuthSessionCookie } from '../middleware/auth';
import { resolveSocketIp } from './connection';

/** Shared by application and drills; Redis DB selection does not scope Pub/Sub. */
export function socketAdapterOptions() {
  return { key: `${config.redisPrefix}socket.io`, publishOnSpecificResponseChannel: true };
}

export function socketServerOptions(): Partial<ServerOptions> {
  const ips = new Map<string, { active: number; attempts: number; until: number }>();
  let active = 0;
  return {
    cors: { origin: config.corsOrigins, credentials: true },
    transports: ['websocket'],
    perMessageDeflate: false,
    maxHttpBufferSize: 64 * 1024,
    connectTimeout: 5_000,
    allowRequest(req: IncomingMessage, done) {
      const reject = () => done('CONNECTION_REJECTED', false);
      const origin = req.headers.origin;
      if (origin && !config.corsOrigins.includes(origin)) return reject();
      const ip = resolveSocketIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], req.headers['x-real-ip'], config.trustProxy);
      const now = Date.now();
      if (ips.size >= 10_000) for (const [key, item] of ips) if (!item.active && item.until <= now) ips.delete(key);
      let entry = ips.get(ip);
      if (!entry && ips.size >= 10_000) return reject();
      if (!entry) { entry = { active: 0, attempts: 0, until: now + 60_000 }; ips.set(ip, entry); }
      if (entry.until <= now) { entry.attempts = 0; entry.until = now + 60_000; }
      if (++entry.attempts > 60 || entry.active >= 20 || active >= 2000) return reject();
      // Rate-limit before signature work. Preserve namespace AUTH_EXPIRED for
      // expired authenticated cookies instead of breaking client refresh.
      if (!hasAuthSessionCookie(req.headers.cookie) && !getGuestFromCookie(req.headers.cookie)) return reject();
      // Reserve synchronously, BEFORE Engine.IO can allocate a session. Raw TCP
      // close releases even clients that never send a namespace CONNECT packet.
      entry.active++; active++;
      req.socket.once('close', () => { entry!.active--; active--; });
      done(null, true);
    },
  };
}
