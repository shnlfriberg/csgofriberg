import { locationMetrics, observeMetric } from './metrics';
import { db } from '../db/knex';
import { flushDueResults } from './resultOutbox';
import { flushAssetRemovals } from './assetTasks';
import { archiveExpiredProgress } from './progressArchive';

/** Independent, non-overlapping workers; shutdown drains the actual running jobs. */
export function startWorker(name: string, interval: number, action: () => Promise<unknown>): () => Promise<void> {
  let running: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    const start = performance.now();
    running = Promise.resolve().then(action).catch(error => {
      if (!(error instanceof Error && error.message === 'RESOURCE_BUSY')) console.error(`[location:${name}]`, error);
    }).finally(() => { observeMetric(`worker.${name}`, performance.now() - start); running = undefined; });
  }, interval);
  timer.unref();
  return async () => { clearInterval(timer); await running; };
}

export function startMaintenanceWorkers(): () => Promise<void> {
  const stops = [
    startWorker('outbox', 500, flushDueResults),
    startWorker('asset-removals', 10000, flushAssetRemovals),
    startWorker('progress-archive', 60000, archiveExpiredProgress),
    startWorker('metrics', 60000, async () => {
      const outbox = await db('location_result_outbox').count({ pending: '*' }).min({ oldestDueAt: 'due_at' }).first();
      console.log(JSON.stringify({ event: 'location.metrics', ...locationMetrics(), outbox }));
    }),
  ];
  return async () => { await Promise.all(stops.map(stop => stop())); };
}
