import { observeMetric } from './metrics';
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

/**
 * Per-instance housekeeping that is not tied to room deadlines. Result
 * settlement is no longer polled here every 500 ms: finished rooms wake the
 * outbox through the room kernel, with a leased 30 s sweep for retries.
 */
export function startMaintenanceWorkers(): () => Promise<void> {
  const stops = [
    startWorker('asset-removals', 10000, flushAssetRemovals),
    startWorker('progress-archive', 60000, archiveExpiredProgress),
  ];
  return async () => { await Promise.all(stops.map(stop => stop())); };
}
