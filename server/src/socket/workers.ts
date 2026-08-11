import { Server } from 'socket.io';
import { getPresenceStats, PresenceStats } from '../services/presence';
import { claimDueSchedules } from '../services/roomStore';
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

async function processGroupsWithLimit(
  groups: string[][],
  limit: number,
  handler: (group: string[]) => Promise<void>
): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, groups.length) }, async () => {
    while (cursor < groups.length) {
      const group = groups[cursor++];
      await handler(group);
      await yieldEventLoop();
    }
  }));
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
      };
      if (lastPresence && JSON.stringify(lastPresence) === JSON.stringify(comparable)) return;
      lastPresence = comparable;
      for (const socketId of presenceSubscribers) io.to(socketId).emit('presence:stats', stats);
    }).catch((err) => logTransientError('[presence]', err));
  }, 2000);
  presenceWorker.unref?.();
  const presenceCleanupWorker = setInterval(() => {
    void getPresenceStats().catch((err) => logTransientError('[presence:cleanup]', err));
  }, 60_000);
  presenceCleanupWorker.unref?.();
  let scheduleRequest: Promise<void> | null = null;
  const scheduleWorker = setInterval(() => {
    if (scheduleRequest) return;
    scheduleRequest = claimDueSchedules(40)
      .then(async (items) => {
        const byRoom = new Map<string, string[]>();
        for (const item of items) {
          const roomId = item.split('|')[1] ?? '';
          const group = byRoom.get(roomId) ?? [];
          group.push(item);
          byRoom.set(roomId, group);
        }
        await processGroupsWithLimit([...byRoom.values()], 8, async (group) => {
          await handleScheduledGroup(io, group);
        });
      })
      .then(() => undefined)
      .catch((err) => logTransientError('[schedule]', err))
      .finally(() => {
        scheduleRequest = null;
      });
  }, 1000);
  scheduleWorker.unref?.();
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
      clearInterval(scheduleWorker);
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
