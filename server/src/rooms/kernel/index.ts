import type { Server, Socket } from 'socket.io';
import { logTransientError } from '../../services/transientLog';
import { startInstanceHeartbeat } from './instance';
import { startLeasedWorker, withLease } from './lease';
import { countKernel } from './metrics';
import { lookupOccupancy } from './occupancy';
import {
  attachPresence,
  detachSocketPresence,
  identityScope,
  reapDeadInstances,
  reattachLocalSockets,
  type PresenceTransition,
} from './presence';
import { getRoomAdapter, registerRoomAdapter, roomAdapters, setKernelIo, type GameRoomAdapter, type PresenceChange } from './registry';
import { startScheduler } from './scheduler';

export * from './registry';

const pendingTasks = new Set<Promise<unknown>>();
function track(task: Promise<unknown>, label: string): void {
  pendingTasks.add(task);
  void task.catch((err) => logTransientError(label, err)).finally(() => pendingTasks.delete(task));
}

/** Route a presence transition to the game that owns the identity's seat. */
export async function dispatchPresence(transition: PresenceTransition, cause: PresenceChange['cause']): Promise<void> {
  if (transition.scope.startsWith('id:')) {
    const ref = await lookupOccupancy(transition.identity);
    if (!ref) return;
    const adapter = getRoomAdapter(ref.game);
    if (adapter?.presence !== 'identity' || !adapter.onPresence) return;
    countKernel(`presence.${ref.game}.${transition.online ? 'online' : 'offline'}`);
    await adapter.onPresence({ game: ref.game, roomId: ref.roomId, identityKey: transition.identity, online: transition.online, cause });
    return;
  }
  if (transition.scope.startsWith('watch:')) {
    const [, game, ...rest] = transition.scope.split(':');
    const adapter = getRoomAdapter(game as GameRoomAdapter['game']);
    if (adapter?.presence !== 'watch' || !adapter.onPresence) return;
    countKernel(`presence.${game}.${transition.online ? 'online' : 'offline'}`);
    await adapter.onPresence({ game: adapter.game, roomId: rest.join(':'), identityKey: transition.identity, online: transition.online, cause });
  }
}

export function dispatchPresenceInBackground(transitions: PresenceTransition[], cause: PresenceChange['cause']): void {
  for (const transition of transitions) track(dispatchPresence(transition, cause), '[room-kernel:presence]');
}

/** Register a game with the kernel and adopt its pre-existing state once. */
export function activateRoomAdapter(adapter: GameRoomAdapter): () => void {
  const unregister = registerRoomAdapter(adapter);
  if (adapter.adopt) {
    track(withLease(`adopt:${adapter.game}`, 120_000, () => adapter.adopt!()), `[room-kernel:adopt:${adapter.game}]`);
  }
  return unregister;
}

function handleConnection(socket: Socket): void {
  const identity = socket.data.identity as { key?: string } | undefined;
  if (!identity?.key) return;
  const key = identity.key;
  track(attachPresence(socket.id, key, identityScope(key)).then((online) => {
    if (online) dispatchPresenceInBackground([{ scope: identityScope(key), identity: key, online: true }], 'connect');
  }), '[room-kernel:attach]');
  // Capability negotiation: the client lists the protocol versions it speaks and
  // the kernel answers with the version each registered game will use.
  socket.on('room-kernel:hello', (payload: unknown, ack?: (value: unknown) => void) => {
    const requested = (payload && typeof payload === 'object' ? (payload as { protocols?: unknown }).protocols : null) as Record<string, unknown> | null;
    const protocols: Record<string, number> = {};
    for (const adapter of roomAdapters()) {
      const wanted = Number(requested?.[adapter.game]);
      if (adapter.protocolVersion && Number.isInteger(wanted) && wanted >= 1) protocols[adapter.game] = Math.min(wanted, adapter.protocolVersion);
    }
    socket.data.roomProtocols = protocols;
    if (typeof ack === 'function') ack({ ok: true, protocols, serverNow: Date.now() });
  });
  socket.on('disconnect', () => {
    track(detachSocketPresence(socket.id).then((transitions) => dispatchPresenceInBackground(transitions, 'disconnect')), '[room-kernel:detach]');
  });
}

/**
 * Start the shared room kernel for this process: instance liveness, the
 * deadline scheduler, dead-instance reaping and identity presence. Classic,
 * 图寻 and 卡牌连接 rooms all run on top of it.
 */
export function startRoomKernel(io: Server): () => Promise<void> {
  setKernelIo(io);
  const stopHeartbeat = startInstanceHeartbeat(async () => {
    dispatchPresenceInBackground(await reattachLocalSockets(), 'reconcile');
  });
  const stopScheduler = startScheduler();
  const stopReaper = startLeasedWorker('reaper', 5_000, async () => {
    dispatchPresenceInBackground(await reapDeadInstances(), 'reap');
  });
  io.on('connection', handleConnection);
  return async () => {
    io.off('connection', handleConnection);
    await Promise.all([stopScheduler(), stopReaper()]);
    await Promise.allSettled([...pendingTasks]);
    await stopHeartbeat();
    setKernelIo(null);
  };
}
