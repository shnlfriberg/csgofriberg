import express from 'express';
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { db } from '../../src/db/knex';
import { initDb } from '../../src/db/init';
import { initRedis } from '../../src/redis';
import { errorHandler } from '../../src/middleware/common';
import { signToken } from '../../src/middleware/auth';
import { adminLocationRoutes } from '../../src/location/admin/routes';
import { listMergePoints, mergePoints } from '../../src/location/admin/pointMerge';
import { savePointModels } from '../../src/location/pointStore';
import { pool } from '../../src/location/store';
import type { CaptureDraft, MapDefinition, Question, MergePointsInput } from '@friberg/location-core';

const map: MapDefinition = { id: `merge-${randomUUID().slice(0, 8)}`, name: 'Merge test', enabled: true, order: 99,
  version: 1, width: 1024, height: 1024, bounds: { u: 0, v: 0, width: 1, height: 1 },
  floors: [{ id: 'upper', name: 'Upper', radarUrl: '/test.webp' }, { id: 'lower', name: 'Lower', radarUrl: '/test.webp' }],
  calibration: { posX: 0, posY: 1024, scale: 1, points: [] } };
let server: http.Server; let base = ''; let cookie = ''; let userId: number;
const receipts: string[] = [];
async function fixture() {
  const a = randomUUID(), b = randomUUID();
  const questions: Question[] = [a, b, b].map((capturePointId, i) => ({
    id: randomUUID(), capturePointId, version: 1, mapVersion: 1, mapId: map.id, floorId: 'upper', u: .4 + i * .01, v: .5,
    imageUrl: `/${randomUUID()}.webp`, thumbnailUrl: `/${randomUUID()}.webp`, imageHash: randomUUID(),
    tier: i === 0 ? 'easy' : 'hard', status: i === 2 ? 'disabled' : 'published', source: 'contributor', capturedAt: '', build: '',
    world: { x: 10, y: 20, z: 30 },
  }));
  const drafts: CaptureDraft[] = [a, b].map((capturePointId, i) => ({
    id: randomUUID(), capturePointId, version: 1, mapVersion: 1, mapId: map.id, floorId: 'upper', u: .4, v: .5,
    batchId: randomUUID(), batchName: 'test', order: i, createdAt: '2026-10-29T00:00:00Z',
    asset: { url: `/${randomUUID()}.webp`, thumbnailUrl: `/${randomUUID()}.webp`, hash: randomUUID() },
  }));
  await db.transaction(async trx => {
    for (const q of questions) {
      await trx('location_questions').insert({ id: q.id, image_hash: q.imageHash, payload: JSON.stringify(q) });
      await trx('location_versions').insert({ key: `question:${q.id}:1`, payload: JSON.stringify(q) });
    }
    for (const d of drafts) await trx('location_capture_drafts').insert({ id: d.id, payload: JSON.stringify(d) });
    await savePointModels(trx, questions);
  });
  const points = (await listMergePoints(map.id, 'upper')).items.filter(p => [a, b].includes(p.capturePointId));
  // Keep explicit selection order, independent of list ordering.
  const input: MergePointsInput = { operationId: randomUUID(), mapId: map.id, floorId: 'upper', mapVersion: 1, u: .7, v: .8,
    points: [a, b].map(id => { const p = points.find(p => p.capturePointId === id)!; return { capturePointId: id, fingerprint: p.fingerprint }; }) };
  receipts.push(input.operationId);
  return { questions, drafts, input, a, b };
}
beforeAll(async () => {
  await initDb(); await initRedis();
  await db('location_maps').insert({ id: map.id, payload: JSON.stringify(map) });
  const [user] = await db('users').insert({ username: `merge-${randomUUID()}`, password_hash: 'test', role: 'admin' }).returning(['id', 'username', 'token_version']);
  userId = Number(user.id); cookie = `csgofriberg_session=${signToken(user)}`;
  const app = express(); app.use('/api/admin/location', adminLocationRoutes); app.use(errorHandler);
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api/admin/location`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  const ids = (await db('location_questions').where({ map_id: map.id }).select('id')).map(q => q.id);
  for (const id of ids) await db('location_versions').where('key', 'like', `question:${id}:%`).delete();
  await db('location_versions').whereIn('key', receipts.map(id => `point-merge:${id}`)).delete();
  for (const table of ['location_questions', 'location_capture_drafts', 'location_points', 'location_point_versions']) await db(table).where({ map_id: map.id }).delete();
  await db('location_maps').where({ id: map.id }).delete(); await db('users').where({ id: userId }).delete();
});

describe('point merger', () => {
  it('merges every question/status and legacy draft image atomically while retaining historical snapshots and IDs', async () => {
    const f = await fixture(); const frozenPool = await pool();
    const result = await mergePoints(f.input);
    expect(result).toEqual({ capturePointId: f.a, points: 2, questions: 3, images: 2 });
    for (const q of f.questions) {
      const next = JSON.parse((await db('location_questions').where({ id: q.id }).first()).payload);
      const { world: _world, ...original } = q;
      expect(next).toEqual({ ...original, capturePointId: f.a, version: 2, u: .7, v: .8 });
      expect(next.world).toBeUndefined();
      expect(JSON.parse((await db('location_versions').where({ key: `question:${q.id}:1` }).first()).payload)).toEqual(q);
    }
    const drafts = await db('location_capture_drafts').whereIn('id', f.drafts.map(d => d.id));
    expect(drafts).toHaveLength(1);
    expect(JSON.parse(drafts[0].payload)).toMatchObject({ capturePointId: f.a, u: .7, v: .8,
      images: expect.arrayContaining(f.drafts.map(d => expect.objectContaining({ id: d.id, asset: d.asset }))) });
    expect((await listMergePoints(map.id, 'upper')).items.some(p => p.capturePointId === f.b)).toBe(false);
    expect(await db('location_point_versions').where({ map_id: map.id, point_id: f.b }).first()).toBeTruthy();
    expect(frozenPool.find(s => s.question.id === f.questions[1].id)?.question.capturePointId).toBe(f.b);
    expect((await pool()).find(s => s.question.id === f.questions[1].id)?.question.capturePointId).toBe(f.a);
    const receipt = JSON.parse((await db('location_versions').where({ key: `point-merge:${f.input.operationId}` }).first()).payload);
    expect(receipt.drafts).toHaveLength(2); expect(receipt.drafts).toEqual(expect.arrayContaining(f.drafts));
  });
  it('retries concurrent identical operations once and rejects changed reuse of the operation ID', async () => {
    const { input, questions } = await fixture();
    const [a, b] = await Promise.all([mergePoints(input), mergePoints(input)]); expect(a).toEqual(b);
    expect(JSON.parse((await db('location_questions').where({ id: questions[0].id }).first()).payload).version).toBe(2);
    await expect(mergePoints({ ...input, u: .6 })).rejects.toThrow('LOCATION_STALE_STATE');
  });
  it('merges more than two points and preserves modern image IDs alongside legacy images', async () => {
    const f = await fixture(); const other = await fixture();
    const modern = { ...other.drafts[0], asset: undefined,
      images: [{ id: randomUUID(), createdAt: other.drafts[0].createdAt, asset: other.drafts[0].asset! }] };
    await db('location_capture_drafts').where({ id: modern.id }).update({ payload: JSON.stringify(modern) });
    const third = (await listMergePoints(map.id, 'upper')).items.find(p => p.capturePointId === other.a)!;
    const result = await mergePoints({ ...f.input, points: [...f.input.points, { capturePointId: third.capturePointId, fingerprint: third.fingerprint }] });
    expect(result).toMatchObject({ points: 3, questions: 4, images: 3 });
    const draft = JSON.parse((await db('location_capture_drafts').where({ map_id: map.id, point_id: f.a }).first()).payload);
    expect(draft.images).toContainEqual(modern.images[0]);
    expect((await listMergePoints(map.id, 'upper')).items.some(p => p.capturePointId === other.a)).toBe(false);
  });
  it('rejects image overflow without dropping any captures', async () => {
    const f = await fixture();
    const filled = { ...f.drafts[0], images: Array.from({ length: 100 }, () => ({ id: randomUUID(), createdAt: f.drafts[0].createdAt, asset: f.drafts[0].asset! })) };
    await db('location_capture_drafts').where({ id: filled.id }).update({ payload: JSON.stringify(filled) });
    const list = await listMergePoints(map.id, 'upper');
    const input = { ...f.input, points: f.input.points.map(p => ({ ...p, fingerprint: list.items.find(i => i.capturePointId === p.capturePointId)!.fingerprint })) };
    await expect(mergePoints(input)).rejects.toThrow('LOCATION_CAPTURE_IMAGE_LIMIT');
    expect(JSON.parse((await db('location_capture_drafts').where({ id: filled.id }).first()).payload)).toEqual(filled);
  });
  it('rejects a new sibling or changed draft after preview without partial writes', async () => {
    const { input, questions, drafts } = await fixture();
    await db('location_capture_drafts').where({ id: drafts[0].id }).update({ payload: JSON.stringify({ ...drafts[0], version: 2 }) });
    await expect(mergePoints(input)).rejects.toThrow('LOCATION_STALE_STATE');
    expect(JSON.parse((await db('location_questions').where({ id: questions[0].id }).first()).payload)).toEqual(questions[0]);
    const f = await fixture(); const added = { ...f.questions[0], id: randomUUID(), imageHash: randomUUID() };
    await db('location_questions').insert({ id: added.id, image_hash: added.imageHash, payload: JSON.stringify(added) });
    await expect(mergePoints(f.input)).rejects.toThrow('LOCATION_STALE_STATE');
  });
  it('rejects different floors, stale map versions and rolls back on storage failure', async () => {
    const f = await fixture();
    await expect(mergePoints({ ...f.input, floorId: 'lower' })).rejects.toThrow('LOCATION_CAPTURE_MAP_CHANGED');
    await expect(mergePoints({ ...f.input, mapVersion: 2 })).rejects.toThrow('LOCATION_CAPTURE_MAP_CHANGED');
    await db('location_versions').insert({ key: `question:${f.questions[1].id}:2`, payload: '{}' });
    await expect(mergePoints(f.input)).rejects.toThrow();
    for (const q of f.questions) expect(JSON.parse((await db('location_questions').where({ id: q.id }).first()).payload)).toEqual(q);
    expect(await db('location_capture_drafts').whereIn('id', f.drafts.map(d => d.id))).toHaveLength(2);
  });
  it('requires admin authentication and validates duplicate point IDs and coordinates at HTTP boundary', async () => {
    const f = await fixture();
    expect((await fetch(`${base}/points?mapId=${map.id}&floorId=upper`)).status).toBe(401);
    for (const input of [{ ...f.input, u: 2 }, { ...f.input, points: [f.input.points[0], f.input.points[0]] }]) {
      expect((await fetch(`${base}/points/merge`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status).toBe(400);
    }
    const response = await fetch(`${base}/points/merge`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(f.input) });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ points: 2, questions: 3 });
  });
});
