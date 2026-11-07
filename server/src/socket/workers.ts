import { Server } from 'socket.io';
import { cleanupPresence, getPresenceStats, PresenceStats } from '../services/presence';
import { classicScheduleSource } from '../services/roomStore';
import { registerScheduleConsumer } from '../rooms/kernel/scheduler';
import { logTransientError } from '../services/transientLog';
import { refreshConnectionSlots } from './connection';
import { handleScheduledGroup } from './scheduleProcessor';

export type HeartbeatEntry = {
  ip: string;
  identity: string;
  socketId: string;
};

export type SocketWorkers = {
  presenceSubscribers: Set<string>;
  heartbeatEntries: Map<string, HeartbeatEntry>;
  trackBackground: <T>(task: Promise<T>, label: string) => void;
  stop: () => Promise<void>;
};

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function createSocketWorkers(io: Server): SocketWorkers {
  const backgroundTasks = new Set<Promise<unknown>>();
  const trackBackground = <T>(task: Promise<T>, label: string): void => {
    backgroundTasks.add(task);
    void task.catch((err) => logTransientError(label, err)).finally(() => backgroundTasks.delete(task));
  };
  const presenceSubscribers = new Set<string>();
  const heartbeatEntries = new Map<string, HeartbeatEntry>();
  let heartbeatRequest: Promise<void> | null = null;
  let lastPresence: Omit<PresenceStats, 'updatedAt'> | null = null;
  let presenceRequest: Promise<PresenceStats> | null = null;
  const presenceWorker = setInterval(() => {
    if (!presenceSubscribers.size) return;
    presenceRequest ??= getPresenceStats().finally(() => {
      presenceRequest = null;
    });
    void presenceRequest.then((stats) => {
      const comparable = {
        onlineUsers: stats.onlineUsers,
        multiplayerRooms: stats.multiplayerRooms,
        singleGames: stats.singleGames,
        modes: stats.modes,
      };
      if (lastPresence && JSON.stringify(lastPresence) === JSON.stringify(comparable)) return;
      lastPresence = comparable;
      for (const socketId of presenceSubscribers) io.to(socketId).emit('presence:stats', stats);
    }).catch((err) => logTransientError('[presence]', err));
  }, 2000);
  presenceWorker.unref?.();
  const presenceCleanupWorker = setInterval(() => {
    void cleanupPresence().catch((err) => logTransientError('[presence:cleanup]', err));
  }, 60_000);
  presenceCleanupWorker.unref?.();
  // Classic deadlines run on the shared room kernel scheduler (same claim
  // script, batch size and per-room concurrency as before).
  const unregisterSchedules = registerScheduleConsumer({
    name: 'classic',
    source: classicScheduleSource(),
    batch: 40,
    concurrency: 8,
    groupKey: (item) => item.split('|')[1] ?? '',
    handleGroup: (group) => handleScheduledGroup(io, group),
  });
  const heartbeatWorker = setInterval(() => {
    if (heartbeatRequest) return;
    const entries = [...heartbeatEntries.values()];
    heartbeatRequest = (async () => {
      for (let index = 0; index < entries.length; index += 100) {
        await refreshConnectionSlots(entries.slice(index, index + 100));
        await yieldEventLoop();
      }
    })().catch((err) => logTransientError('[presence:heartbeat]', err)).finally(() => {
      heartbeatRequest = null;
    });
  }, 60_000);
  heartbeatWorker.unref?.();

  return {
    presenceSubscribers,
    heartbeatEntries,
    trackBackground,
    stop: async () => {
      unregisterSchedules();
      clearInterval(heartbeatWorker);
      clearInterval(presenceWorker);
      clearInterval(presenceCleanupWorker);
      presenceSubscribers.clear();
      await Promise.allSettled([
        heartbeatRequest ?? Promise.resolve(),
        ...backgroundTasks,
      ]);
    },
  };
}
