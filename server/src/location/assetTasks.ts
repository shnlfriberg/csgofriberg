import type { Knex } from 'knex';
import fs from 'node:fs/promises';
import { db } from '../db/knex';
import { assetPath } from './assets';
import { withKeyLock } from './lock';
import { countMetric } from './metrics';
import { referencedAssetUrls } from './assetInventory';

export async function queueAssetRemoval(trx: Knex.Transaction, urls: string[]) {
  for (const url of urls) await trx('location_asset_tasks').insert({
    url, attempts: 0, due_at: Date.now(), last_error: null,
  }).onConflict('url').ignore();
}

// A committed deletion request survives a filesystem outage or process restart.
export async function flushAssetRemovals(limit = 20): Promise<void> {
  await withKeyLock('location:asset-tasks', async () => {
    const tasks = await db('location_asset_tasks').where('due_at', '<=', Date.now()).orderBy('due_at').limit(limit);
    if (!tasks.length) return;
    await withKeyLock('location:catalog', async () => {
    const referenced = await referencedAssetUrls();
    for (const task of tasks) {
      try {
        if (referenced.has(task.url)) {
          await db('location_asset_tasks').where({ url: task.url }).delete();
          countMetric('assets.retainedReferences');
          continue;
        }
        await fs.rm(assetPath(task.url), { force: true });
        await db('location_asset_tasks').where({ url: task.url }).delete();
        countMetric('assets.removed');
      } catch (error) {
        await db('location_asset_tasks').where({ url: task.url }).update({
          attempts: Number(task.attempts) + 1, due_at: Date.now() + Math.min(3600000, 5000 * 2 ** Math.min(10, Number(task.attempts))),
          last_error: error instanceof Error ? error.message.slice(0, 500) : 'IO_ERROR',
        });
        countMetric('assets.removalRetries');
      }
    }
    });
  });
}
