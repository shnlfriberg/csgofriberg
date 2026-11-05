import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ZipFile } from 'yazl';
import * as yauzl from 'yauzl';
import sharp from 'sharp';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/knex';
import { initDb } from '../../src/db/init';
import { initRedis } from '../../src/redis';
import { signToken } from '../../src/middleware/auth';
import { errorHandler } from '../../src/middleware/common';
import { adminLocationRoutes } from '../../src/location/routes';
import { assetDirectory, assetPath, uploadAsset } from '../../src/location/assets';
import { exportBank, importBank, previewBank, stageBank } from '../../src/location/bank';
import type { MapDefinition, Question } from '../../src/location/types';
import { testMap } from './fixtures';

describe('portable bank archives', () => {
  let server: ReturnType<express.Express['listen']>; let base: string; let userId: number; let cookie: string;
  let archive: Buffer; let sourceMaps: MapDefinition[]; let sourceQuestions: Question[];
  const sourceAssets = new Set<string>(); const tokens = new Set<string>();
  const mapId = 'test_bank_map';
  async function clearCatalog() {
    await db('location_questions').where('id', 'like', 'test_bank_%').delete();
    await db('location_maps').where({ id: mapId }).delete();
    await db('location_versions').where('key', 'like', '%test_bank_%').delete();
    for (const token of tokens) await db('location_versions').where({ key: `bank:${token}` }).delete();
  }
  async function stage(bytes = archive) { const value = await stageBank(Readable.from(bytes), userId); tokens.add(value.token); return value; }
  async function zipEntries(bytes: Buffer) {
    const file = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, file) => error ? reject(error) : resolve(file!)));
    const entries = new Map<string, Buffer>();
    await new Promise<void>((resolve, reject) => {
      file.on('error', reject); file.on('end', resolve); file.on('entry', entry => {
        file.openReadStream(entry, (error, stream) => { if (error) return reject(error); const chunks: Buffer[] = [];
          stream!.on('data', chunk => chunks.push(chunk)); stream!.on('error', reject); stream!.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); file.readEntry(); }); });
      }); file.readEntry();
    }); return entries;
  }
  async function repack(entries: Map<string, Buffer>) {
    const zip = new ZipFile(); const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.on('error', reject); });
    for (const [name, bytes] of entries) zip.addBuffer(bytes, name, { compress: false }); zip.end(); return done;
  }
  beforeAll(async () => {
    await initDb(); await initRedis(); sharp.cache(false);
    const user = (await db('users').insert({ username: `test_bank_${randomUUID()}`, password_hash: 'unused', role: 'admin' }).returning('id'))[0]; userId = Number(typeof user === 'object' ? user.id : user); cookie = `csgofriberg_session=${signToken({ id: userId, token_version: 0 })}`;
    const radar = await uploadAsset(await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#244453' } }).webp().toBuffer(), 'radar');
    sourceAssets.add(radar.url); sourceAssets.add(radar.thumbnailUrl);
    const oldMap = testMap(mapId); oldMap.floors.forEach(floor => { floor.radarUrl = radar.url; });
    const newMap = structuredClone(oldMap); newMap.version = 2; newMap.calibration.posX += 100; newMap.calibration.points.forEach(point => { point.x += 100; }); sourceMaps = [oldMap, newMap];
    sourceQuestions = [];
    for (const [i, status] of (['draft', 'review', 'published', 'disabled'] as const).entries()) {
      const image = await uploadAsset(await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 22 + i * 20, g: 40, b: 66 } } }).webp().toBuffer());
      sourceAssets.add(image.url); sourceAssets.add(image.thumbnailUrl);
      sourceQuestions.push({ id: `test_bank_q${i}`, version: 1, mapId, mapVersion: i === 0 ? 1 : 2, floorId: 'upper', u: .5, v: .5, capturePointId: `test-bank-point-${i}`, tier: i < 2 ? 'easy' : i === 2 ? 'medium' : 'hard', status, imageUrl: image.url, thumbnailUrl: image.thumbnailUrl, imageHash: image.hash, capturedAt: '2026-10-05T00:00:00Z', build: 'TEST ONLY', source: 'Synthetic isolated migration fixture, never game content', world: { x: i === 0 ? 500 : 600, y: 250, z: 0 }, view: { pitch: 0, yaw: 90, roll: 0, fov: 90 } });
    }
    const app = express(); app.use('/admin', adminLocationRoutes); app.use(errorHandler); server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as any).port}/admin`;
  });
  beforeEach(async () => {
    await clearCatalog();
    for (const map of sourceMaps) await db('location_versions').insert({ key: `map:${map.id}:${map.version}`, payload: JSON.stringify(map) });
    await db('location_maps').insert({ id: mapId, payload: JSON.stringify(sourceMaps[1]) });
    for (const q of sourceQuestions) { await db('location_questions').insert({ id: q.id, image_hash: q.imageHash, payload: JSON.stringify(q) }); await db('location_versions').insert({ key: `question:${q.id}:1`, payload: JSON.stringify(q) }); }
    // Fresh-deployment test removes source UUID files; restore them from its archive.
    if (archive) { const entries = await zipEntries(archive); const manifest = JSON.parse(entries.get('manifest.json')!.toString()); for (const asset of manifest.assets) if (sourceAssets.has(asset.url)) await fs.writeFile(assetPath(asset.url), entries.get(asset.file)!); }
    const chunks: Buffer[] = []; await exportBank(new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } })); archive = Buffer.concat(chunks);
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve())); await clearCatalog(); await db('users').where({ id: userId }).delete();
    for (const url of sourceAssets) await fs.unlink(assetPath(url)).catch(() => undefined);
    for (const token of tokens) await fs.rm(path.join(assetDirectory, '.bank-transfer', token), { recursive: true, force: true });
  });
  it('exports all states, images and referenced old map versions; identical import is a no-op', async () => {
    const entries = await zipEntries(archive); const manifest = JSON.parse(entries.get('manifest.json')!.toString());
    expect(manifest.format).toBe('friberg-location-bank'); expect(manifest.questions.map((q: Question) => q.status)).toEqual(['draft', 'review', 'published', 'disabled']); expect(manifest.mapVersions.filter((map: MapDefinition) => map.id === mapId).map((map: MapDefinition) => map.version)).toEqual([2, 1]);
    expect(manifest).not.toHaveProperty('users'); expect(manifest).not.toHaveProperty('results');
    const preview = await stage(); expect(preview).toMatchObject({ questions: 4, skipped: 4, mapChanges: 0, added: 0, canImport: true });
    const result = await importBank(preview.token, userId, preview.fingerprint, false); expect(result).toEqual({ added: 0, updated: 0, skipped: 4, maps: 0 });
    expect(await importBank(preview.token, userId, preview.fingerprint, false)).toEqual(result);
  });
  it('round-trips published radar-only questions without camera data or calibrated maps', async () => {
    const radarOnly = { ...sourceQuestions[2] };
    delete radarOnly.world; delete radarOnly.view;
    await db('location_questions').where({ id: radarOnly.id }).update({ payload: JSON.stringify(radarOnly) });
    const uncalibrated = structuredClone(sourceMaps[1]); uncalibrated.calibration.points = [];
    await db('location_maps').where({ id: mapId }).update({ payload: JSON.stringify(uncalibrated) });
    await db('location_versions').where({ key: `map:${mapId}:2` }).update({ payload: JSON.stringify(uncalibrated) });
    const chunks: Buffer[] = [];
    await exportBank(new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } }));
    const preview = await stage(Buffer.concat(chunks));
    expect(preview).toMatchObject({ canImport: true, skipped: 4 });
    await clearCatalog();
    const target = await previewBank(preview.token, userId, false);
    expect(await importBank(target.token, userId, target.fingerprint, false)).toMatchObject({ added: 4 });
    const restored = JSON.parse((await db('location_questions').where({ id: radarOnly.id }).first()).payload);
    expect(restored).toMatchObject({ status: 'published', u: .5, v: .5 });
    expect(restored).not.toHaveProperty('world'); expect(restored).not.toHaveProperty('view');
  });
  it('restores into an empty target with missing source assets and keeps published and stale-map semantics', async () => {
    const preview = await stage(); await clearCatalog();
    for (const url of sourceAssets) await fs.unlink(assetPath(url));
    const target = await previewBank(preview.token, userId, false); expect(target).toMatchObject({ added: 4, canImport: true, mapChanges: 1 });
    expect(await importBank(target.token, userId, target.fingerprint, false)).toMatchObject({ added: 4 });
    const imported = (await db('location_questions').where('id', 'like', 'test_bank_%').orderBy('id').select()).map(row => JSON.parse(row.payload));
    const map = JSON.parse((await db('location_maps').where({ id: mapId }).first()).payload);
    expect(imported.map(q => q.status)).toEqual(['draft', 'review', 'published', 'disabled']); expect(imported[0].mapVersion).not.toBe(map.version); expect(imported[2].mapVersion).toBe(map.version);
    for (const q of imported) { expect(await fs.readFile(assetPath(q.imageUrl))).toBeInstanceOf(Buffer); sourceAssets.add(q.imageUrl); sourceAssets.add(q.thumbnailUrl); }
    const again = await stage(); expect(again).toMatchObject({ skipped: 4, mapChanges: 0, canImport: true });
  });
  it('requires explicit updates for differing IDs and retains the old question snapshot', async () => {
    const old = { ...sourceQuestions[2], version: 2, source: 'Existing local edit' };
    await db('location_questions').where({ id: old.id }).update({ payload: JSON.stringify(old) }); await db('location_versions').insert({ key: `question:${old.id}:2`, payload: JSON.stringify(old) });
    const preview = await stage(); expect(preview.canImport).toBe(false); expect(preview.conflicts).toEqual([{ id: old.id, code: 'LOCATION_BANK_QUESTION_CONFLICT' }]);
    await expect(importBank(preview.token, userId, preview.fingerprint, false)).rejects.toMatchObject({ code: 'LOCATION_BANK_CONFLICT' });
    const allowed = await previewBank(preview.token, userId, true); expect(allowed).toMatchObject({ updated: 1, skipped: 3, canImport: true }); await importBank(allowed.token, userId, allowed.fingerprint, true);
    expect(JSON.parse((await db('location_questions').where({ id: old.id }).first()).payload)).toMatchObject({ version: 3, source: sourceQuestions[2].source }); expect(JSON.parse((await db('location_versions').where({ key: `question:${old.id}:2` }).first()).payload).source).toBe('Existing local edit');
  });
  it('rejects stale previews and another administrator without changing question counts', async () => {
    const preview = await stage(); await expect(previewBank(preview.token, userId + 1, false)).rejects.toMatchObject({ status: 404 });
    await db('location_maps').where({ id: mapId }).update({ payload: JSON.stringify({ ...sourceMaps[1], enabled: false }) });
    await expect(importBank(preview.token, userId, preview.fingerprint, false)).rejects.toMatchObject({ code: 'LOCATION_BANK_CHANGED' });
    expect(await db('location_questions').where('id', 'like', 'test_bank_%').count('* as count').first()).toMatchObject({ count: 4 });
  });
  it('rejects missing files, corrupted images and traversal entries before importing', async () => {
    const entries = await zipEntries(archive); const image = [...entries.keys()].find(name => name.startsWith('assets/'))!;
    const missing = new Map(entries); missing.delete(image); await expect(stage(await repack(missing))).rejects.toMatchObject({ code: 'LOCATION_BANK_INVALID' });
    const corrupt = new Map(entries); corrupt.set(image, Buffer.from('not the image')); await expect(stage(await repack(corrupt))).rejects.toMatchObject({ code: 'LOCATION_BANK_INVALID' });
    const unsafe = Buffer.from(archive.toString('latin1').split(image).join('../' + 'x'.repeat(image.length - 3)), 'latin1'); await expect(stage(unsafe)).rejects.toMatchObject({ code: 'LOCATION_BANK_INVALID' });
    expect(await db('location_questions').where('id', 'like', 'test_bank_%').count('* as count').first()).toMatchObject({ count: 4 });
  });
  it('rolls back the entire catalog on DB failure and permits retry of the same staged import', async () => {
    const preview = await stage(); await clearCatalog(); const target = await previewBank(preview.token, userId, false);
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementationOnce((async (handler: any) => transaction(async trx => { await handler(trx); throw new Error('simulated persistence failure'); })) as any);
    await expect(importBank(target.token, userId, target.fingerprint, false)).rejects.toThrow('simulated persistence failure'); spy.mockRestore();
    expect(await db('location_questions').where('id', 'like', 'test_bank_%').count('* as count').first()).toMatchObject({ count: 0 });
    expect(await db('location_maps').where({ id: mapId }).first()).toBeUndefined(); expect(await db('location_versions').where({ key: `bank:${target.token}` }).first()).toBeUndefined();
    expect(await importBank(target.token, userId, target.fingerprint, false)).toMatchObject({ added: 4 });
  });
  it('protects HTTP transfer endpoints and accepts binary ZIP without the generic JSON limit', async () => {
    expect((await fetch(base + '/bank/export')).status).toBe(401);
    const download = await fetch(base + '/bank/export', { headers: { Cookie: cookie } }); expect(download.status).toBe(200); expect(download.headers.get('content-disposition')).toContain('.zip');
    const bytes = Buffer.from(await download.arrayBuffer()); const response = await fetch(base + '/bank/preview', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/zip' }, body: bytes }); expect(response.status).toBe(200);
    const preview = await response.json(); tokens.add(preview.token); expect(preview).toMatchObject({ skipped: 4, canImport: true });
    const applied = await fetch(base + '/bank/import', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: preview.token, fingerprint: preview.fingerprint, updateQuestions: false }) }); expect(applied.status).toBe(200); expect(await applied.json()).toMatchObject({ skipped: 4 });
  });
});
