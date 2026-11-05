import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { db } from '../db/knex';
import { withKeyLock } from './lock';
import { countMetric } from './metrics';
const compress = promisify(gzip);
const decompress = promisify(gunzip);

// Archive only new compact-format progress. Existing authoring, scores, daily
// assignments and legacy progress are never rewritten or removed by this worker.
export async function archiveExpiredProgress(now = Date.now(), limit = 50) {
  return withKeyLock('location:progress-archive', async () => {
    const rows = await db('location_progress').where({ storage_version: 2 }).where('expires_at', '<', now - 7 * 86400000).orderBy('expires_at').limit(limit);
    let archived = 0;
    for (const row of rows) {
      if (JSON.parse(row.payload).storageVersion !== 2) continue;
      const key = { identity_key: row.identity_key, date: row.date, difficulty: row.difficulty };
      // Compression does not occupy a DB connection or keep a write transaction open.
      const payload = (await compress(Buffer.from(row.payload))).toString('base64');
      archived += await db.transaction<number>(async trx => {
        const current = await trx('location_progress').where(key).forUpdate().first();
        if (!current || current.payload !== row.payload) return 0;
        await trx('location_progress_archive').insert({ ...key, game_id: row.game_id, payload })
          .onConflict(['identity_key', 'date', 'difficulty']).ignore();
        const saved = await trx('location_progress_archive').where(key).first();
        if (saved.game_id !== row.game_id || saved.payload !== payload) return 0;
        return Number(await trx('location_progress').where(key).where({ payload: row.payload }).delete()) || 0;
      });
    }
    countMetric('progress.archived', archived);
    return archived;
  });
}
export async function archivedProgress(gameId: string, identity: string): Promise<string | null> {
  const row = await db('location_progress_archive').where({ game_id: gameId, identity_key: identity }).first('payload');
  return row ? (await decompress(Buffer.from(row.payload, 'base64'), { maxOutputLength: 4 * 1024 * 1024 })).toString('utf8') : null;
}
