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
import { assetPath, uploadAsset } from '../../src/location/assets';
import { STARTER_MAPS } from '../../src/location/schema';
import { exportBank, importBank, stageBank } from '../../src/location/bank';
import { pool } from '../../src/location/store';
import type {
  CaptureAsset,
  CaptureDraft,
  MapDefinition,
} from '../../src/location/types';

describe('persistent capture plans', () => {
  let server: ReturnType<express.Express['listen']>;
  let url: string;
  let cookie: string;
  let userId: number;
  let asset: CaptureAsset;
  const map: MapDefinition = {
    ...structuredClone(STARTER_MAPS[0]),
    id: `test_capture_${randomUUID().slice(0, 8)}`,
  };
  const ids: string[] = [];
  const extraAssets: CaptureAsset[] = [];
  const point = (order: number) => {
    const id = randomUUID();
    ids.push(id);
    return {
      id,
      mapId: map.id,
      floorId: map.floors[0].id,
      u: 0.2 + order / 100,
      v: 0.4,
      batchId: batch,
      batchName: 'TEST ONLY batch',
      order,
      capturePointId: `test-point-${order}`,
    };
  };
  const batch = randomUUID();
  async function req(route: string, body?: unknown, method = 'POST') {
    const response = await fetch(url + route, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  beforeAll(async () => {
    await initDb();
    const users = await db('users')
      .insert({
        username: `capture_${randomUUID()}`,
        password_hash: 'unused',
        role: 'admin',
      })
      .returning('id');
    userId = Number(typeof users[0] === 'object' ? users[0].id : users[0]);
    cookie = `csgofriberg_session=${signToken({ id: userId, token_version: 0 })}`;
    await db('location_maps').insert({
      id: map.id,
      payload: JSON.stringify(map),
    });
    await db('location_versions').insert({
      key: `map:${map.id}:${map.version}`,
      payload: JSON.stringify(map),
    });
    const png = await sharp({
      create: {
        width: 1920,
        height: 1080,
        channels: 3,
        background: { r: 37, g: 61, b: 83 },
      },
    })
      .png()
      .toBuffer();
    const uploaded = await uploadAsset(png);
    asset = {
      url: uploaded.url,
      thumbnailUrl: uploaded.thumbnailUrl,
      hash: uploaded.hash,
    };
    const app = express();
    app.use('/admin', adminLocationRoutes);
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as any).port}/admin`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db('location_capture_drafts').whereIn('id', ids).delete();
    await db('location_questions').whereIn('id', ids).delete();
    for (const id of ids)
      await db('location_versions')
        .where('key', 'like', `question:${id}:%`)
        .delete();
    await db('location_maps').where({ id: map.id }).delete();
    await db('location_versions')
      .where('key', 'like', `map:${map.id}:%`)
      .delete();
    await db('users').where({ id: userId }).delete();
    await Promise.all(
      [asset, ...extraAssets].flatMap((item) => [
        unlink(assetPath(item.url)),
        unlink(assetPath(item.thumbnailUrl)),
      ])
    );
  });
  it('requires an administrator and persists image-free points idempotently without entering the playable pool', async () => {
    expect((await fetch(url + '/capture-drafts')).status).toBe(401);
    const points = [point(1), point(2)];
    const saved = await req('/capture-drafts', { points });
    expect(saved.status).toBe(200);
    expect(saved.data.items).toHaveLength(2);
    expect(saved.data.items[0]).not.toHaveProperty('asset');
    expect((await req('/capture-drafts', { points })).data.items).toEqual(
      saved.data.items
    );
    expect((await req('/capture-drafts', undefined, 'GET')).data.items).toEqual(
      expect.arrayContaining(saved.data.items)
    );
    expect((await pool()).some((item) => ids.includes(item.question.id))).toBe(
      false
    );
    expect(
      (await req('/capture-drafts', { points: [{ ...points[0], u: 0.9 }] }))
        .status
    ).toBe(409);
  });
  it('rejects an invalid batch without saving its other points', async () => {
    const valid = point(3);
    const invalid = { ...point(4), floorId: 'nonexistent' };
    expect(
      (await req('/capture-drafts', { points: [valid, invalid] })).status
    ).toBe(400);
    expect(
      await db('location_capture_drafts').where({ id: valid.id }).first()
    ).toBeUndefined();
  });
  it('binds images with version checks and retains the point after completing its image', async () => {
    const input = point(5);
    const saved = (await req('/capture-drafts', { points: [input] })).data
      .items[0] as CaptureDraft;
    const failed = await req(
      `/capture-drafts/${saved.id}/asset`,
      { version: 99, asset },
      'PATCH'
    );
    expect(failed.status).toBe(409);
    const attached = await req(
      `/capture-drafts/${saved.id}/asset`,
      { version: saved.version, asset },
      'PATCH'
    );
    expect(attached.status).toBe(200);
    expect(attached.data.asset.hash).toBe(asset.hash);
    expect(
      (
        await req(
          `/capture-drafts/${saved.id}/asset`,
          { version: saved.version, asset },
          'PATCH'
        )
      ).data.version
    ).toBe(attached.data.version);
    const question = {
      mapId: input.mapId,
      floorId: input.floorId,
      u: input.u,
      v: input.v,
      capturePointId: input.capturePointId,
      tier: 'hard',
      status: 'draft',
      imageUrl: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
      imageHash: asset.hash,
      capturedAt: new Date().toISOString(),
      build: 'TEST ONLY',
      source: 'Isolated capture workflow test',
    };
    expect(
      (
        await req(`/capture-drafts/${saved.id}/complete`, {
          version: saved.version,
          question,
        })
      ).status
    ).toBe(409);
    expect(
      (
        await req(`/capture-drafts/${saved.id}/complete`, {
          version: attached.data.version,
          question: { ...question, floorId: 'wrong' },
        })
      ).status
    ).toBe(400);
    const result = await req(`/capture-drafts/${saved.id}/complete`, {
      version: attached.data.version,
      question,
    });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({
      id: saved.id,
      capturePointId: input.capturePointId,
      tier: 'hard',
      u: input.u,
      v: input.v,
    });
    expect(
      await db('location_capture_drafts').where({ id: saved.id }).first()
    ).toBeDefined();
    const retried = await req(`/capture-drafts/${saved.id}/complete`, {
      version: attached.data.version,
      question,
    });
    expect(retried.data.version).toBe(1);
    expect((await pool()).some((item) => item.question.id === saved.id)).toBe(
      false
    );
  });
  it('backs up and restores unfinished points and attached images', async () => {
    const input = point(6);
    const saved = (await req('/capture-drafts', { points: [input] })).data
      .items[0];
    await req(
      `/capture-drafts/${saved.id}/asset`,
      { version: 1, asset },
      'PATCH'
    );
    const chunks: Buffer[] = [];
    await exportBank(
      new Writable({
        write(chunk, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      })
    );
    const preview = await stageBank(
      Readable.from(Buffer.concat(chunks)),
      userId
    );
    expect(preview.captureDrafts).toBeGreaterThanOrEqual(3);
    expect(preview.canImport).toBe(true);
    await db('location_capture_drafts').where({ id: saved.id }).delete();
    const { previewBank } = await import('../../src/location/bank');
    const refreshed = await previewBank(preview.token, userId, false);
    const result = await importBank(
      preview.token,
      userId,
      refreshed.fingerprint,
      false
    );
    expect(result.captureDrafts).toBe(1);
    const restored = JSON.parse(
      (await db('location_capture_drafts').where({ id: saved.id }).first())
        .payload
    );
    expect(restored).toMatchObject({
      capturePointId: input.capturePointId,
      u: input.u,
      asset: { hash: asset.hash },
    });
    expect(
      (await req(`/capture-drafts/${saved.id}`, { version: 99 }, 'DELETE'))
        .status
    ).toBe(409);
    expect(
      (
        await req(
          `/capture-drafts/${saved.id}`,
          { version: restored.version },
          'DELETE'
        )
      ).status
    ).toBe(200);
  });
  it('requires explicit position verification before completing a capture from an older map version', async () => {
    const input = point(7);
    await req('/capture-drafts', { points: [input] });
    const png = await sharp({
      create: {
        width: 1920,
        height: 1080,
        channels: 3,
        background: { r: 89, g: 121, b: 147 },
      },
    })
      .png()
      .toBuffer();
    const image = await uploadAsset(png);
    extraAssets.push(image);
    const attached = await req(`/capture-drafts/${input.id}/asset`, {
      version: 1,
      asset: { url: image.url, thumbnailUrl: image.thumbnailUrl, hash: image.hash },
    }, 'PATCH');
    expect(attached.status).toBe(200);
    const updatedMap = { ...map, version: map.version + 1 };
    await db('location_maps')
      .where({ id: map.id })
      .update({ payload: JSON.stringify(updatedMap) });
    await db('location_versions').insert({
      key: `map:${map.id}:${updatedMap.version}`,
      payload: JSON.stringify(updatedMap),
    });
    const question = {
      mapId: input.mapId,
      floorId: input.floorId,
      u: input.u,
      v: input.v,
      capturePointId: input.capturePointId,
      tier: 'medium',
      status: 'draft',
      imageUrl: image.url,
      thumbnailUrl: image.thumbnailUrl,
      imageHash: image.hash,
      capturedAt: new Date().toISOString(),
      build: 'TEST ONLY',
      source: 'Isolated stale map regression',
    };
    const rejected = await req(`/capture-drafts/${input.id}/complete`, {
      version: attached.data.version,
      question,
    });
    expect(rejected.status).toBe(409);
    expect(rejected.data.code).toBe('LOCATION_CAPTURE_MAP_CHANGED');
    expect(
      await db('location_capture_drafts').where({ id: input.id }).first()
    ).toBeDefined();
    const completed = await req(`/capture-drafts/${input.id}/complete`, {
      version: attached.data.version,
      question: { ...question, mapVersion: updatedMap.version },
    });
    expect(completed.status).toBe(200);
    expect(completed.data.mapVersion).toBe(updatedMap.version);
    expect(
      await db('location_capture_drafts').where({ id: input.id }).first()
    ).toBeDefined();
  });
});
