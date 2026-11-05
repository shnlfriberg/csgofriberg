import { beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ensureSchema } from '../../src/db/schema';
import { db } from '../../src/db/knex';
import { initRedis, redis, redisKey } from '../../src/redis';
import { captureCounts, captureImageIdExists } from '../../src/location/admin/captureQueries';
import { bankAvailability } from '../../src/location/bankAvailability';
import { decodeReplay } from '../../src/location/replayStorage';
import { flushResult, retryResult } from '../../src/location/resultOutbox';
import { startWorker } from '../../src/location/maintenanceWorkers';
import { testPool } from './fixtures';

beforeAll(async () => { await ensureSchema(); await initRedis(); });
describe('bounded location background work', () => {
  it('counts mixed legacy/new capture images without loading complete draft payloads', async () => {
    const before = await captureCounts(); const tag = randomUUID();
    const rows = [{ asset: { url: '/legacy' }, images: [] }, { images: [{ id: tag + '-image' }] }, {}, { images: null }]
      .map((data, i) => ({ id: tag + i, payload: JSON.stringify(data) }));
    await db('location_capture_drafts').insert(rows);
    try {
      expect(await captureCounts()).toEqual({ points: before.points + 4, withImages: before.withImages + 2 });
      expect(await captureImageIdExists(tag + '-image')).toBe(true);
      expect(await captureImageIdExists(tag + '0')).toBe(true);
      expect(await captureImageIdExists(tag + '-missing')).toBe(false);
    } finally { await db('location_capture_drafts').whereIn('id', rows.map(r => r.id)).delete(); }
  });

  it('reports random exhaustion after reserving a feasible daily deck', () => {
    const pool = testPool(15); pool.forEach((item, i) => { item.question.tier = i < 6 ? 'easy' : i < 11 ? 'medium' : 'hard'; });
    const result = bankAvailability(pool, null);
    expect(result.compositions).toEqual({ easy: true, normal: true, hard: true });
    expect(result.dailyAvailable).toBe(true);
    expect(result.reservedPoints).toBe(15);
    expect(result.randomAfterDaily).toEqual({ easy: false, normal: false, hard: false });
  });
  it('batches shared snapshot references and detects cycles', async () => {
    const prefix = randomUUID(); const hashes = Array.from({ length: 12 }, (_, i) => prefix + i);
    await db('location_replay_snapshots').insert(hashes.map((hash, i) => ({ hash, payload: JSON.stringify({ i }) })));
    let reads = 0; const onQuery = (q: { sql: string }) => { if (/select.*location_replay_snapshots/.test(q.sql)) reads++; };
    db.on('query', onQuery);
    try {
      const result = await decodeReplay(JSON.stringify({ storageVersion: 2, refs: hashes.map(hash => ({ $locationSnapshot: hash })) }));
      expect((result as any).refs).toHaveLength(12); expect(reads).toBe(1);
      await db('location_replay_snapshots').where({ hash: hashes[0] }).update({ payload: JSON.stringify({ $locationSnapshot: hashes[0] }) });
      await expect(decodeReplay(JSON.stringify({ storageVersion: 2, ref: { $locationSnapshot: hashes[0] } }))).rejects.toThrow('LOCATION_REPLAY_SNAPSHOT_CYCLE');
    } finally { db.off('query', onQuery); await db('location_replay_snapshots').whereIn('hash', hashes).delete(); }
  });
  it('honors SQL due_at even with an obsolete Redis score and allows explicit retry', async () => {
    const id = randomUUID(); const due = Date.now() + 60000;
    await db('location_result_outbox').insert({ game_id: id, payload: 'INVALID_UNTIL_DUE', attempts: 2, due_at: due });
    await redis()!.zAdd(redisKey('location:outbox'), { value: id, score: 0 });
    try {
      await flushResult(id);
      expect(await redis()!.zScore(redisKey('location:outbox'), id)).toBe(due);
      expect((await db('location_result_outbox').where({ game_id: id }).first()).attempts).toBe(2);
      await retryResult(id);
      await expect(flushResult(id)).rejects.toThrow();
      const row = await db('location_result_outbox').where({ game_id: id }).first();
      expect(row.attempts).toBe(1);
      expect(Number(row.due_at)).toBeGreaterThan(Date.now());
      expect(await redis()!.zScore(redisKey('location:outbox'), id)).toBe(Number(row.due_at));
    } finally { await db('location_result_outbox').where({ game_id: id }).delete(); await redis()!.zRem(redisKey('location:outbox'), id); }
  });
  it('a stalled maintenance task does not block another worker, overlap itself, or escape shutdown draining', async () => {
    vi.useFakeTimers();
    let release!: () => void; const slow = vi.fn(() => new Promise<void>(resolve => { release = resolve; })); const fast = vi.fn(async () => {});
    const stopSlow = startWorker('test-slow', 100, slow); const stopFast = startWorker('test-fast', 100, fast);
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(slow).toHaveBeenCalledTimes(1); expect(fast).toHaveBeenCalledTimes(5);
      let drained = false; const stopping = stopSlow().then(() => { drained = true; });
      await Promise.resolve(); expect(drained).toBe(false); release(); await stopping;
      await stopFast();
    } finally { vi.useRealTimers(); }
  });
});
