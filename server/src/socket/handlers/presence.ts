import { authenticateCookie } from '../../middleware/auth';
import { getPresenceStats } from '../../services/presence';
import { registerSocketEvent, SocketAck } from '../event';
import { SocketEventContext } from './context';

type PresenceEventContext = SocketEventContext & {
  presenceSubscribers: Set<string>;
};

export async function handlePresenceSubscribe(
  context: PresenceEventContext,
  _payload: unknown,
  ack?: SocketAck
): Promise<void> {
  const { socket, presenceSubscribers } = context;
  const user = await authenticateCookie(socket.handshake.headers.cookie);
  if (!user || user.role !== 'admin') {
    ack?.({ code: 'FORBIDDEN' });
    return;
  }
  presenceSubscribers.add(socket.id);
  const stats = await getPresenceStats();
  socket.emit('presence:stats', stats);
  ack?.({ ok: true, stats });
}

export async function handlePresenceUnsubscribe(
  context: PresenceEventContext,
  _payload: unknown,
  ack?: SocketAck
): Promise<void> {
  context.presenceSubscribers.delete(context.socket.id);
  ack?.({ ok: true });
}

export function registerPresenceEvents(context: PresenceEventContext): void {
  registerSocketEvent(
    context.socket,
    'presence:subscribe',
    (payload, ack) => handlePresenceSubscribe(context, payload, ack)
  );
  registerSocketEvent(
    context.socket,
    'presence:unsubscribe',
    (payload, ack) => handlePresenceUnsubscribe(context, payload, ack)
  );
}
