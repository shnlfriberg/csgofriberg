import type { Server, Socket } from 'socket.io';
import type { RoomState, RoomView } from './types';
import { roomView } from './roomView';
import { countMetric } from './metrics';

const previous = new WeakMap<Socket, RoomView>();
export async function broadcast(io: Server, room: RoomState): Promise<void> {
  if (!room.players.length) return;
  const common = roomView(room, room.players[0].identity.key);
  for (const p of room.players) {
    const view = roomView(room, p.identity.key, Date.now(), common);
    const socket = io.sockets.sockets.get(p.socketId);
    const base = socket && previous.get(socket);
    if (socket?.data.locationDelta && base?.id === view.id && base.me === view.me && base.revision < view.revision) {
      const changes: Partial<RoomView> = {};
      for (const key of Object.keys(view) as Array<keyof RoomView>) {
        if (JSON.stringify(view[key]) !== JSON.stringify(base[key])) (changes as any)[key] = view[key];
      }
      socket.emit('location:room:patch', { id: view.id, baseRevision: base.revision, revision: view.revision, changes });
      countMetric('rooms.deltaBytes', Buffer.byteLength(JSON.stringify(changes)));
    } else {
      io.to(p.socketId).emit('location:room', view);
      countMetric('rooms.fullBytes', Buffer.byteLength(JSON.stringify(view)));
    }
    if (socket) previous.set(socket, view);
  }
}
