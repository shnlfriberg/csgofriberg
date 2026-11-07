import { Server, Socket } from 'socket.io';
import { config } from '../config';
import {
  authenticateCookie,
  getGuestFromCookie,
  hasAuthSessionCookie,
  userNameFromUsername,
} from '../middleware/auth';
import { consumeRateLimit } from '../middleware/rateLimit';
import { isGuestBanned, recordGuestSeen } from '../services/guestAccounts';
import { StoredIdentity } from '../services/roomStore';
import { acquireConnectionSlot, resolveSocketIp } from './connection';

async function currentIdentity(socket: Socket): Promise<string | null> {
  const me = socket.data.identity as StoredIdentity;
  if (me.userId) {
    const user = await authenticateCookie(socket.handshake.headers.cookie);
    return user?.id === me.userId ? null : 'AUTH_EXPIRED';
  }
  return getGuestFromCookie(socket.handshake.headers.cookie)?.key === me.key.slice(2) &&
    !(await isGuestBanned(me.key.slice(2))) ? null : 'USER_BANNED';
}

export function registerSocketMiddleware(io: Server): void {
  io.use(async (socket, next) => {
    try {
      const user = await authenticateCookie(socket.handshake.headers.cookie);
      const guest = getGuestFromCookie(socket.handshake.headers.cookie);
      if (
        !user &&
        (hasAuthSessionCookie(socket.handshake.headers.cookie) ||
          socket.handshake.auth?.authenticated === true)
      ) {
        next(new Error('AUTH_EXPIRED'));
        return;
      }
      let identity: StoredIdentity | null = null;
      if (user) {
        identity = {
          key: `u:${user.id}`,
          userId: user.id,
          name: userNameFromUsername(user.username),
          emailVerified: Boolean(user.email && user.emailVerified),
        };
      } else if (guest) {
        if (await isGuestBanned(guest.key)) {
          next(new Error('USER_BANNED'));
          return;
        }
        void recordGuestSeen(guest.key, guest.name).catch(() => undefined);
        identity = {
          key: `g:${guest.key}`,
          userId: null,
          name: guest.name,
        };
      }
      if (!identity) {
        next(new Error('IDENTITY_REQUIRED'));
        return;
      }
      const ip = resolveSocketIp(
        socket.handshake.address,
        socket.handshake.headers['x-forwarded-for'],
        socket.handshake.headers['x-real-ip'],
        config.trustProxy
      );
      if (!(await consumeRateLimit('socket:connect', `${ip}:${identity.key}`, 30, 60))) {
        next(new Error('RATE_LIMITED'));
        return;
      }
      if (!(await acquireConnectionSlot(ip, identity.key, socket.id))) {
        next(new Error('TOO_MANY_CONNECTIONS'));
        return;
      }
      socket.data.identity = identity;
      socket.data.ip = ip;
      socket.data.connectionSlot = true;
      socket.data.authExpiresAt = user?.sessionExpiresAt;
      next();
    } catch (err) {
      console.error('[socket:connect]', err);
      next(new Error(err instanceof Error && err.message === 'REDIS_UNAVAILABLE'
        ? 'REDIS_UNAVAILABLE'
        : 'INTERNAL_ERROR'));
    }
  });
  io.on('connection', (socket) => {
    let checking = 0;
    let count = 0;
    let until = Date.now() + 10_000;
    let ordered = Promise.resolve();
    socket.use((packet, next) => {
      if (until <= Date.now()) { count = 0; until = Date.now() + 10_000; }
      const ack = typeof packet.at(-1) === 'function' ? packet.at(-1) as (value: unknown) => void : null;
      const reject = (code: string) => ack?.({ ok: false, code });
      if (++count > 200 || checking >= 8) { reject('RATE_LIMITED'); return; }
      checking++;
      ordered = ordered.then(() => currentIdentity(socket)).then(code => {
        if (code) { reject(code); socket.disconnect(true); }
        else if (socket.connected) next();
      }).catch(() => reject('REDIS_UNAVAILABLE')).finally(() => { checking--; });
    });
    // Revoke passive subscriptions too; packets alone would leave an idle,
    // expired connection receiving private pushes indefinitely.
    let auditing = false;
    const timer = setInterval(() => {
      if (auditing) return;
      auditing = true;
      void currentIdentity(socket).then(code => { if (code) socket.disconnect(true); })
        .catch(() => socket.disconnect(true)).finally(() => { auditing = false; });
    }, 60_000);
    timer.unref();
    const deadline = Number(socket.data.authExpiresAt);
    const expiry = deadline > 0 ? setTimeout(() => socket.disconnect(true), Math.max(1, deadline - Date.now())) : null;
    expiry?.unref();
    socket.once('disconnect', () => { clearInterval(timer); if (expiry) clearTimeout(expiry); });
  });
}
