import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/knex';
import { redis, redisKey } from '../redis';
import { assetDirectory } from './assets';

const tables = ['location_maps', 'location_questions', 'location_capture_drafts', 'location_versions',
  'location_daily', 'location_progress', 'location_results', 'location_submissions', 'location_replay_snapshots', 'location_result_outbox'];

export async function referencedAssetUrls(): Promise<Set<string>> {
  const urls = new Set<string>();
  const scan = (payload: string) => {
    for (const match of payload.matchAll(/\/location-assets\/[a-f0-9-]{36}(?:-thumb)?\.webp/g)) urls.add(match[0]);
  };
  for (const table of tables) {
    // Stream rows in bounded pages; historical snapshots count as live references.
    for (let offset = 0; ; offset += 200) {
      const rows = await db(table).select('payload').limit(200).offset(offset);
      rows.forEach(row => scan(row.payload));
      if (rows.length < 200) break;
    }
  }
  const client = redis();
  if (client) for await (const keys of client.scanIterator({ MATCH: redisKey('location:*'), COUNT: 100 })) {
    for (const key of keys) if (await client.type(key) === 'string') {
      const raw = await client.get(key); if (raw) scan(raw);
    }
  }
  return urls;
}

// Inspection only. Never automatically delete old uploads or historical assets.
export async function assetInventory() {
  const referenced = await referencedAssetUrls();
  const files = await fs.readdir(assetDirectory).catch(() => [] as string[]);
  const items = [];
  for (const file of files) {
    if (!/^[a-f0-9-]{36}(?:-thumb)?\.webp$/.test(file)) continue;
    const url = `/location-assets/${file}`;
    const stat = await fs.stat(path.join(assetDirectory, file));
    items.push({ url, bytes: stat.size, modifiedAt: stat.mtimeMs,
      state: referenced.has(url) ? 'referenced' : stat.mtimeMs > Date.now() - 7 * 86400000 ? 'staged' : 'quarantine-candidate' });
  }
  return { items, policy: 'report-only; preserve historical and active-game references; seven-day grace' };
}
