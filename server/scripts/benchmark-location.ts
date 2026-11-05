import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../src/db/knex';
import { ensureSchema } from '../src/db/schema';
import { config } from '../src/config';
import { queryQuestions, questionQuery } from '../src/location/admin/questionQuery';
import { getOverview } from '../src/location/admin/overview';
import { catalogSnapshot } from '../src/location/store';
import { encodeReplay } from '../src/location/replayStorage';
import { score } from '../src/location/rules';
import type { MapDefinition, Question, ReplayRecord } from '../src/location/types';

async function measure(action: () => Promise<unknown>, runs = 20) {
  const samples = [];
  for (let i = 0; i < runs; i++) { const start = performance.now(); await action(); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  return { medianMs: Number(samples[Math.floor(runs / 2)].toFixed(2)), p95Ms: Number(samples[Math.ceil(runs * .95) - 1].toFixed(2)) };
}
async function main() {
  if (config.dbClient !== 'sqlite' || !path.resolve(config.dbUrl).replaceAll('\\', '/').includes('/.local-data/verification/'))
    throw new Error('Benchmark requires an isolated SQLite file under .local-data/verification');
  await ensureSchema();
  const map: MapDefinition = { id: 'benchmark', name: 'Benchmark', version: 1, enabled: true, order: 999, width: 1024, height: 1024,
    bounds: { u: 0, v: 0, width: 1, height: 1 }, floors: [{ id: 'main', name: 'Main', radarUrl: '/radar.webp' }],
    calibration: { posX: 0, posY: 1024, scale: 1, points: Array.from({ length: 50 }, (_, i) => ({ x: i, y: i, u: i / 100, v: i / 100, floorId: 'main' })) } };
  await db('location_maps').insert({ id: map.id, payload: JSON.stringify(map) });
  const template: Question = { id: '', version: 1, mapVersion: 1, mapId: map.id, floorId: 'main', u: .5, v: .5,
    capturePointId: '', tier: 'easy', status: 'published', imageUrl: '/test.webp', thumbnailUrl: '/thumb.webp', imageHash: '', capturedAt: '', build: '', source: 'benchmark' };
  const report: Record<string, unknown> = { node: process.version, database: config.dbUrl, note: 'Synthetic isolated metadata; no network or real assets; 20 sequential samples per query.' };
  for (const size of [500, 5000]) {
    const previous = size === 500 ? 0 : 500;
    for (let i = previous; i < size; i += 100) {
      const rows = Array.from({ length: Math.min(100, size - i) }, (_, k) => {
        const id = `bench_${String(i + k).padStart(5, '0')}`;
        return { id, image_hash: id, payload: JSON.stringify({ ...template, id, capturePointId: id, imageHash: id,
          u: ((i + k) % 100) / 100, v: Math.floor((i + k) / 100) / 100, tier: ['easy', 'medium', 'hard'][(i + k) % 3] }) };
      });
      await db('location_questions').insert(rows);
    }
    const filter = questionQuery.parse({ mapId: map.id, floorId: 'main', minU: .2, maxU: .6, minV: 0, maxV: .5 });
    const full = await getOverview(); const compact = await getOverview(true);
    report[String(size)] = {
      fullCatalogScan: await measure(async () => (await db('location_questions').select('payload')).map(row => JSON.parse(row.payload))),
      indexedAreaPage: await measure(() => queryQuestions(filter)),
      warmCatalog: await measure(() => catalogSnapshot()),
      fullOverview: await measure(() => getOverview(), 5), compactOverview: await measure(() => getOverview(true), 5),
      fullOverviewBytes: Buffer.byteLength(JSON.stringify(full)), compactOverviewBytes: Buffer.byteLength(JSON.stringify(compact)),
    };
  }
  const rounds = Array.from({ length: 5 }, (_, i) => score({ question: { ...template, id: `round-${i}` }, map }, null, [map], i + 1));
  const record: ReplayRecord = { gameId: 'benchmark', owner: { key: 'g:benchmark', userId: null, name: 'Benchmark' }, mode: 'multiplayer', difficulty: 'easy', date: null,
    totalScore: 0, difficultyMix: { easy: 5, medium: 0, hard: 0 }, results: rounds, scoringVersion: 1,
    roomResults: Array.from({ length: 8 }, (_, i) => ({ key: `seat-${i}`, name: `Seat ${i}`, rounds })) };
  const packed = await encodeReplay(record);
  const snapshotRows = await db('location_replay_snapshots').select('payload');
  report.replays = { oldEightSeatBytes: Buffer.byteLength(JSON.stringify(record)) * 8,
    compactEightSeatBytes: Buffer.byteLength(packed) * 8 + snapshotRows.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0) };
  const output = process.argv[2];
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.destroy());
