import express from 'express';
import sharp from 'sharp';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/init';
import { db } from '../../src/db/knex';
import { initRedis } from '../../src/redis';
import { signToken } from '../../src/middleware/auth';
import { errorHandler } from '../../src/middleware/common';
import { adminLocationRoutes } from '../../src/location/routes';
import { assetPath, uploadAsset } from '../../src/location/assets';
import { testMap } from './fixtures';
import { calibrationValid } from '../../src/location/rules';
import { unlink } from 'fs/promises';
import type { Question } from '../../src/location/types';

describe('location authoring and immutable versions', () => {
  let server: ReturnType<express.Express['listen']>; let url: string; let cookie: string; let userId: number; const assets: string[] = [];
  async function req(route: string, body?: unknown, method = 'POST') { const response = await fetch(url + route, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
  beforeAll(async () => {
    sharp.cache(false);
    await initDb(); await initRedis();
    const inserted = await db('users').insert({ username: `location_admin_${randomUUID()}`, password_hash: 'unused', role: 'admin' }).returning('id'); userId = Number(typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]); cookie = `csgofriberg_session=${signToken({ id: userId, token_version: 0 })}`;
    await db('location_maps').insert({ id: 'test_location_admin', payload: JSON.stringify(testMap('test_location_admin')) });
    const app = express(); app.use('/admin', adminLocationRoutes); app.use(errorHandler); server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); url = `http://127.0.0.1:${(server.address() as any).port}/admin`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db('location_questions').where('id', 'like', 'test_location_admin%').delete(); await db('location_maps').where('id', 'like', 'test_location_admin%').delete(); await db('location_versions').where('key', 'like', '%test_location_admin%').delete(); await db('users').where({ id: userId }).delete(); await Promise.all(assets.map(asset => unlink(assetPath(asset)))); });
  it('fits measured references on the server, ignores submitted presets and preserves old versions', async () => {
    const map = testMap('test_location_admin_fitted');
    map.width = map.height = 1024;
    map.floors = [{ id: 'main', name: 'Main', radarUrl: '/location-radars/de_dust2_main.webp' }];
    map.calibration = {
      posX: 9999, posY: -9999, scale: 100,
      points: [{ u: .1, v: .1 }, { u: .9, v: .1 }, { u: .1, v: .9 }].map(p => ({
        ...p, x: -1500 + p.u * 1024 * 3, y: 2500 - p.v * 1024 * 3, floorId: 'main',
      })),
    };
    const saved = await req(`/maps/${map.id}`, map, 'PUT');
    expect(saved.status).toBe(200);
    expect(saved.data.calibration.posX).toBeCloseTo(-1500, 8);
    expect(saved.data.calibration.posY).toBeCloseTo(2500, 8);
    expect(saved.data.calibration.scale).toBeCloseTo(3, 10);
    expect(saved.data.calibration.points).toEqual(map.calibration.points);
    expect(calibrationValid(saved.data)).toBe(true);
    expect(saved.data.version).toBe(1);
    const resaved = await req(`/maps/${map.id}`, { ...saved.data,
      calibration: { ...saved.data.calibration, posX: 123456, posY: -555555, scale: .01 },
    }, 'PUT');
    expect(resaved.status).toBe(200);
    expect(resaved.data).toEqual(saved.data);
    const shifted = structuredClone(saved.data);
    shifted.calibration.points.forEach((p: { x: number }) => { p.x += 128; });
    const updated = await req(`/maps/${map.id}`, shifted, 'PUT');
    expect(updated.status).toBe(200);
    expect(updated.data.version).toBe(2);
    expect(updated.data.calibration.posX).toBeCloseTo(-1372, 8);
    const old = JSON.parse((await db('location_versions').where({ key: `map:${map.id}:1` }).first()).payload);
    expect(old).toEqual(saved.data);
    const overview = await req('/overview', undefined, 'GET');
    expect(overview.data.counts.find((m: { mapId: string }) => m.mapId === map.id).calibrationValid).toBe(true);
    expect((await req(`/maps/${map.id}`, saved.data, 'PUT')).data.code).toBe('LOCATION_STALE_STATE');
  });
  it('publishes radar answers without measured coordinates, camera or calibration and still checks assets and versions', async () => {
    const png = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 21, g: 22, b: 23 } } }).png().withMetadata({ orientation: 1 }).toBuffer();
    const uploaded = await fetch(url + '/assets', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/png' }, body: png }); expect(uploaded.status).toBe(200); const asset = await uploaded.json(); assets.push(asset.url, asset.thumbnailUrl);
    expect(asset).toMatchObject({width:360,height:360}); expect(await sharp(assetPath(asset.thumbnailUrl)).metadata()).toMatchObject({width:240,height:240}); expect(asset.url).toMatch(/^\/location-assets\/[a-f0-9-]+\.webp$/); expect((await sharp(assetPath(asset.url)).metadata()).exif).toBeUndefined();
    const input = { id: 'test_location_admin_q', mapId: 'test_location_admin', floorId: 'upper', u: .5, v: .5, capturePointId: 'point-1', tier: 'medium', status: 'published', imageUrl: asset.url, thumbnailUrl: asset.thumbnailUrl, imageHash: asset.hash, capturedAt: '2026-10-01T00:00:00Z', build: 'TEST ONLY', source: 'Isolated authoring regression fixture', view: { pitch: 0, yaw: 90, roll: 0, fov: 90 } };
    expect((await req('/questions', { ...input, world: { x: 900, y: 250, z: 0 } })).data.code).toBe('LOCATION_COORDINATE_MISMATCH');
    const { view, build, source, capturedAt, ...minimal } = input;
    const published = await req('/questions', minimal); expect(published.status).toBe(200); expect(published.data.version).toBe(1);
    expect(published.data).not.toHaveProperty('world'); expect(published.data).not.toHaveProperty('view');
    expect(published.data).toMatchObject({ build: '', source: '', u: .5, v: .5, status: 'published' });
    expect((await req('/questions', { ...published.data, id: 'test_location_admin_duplicate' })).data.code).toBe('LOCATION_DUPLICATE_IMAGE');
    const edited = await req('/questions', { ...published.data, status: 'disabled' }); expect(edited.data.version).toBe(2);
    expect(JSON.parse((await db('location_versions').where({ key: 'question:test_location_admin_q:1' }).first()).payload).status).toBe('published');
    expect((await req('/questions', published.data)).data.code).toBe('LOCATION_STALE_STATE');
    const map = testMap('test_location_admin'); map.width = map.height = 1024; map.calibration.points = [];
    const uncalibrated = await req('/maps/test_location_admin', map, 'PUT'); expect(uncalibrated.status).toBe(200); expect(uncalibrated.data.version).toBe(2);
    const withoutCalibration = await req('/questions', { ...edited.data, status: 'published' });
    expect(withoutCalibration.status).toBe(200);
    expect(withoutCalibration.data).toMatchObject({ status: 'published', mapVersion: 2 });
    expect((await req('/maps/test_location_admin', map, 'PUT')).data.code).toBe('LOCATION_STALE_STATE');
  });
  it('preserves explicitly uploaded radars and rejects undersized screenshots with a specific error', async () => {
    const png = await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#355577' } }).png().toBuffer();
    const response = await fetch(url + '/assets?purpose=radar', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/png' }, body: png });
    expect(response.status).toBe(200); const radar = await response.json(); assets.push(radar.url, radar.thumbnailUrl);
    expect(radar).toMatchObject({ width: 1000, height: 500 });
    const invalid = await fetch(url + '/assets?purpose=unknown', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/png' }, body: png });
    expect(invalid.status).toBe(400);
    const small = await sharp({ create: { width: 359, height: 960, channels: 3, background: 'red' } }).png().toBuffer();
    const rejected = await fetch(url + '/assets', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/png' }, body: small });
    expect(rejected.status).toBe(400); expect((await rejected.json()).code).toBe('LOCATION_CAPTURE_TOO_SMALL');
  });
  it('bulk publishes only unchanged pending questions, reports individual failures and never republishes successful ones', async () => {
    const map = testMap('test_location_admin_bulk'); map.calibration.points = [];
    await db('location_maps').insert({ id: map.id, payload: JSON.stringify(map) });
    const questions: Question[] = [];
    for (let i = 0; i < 7; i++) {
      const asset = await uploadAsset(await sharp({ create: { width: 360, height: 360,
        channels: 3, background: { r: 30 + i * 20, g: 60, b: 90 } } }).png().toBuffer());
      assets.push(asset.url, asset.thumbnailUrl);
      const question: Question = {
        id: `test_location_admin_bulk_${i}`, version: 1, mapVersion: i === 4 ? 2 : 1,
        mapId: map.id, floorId: 'upper', u: .2 + i * .05, v: .5,
        capturePointId: `bulk-point-${i}`, tier: 'medium',
        status: i === 1 ? 'review' : i === 2 ? 'published' : i === 3 ? 'disabled' : 'draft',
        imageUrl: i === 5 ? `/location-assets/${randomUUID()}.webp` : asset.url,
        thumbnailUrl: asset.thumbnailUrl, imageHash: asset.hash,
        capturedAt: '2026-10-19T00:00:00Z', build: '', source: '',
      };
      questions.push(question);
      await db('location_questions').insert({ id: question.id, image_hash: question.imageHash, payload: JSON.stringify(question) });
    }
    const body = { questions: questions.map((q, i) => ({ id: q.id, version: i === 6 ? 2 : q.version })) };
    expect((await fetch(url + '/questions/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(401);
    expect((await req('/questions/publish', { questions: [] })).status).toBe(400);
    expect((await req('/questions/publish', { questions: [body.questions[0], body.questions[0]] })).status).toBe(400);
    const response = await req('/questions/publish', body);
    expect(response.status).toBe(200);
    expect(response.data.results.map((r: { ok: boolean; code?: string }) => r.ok ? 'published' : r.code)).toEqual([
      'published', 'published', 'LOCATION_QUESTION_NOT_PENDING', 'LOCATION_QUESTION_NOT_PENDING',
      'LOCATION_CAPTURE_MAP_CHANGED', 'LOCATION_INVALID_ASSET', 'LOCATION_STALE_STATE',
    ]);
    for (const [index, q] of questions.entries()) {
      const saved = JSON.parse((await db('location_questions').where({ id: q.id }).first()).payload);
      expect(saved.status).toBe(index < 2 ? 'published' : q.status);
      expect(saved.version).toBe(index < 2 ? 2 : 1);
      expect(saved).not.toHaveProperty('world'); expect(saved).not.toHaveProperty('view');
    }
    const retry = await req('/questions/publish', { questions: body.questions.slice(0, 2) });
    expect(retry.data.results.every((r: { code: string }) => r.code === 'LOCATION_QUESTION_NOT_PENDING')).toBe(true);
    const missing = await req('/questions/publish', { questions: [{ id: 'test_location_admin_missing', version: 1 }] });
    expect(missing.data.results[0].code).toBe('LOCATION_QUESTION_NOT_FOUND');
  });

});
