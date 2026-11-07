import { logTransientError } from '../../services/transientLog';
import { countKernel, observeKernel } from './metrics';
import { ScheduleSource } from './schedules';

export interface ScheduleConsumer {
  /** Stable name, used for logging and metrics. */
  name: string;
  source: ScheduleSource;
  batch: number;
  concurrency: number;
  /** Items in one group are processed sequentially (normally: one room). */
  groupKey(item: string): string;
  handleGroup(items: string[]): Promise<void>;
}

const consumers = new Map<string, ScheduleConsumer>();

export function registerScheduleConsumer(consumer: ScheduleConsumer): () => void {
  consumers.set(consumer.name, consumer);
  return () => {
    if (consumers.get(consumer.name) === consumer) consumers.delete(consumer.name);
  };
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function processGroupsWithLimit<T>(
  groups: T[],
  limit: number,
  handler: (group: T) => Promise<void>
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

async function runConsumer(consumer: ScheduleConsumer): Promise<void> {
  const now = Date.now();
  const items = await consumer.source.claimDue(consumer.batch, now);
  if (!items.length) return;
  countKernel(`schedule.${consumer.name}.claimed`, items.length);
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const key = consumer.groupKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  await processGroupsWithLimit([...groups.values()], consumer.concurrency, async (group) => {
    try {
      await consumer.handleGroup(group);
    } catch (err) {
      logTransientError(`[schedule:${consumer.name}]`, err);
    }
  });
  observeKernel(`schedule.${consumer.name}.batchMs`, Date.now() - now);
}

/** One 1 s worker drives every registered deadline source on this instance. */
export function startScheduler(intervalMs = 1000): () => Promise<void> {
  const running = new Map<string, Promise<void>>();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    for (const consumer of consumers.values()) {
      if (running.has(consumer.name)) continue;
      const task = runConsumer(consumer)
        .catch((err) => logTransientError(`[schedule:${consumer.name}]`, err))
        .finally(() => running.delete(consumer.name));
      running.set(consumer.name, task);
    }
  }, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await Promise.allSettled([...running.values()]);
  };
}
