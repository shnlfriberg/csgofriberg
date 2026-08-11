import { Server } from 'socket.io';
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
      next();
    } catch (err) {
      console.error('[socket:connect]', err);
      next(new Error(err instanceof Error && err.message === 'REDIS_UNAVAILABLE'
        ? 'REDIS_UNAVAILABLE'
        : 'INTERNAL_ERROR'));
    }
  });
}
