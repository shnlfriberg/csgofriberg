import express from 'express';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { unlink } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/init';
import { db } from '../../src/db/knex';
import { signToken } from '../../src/middleware/auth';
import { errorHandler } from '../../src/middleware/common';
import { adminLocationRoutes } from '../../src/location/routes';
import { uploadAsset, assetPath } from '../../src/location/assets';
import { captureImages } from '../../src/location/capturePoints';
import { exportBank, stageBank, previewBank, importBank } from '../../src/location/bank';
import type { CaptureDraft, CaptureAsset, MapDefinition } from '../../src/location/types';

describe('multiple independent image questions at one permanent capture point', () => {
  let server: ReturnType<express.Express['listen']>;
  let url: string, cookie: string, userId: number;
  const pointId = randomUUID(), batchId = randomUUID();
  const imageIds = Array.from({ length: 4 }, () => randomUUID());
  const pointIds = [pointId];
  const assets: CaptureAsset[] = [];
  const map: MapDefinition = {
    id: `test_multi_${randomUUID().slice(0, 8)}`, name: 'TEST ONLY', version: 1,
    enabled: true, order: 99, width: 1024, height: 1024,
    floors: [{ id: 'main', name: 'Main', radarUrl: '/location-radars/de_dust2_main.webp' }],
    bounds: { u: 0, v: 0, width: 1, height: 1 },
    calibration: { posX: 0, posY: 1024, scale: 1, points: [
      { u: .1, v: .1 }, { u: .9, v: .1 }, { u: .1, v: .9 },
    ].map(p => ({ ...p, x: p.u * 1024, y: 1024 - p.v * 1024, floorId: 'main' })) },
  };
  const world = { x: 256, y: 512, z: 32 };
  let point: CaptureDraft;
  const question = (asset: CaptureAsset) => ({
    mapId: map.id, mapVersion: 1, floorId: 'main', u: .25, v: .5,
    capturePointId: 'one-position', tier: 'easy', status: 'published',
    imageUrl: asset.url, thumbnailUrl: asset.thumbnailUrl, imageHash: asset.hash,
    capturedAt: '2026-10-18T00:00:00Z', source: 'Isolated multi-image regression',
    build: 'TEST ONLY', world, view: { pitch: 2, yaw: 90, roll: 0, fov: 90 },
  });
  async function req(route: string, body?: unknown, method = 'POST') {
    const response = await fetch(url + route, { method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  beforeAll(async () => {
    await initDb();
    const users = await db('users').insert({ username: `multi_${randomUUID()}`, password_hash: 'unused', role: 'admin' }).returning('id');
    userId = Number(typeof users[0] === 'object' ? users[0].id : users[0]);
    cookie = `csgofriberg_session=${signToken({ id: userId, token_version: 0 })}`;
    await db('location_maps').insert({ id: map.id, payload: JSON.stringify(map) });
    await db('location_versions').insert({ key: `map:${map.id}:1`, payload: JSON.stringify(map) });
    for (const color of ['#dd1111', '#11dd11', '#1111dd', '#dddd11']) {
      const png = await sharp({ create: { width: 480, height: 480, channels: 3, background: color } }).png().toBuffer();
      const image = await uploadAsset(png);
      assets.push({ url: image.url, thumbnailUrl: image.thumbnailUrl, hash: image.hash });
    }
    const app = express(); app.use('/admin', adminLocationRoutes); app.use(errorHandler);
    server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as any).port}/admin`;
    const saved = await req('/capture-drafts', { points: [{
      id: pointId, batchId, batchName: 'TEST ONLY multiple images', order: 1,
      capturePointId: 'one-position', mapId: map.id, floorId: 'main', u: .249, v: .499,
    }] });
    expect(saved.status).toBe(200); point = saved.data.items[0];
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const rows = await db('location_questions').select('payload');
    const ids = rows.map(r => JSON.parse(r.payload)).filter(q => q.mapId === map.id).map(q => q.id);
    await db('location_questions').whereIn('id', ids).delete();
    for (const id of ids) await db('location_versions').where('key', 'like', `question:${id}:%`).delete();
    await db('location_capture_drafts').whereIn('id', pointIds).delete();
    await db('location_maps').where({ id: map.id }).delete();
    await db('location_versions').where('key', 'like', `map:${map.id}:%`).delete();
    await db('users').where({ id: userId }).delete();
    await Promise.all(assets.flatMap(a => [unlink(assetPath(a.url)), unlink(assetPath(a.thumbnailUrl))]));
  });

  it('appends images without overwriting, checks versions and retries idempotently', async () => {
    const body = { version: point.version, imageId: imageIds[0], asset: assets[0] };
    const first = await req(`/capture-drafts/${pointId}/images`, body);
    expect(first.status, JSON.stringify(first.data)).toBe(200); point = first.data;
    expect((await req(`/capture-drafts/${pointId}/images`, body)).data).toEqual(point);
    expect((await req(`/capture-drafts/${pointId}/images`, { ...body, asset: assets[1] })).status).toBe(409);
    expect((await req(`/capture-drafts/${pointId}/images`, { ...body, imageId: imageIds[1], asset: assets[1] })).status).toBe(409);
    const second = await req(`/capture-drafts/${pointId}/images`, { version: point.version, imageId: imageIds[1], asset: assets[1] });
    expect(second.status).toBe(200); point = second.data;
    expect(captureImages(point).map(i => i.asset.hash)).toEqual(assets.slice(0, 2).map(a => a.hash));
  });

  it('creates different-difficulty questions, retains the point and shares an exact answer', async () => {
    const firstBody = { version: point.version, imageId: imageIds[0], question: question(assets[0]) };
    const first = await req(`/capture-drafts/${pointId}/complete`, firstBody);
    expect(first.status).toBe(200); expect(first.data.id).toBe(imageIds[0]);
    point = JSON.parse((await db('location_capture_drafts').where({ id: pointId }).first()).payload);
    expect(point.world).toEqual(world); expect(point.u).toBe(.25); expect(point.v).toBe(.5);
    expect(captureImages(point).map(i => i.id)).toEqual([imageIds[1]]);
    const bad = await req(`/capture-drafts/${pointId}/complete`, { version: point.version, imageId: imageIds[1], question: { ...question(assets[1]), world: { ...world, x: world.x + 25 } } });
    expect(bad.data.code).toBe('LOCATION_CAPTURE_POSITION_MISMATCH');
    const second = await req(`/capture-drafts/${pointId}/complete`, { version: point.version, imageId: imageIds[1], question: {
      ...question(assets[1]), tier: 'hard', world: { ...world, x: world.x + .02 }, view: { pitch: -3, yaw: 180, roll: 0, fov: 90 },
    } });
    expect(second.status).toBe(200);
    expect(second.data).toMatchObject({ id: imageIds[1], world, u: first.data.u, v: first.data.v, tier: 'hard', view: { yaw: 180 } });
    expect(first.data.tier).toBe('easy');
    point = JSON.parse((await db('location_capture_drafts').where({ id: pointId }).first()).payload);
    expect(captureImages(point)).toEqual([]); expect(point.world).toEqual(world);
    expect((await req(`/capture-drafts/${pointId}/complete`, firstBody)).data).toEqual(first.data);
    expect(JSON.parse((await db('location_versions').where({ key: `question:${imageIds[0]}:1` }).first()).payload)).toEqual(first.data);
  });

  it('adds a variant from an existing question, inheriting location but keeping its own camera and tier', async () => {
    const { world: omitted, ...input } = question(assets[2]);
    const result = await req('/questions', { ...input, tier: 'medium', view: { pitch: 15, yaw: 270, roll: 0, fov: 100 } });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ capturePointId: point.capturePointId, world, u: .25, v: .5, tier: 'medium', view: { yaw: 270, fov: 100 } });
    const bad = await req('/questions', { ...result.data, world: { ...world, z: 100 } });
    expect(bad.data.code).toBe('LOCATION_CAPTURE_POSITION_MISMATCH');
    const changedFloor = await req('/questions', { ...result.data, floorId: 'unknown' });
    expect(changedFloor.status).toBe(400);
    point = JSON.parse((await db('location_capture_drafts').where({ id: pointId }).first()).payload);
  });

  it('removes only the selected pending image and restores multi-image points through ZIP', async () => {
    const added = await req(`/capture-drafts/${pointId}/images`, { version: point.version, imageId: imageIds[3], asset: assets[3] });
    expect(added.status).toBe(200); point = added.data;
    expect((await req('/questions', { ...question(assets[3]), id: imageIds[3] })).data.code).toBe('LOCATION_STALE_STATE');
    const duplicate = await req(`/capture-drafts/${pointId}/images`, { version: point.version, imageId: randomUUID(), asset: assets[0] });
    expect(duplicate.data.code).toBe('LOCATION_DUPLICATE_IMAGE');
    const chunks: Buffer[] = [];
    await exportBank(new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } }));
    const preview = await stageBank(Readable.from(Buffer.concat(chunks)), userId);
    expect(preview.canImport).toBe(true);
    const conflictingId = randomUUID();
    const conflicting = { ...question(assets[3]), id: conflictingId, version: 1,
      mapVersion: 1, world: { ...world, x: world.x + 100 }, status: 'draft' };
    await db('location_questions').insert({ id: conflictingId, image_hash: assets[3].hash, payload: JSON.stringify(conflicting) });
    try {
      const blocked = await previewBank(preview.token, userId, false);
      expect(blocked.canImport).toBe(false);
      expect(blocked.conflicts.some((c) => c.code === 'LOCATION_CAPTURE_POSITION_MISMATCH')).toBe(true);
    } finally {
      await db('location_questions').where({ id: conflictingId }).delete();
    }
    await db('location_capture_drafts').where({ id: pointId }).delete();
    const refreshed = await previewBank(preview.token, userId, false);
    await importBank(preview.token, userId, refreshed.fingerprint, false);
    point = JSON.parse((await db('location_capture_drafts').where({ id: pointId }).first()).payload);
    expect(point.world).toEqual(world); expect(captureImages(point)[0].asset.hash).toBe(assets[3].hash);
    const removed = await req(`/capture-drafts/${pointId}/images/${imageIds[3]}`, { version: point.version }, 'DELETE');
    expect(removed.status).toBe(200); expect(captureImages(removed.data)).toEqual([]);
    expect((await db('location_questions').whereIn('id', imageIds.slice(0, 2)).select()).length).toBe(2);
  });

  it('establishes a shared measured answer even when another image was already saved as an unmeasured draft', async () => {
    const id = randomUUID(); pointIds.push(id);
    const imageA = randomUUID(), imageB = randomUUID();
    const newAssets: CaptureAsset[] = [];
    for (const color of ['#123456', '#654321']) {
      const png = await sharp({ create: { width: 480, height: 480, channels: 3, background: color } }).png().toBuffer();
      const uploaded = await uploadAsset(png);
      const value = { url: uploaded.url, thumbnailUrl: uploaded.thumbnailUrl, hash: uploaded.hash };
      newAssets.push(value); assets.push(value);
    }
    let draft = (await req('/capture-drafts', { points: [{ id, batchId, batchName: 'TEST ONLY', order: 2,
      capturePointId: 'draft-then-world', mapId: map.id, floorId: 'main', u: .249, v: .499 }] })).data.items[0];
    for (const [i, imageId] of [imageA, imageB].entries())
      draft = (await req(`/capture-drafts/${id}/images`, { version: draft.version, imageId, asset: newAssets[i] })).data;
    const { world: omitted, ...withoutWorld } = question(newAssets[0]);
    const first = await req(`/capture-drafts/${id}/complete`, { version: draft.version, imageId: imageA,
      question: { ...withoutWorld, capturePointId: 'draft-then-world', status: 'draft' } });
    expect(first.status).toBe(200); expect(first.data.world).toBeUndefined();
    draft = JSON.parse((await db('location_capture_drafts').where({ id }).first()).payload);
    const second = await req(`/capture-drafts/${id}/complete`, { version: draft.version, imageId: imageB,
      question: { ...question(newAssets[1]), capturePointId: 'draft-then-world', tier: 'hard' } });
    expect(second.status).toBe(200);
    const normalized = JSON.parse((await db('location_questions').where({ id: imageA }).first()).payload);
    expect(normalized).toMatchObject({ world, u: .25, v: .5, version: 2, tier: 'easy' });
    const original = JSON.parse((await db('location_versions').where({ key: `question:${imageA}:1` }).first()).payload);
    expect(original.world).toBeUndefined(); expect(original.u).toBe(.249);
  });
});
