import { captureImageIdExists } from './captureQueries';
import { db } from '../../db/knex';
import { HttpError } from '../../middleware/common';
import { maps } from '../store';
import { withKeyLock } from '../lock';
import { verifyAsset } from '../assets';
import { captureImages } from '../capturePoints';
import { savePointModels } from '../pointStore';
import type { CaptureAsset, CaptureDraft, CapturePointInput } from '../types';

export async function listCaptureDrafts(): Promise<CaptureDraft[]> {
  const rows = await db('location_capture_drafts').select('payload');
  return rows
    .map((row) => JSON.parse(row.payload) as CaptureDraft)
    .sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.order - b.order
    );
}

export async function saveCapturePoints(
  points: CapturePointInput[]
): Promise<CaptureDraft[]> {
  return withKeyLock('location:catalog', async () => {
    const catalog = await maps();
    const existing = new Map(
      (await db('location_capture_drafts').where(q => q.whereIn('map_id', [...new Set(points.map(p => p.mapId))]).orWhereIn('id', points.map(p => p.id))).select('payload')).map(row => { const draft = JSON.parse(row.payload) as CaptureDraft; return [draft.id, draft] as const; })
    );
    const completed = new Set(
      (
        await db('location_questions')
          .whereIn(
            'id',
            points.map((p) => p.id)
          )
          .select('id')
      ).map((row) => row.id)
    );
    const values = points.map((input) => {
      const map = catalog.find((m) => m.id === input.mapId);
      if (!map || !map.floors.some((f) => f.id === input.floorId))
        throw new HttpError(400, 'LOCATION_INVALID_GUESS');
      if (completed.has(input.id))
        throw new HttpError(409, 'LOCATION_STALE_STATE');
      const old = existing.get(input.id);
      if (old) {
        if (
          Object.entries(input).some(
            ([key, value]) => old[key as keyof CaptureDraft] !== value
          )
        ) {
          throw new HttpError(409, 'LOCATION_STALE_STATE');
        }
        return old;
      }
      if ([...existing.values(), ...points].some((p) => p.id !== input.id && p.mapId === input.mapId && p.capturePointId === input.capturePointId))
        throw new HttpError(409, 'LOCATION_CAPTURE_POINT_EXISTS');
      return {
        ...input,
        version: 1,
        mapVersion: map.version,
        createdAt: new Date().toISOString(),
      };
    });
    // Validate the entire batch before writing any of it. Retried UUIDs keep their original data.
    await db.transaction(async (trx) => {
      await savePointModels(trx, values);
      for (const value of values) {
        await trx('location_capture_drafts')
          .insert({ id: value.id, payload: JSON.stringify(value) })
          .onConflict('id')
          .ignore();
      }
    });
    return values;
  });
}

export async function attachCaptureAsset(
  id: string,
  version: number,
  asset: CaptureAsset
): Promise<CaptureDraft> {
  return withKeyLock('location:catalog', async () => {
    const row = await db('location_capture_drafts').where({ id }).first();
    if (!row) throw new HttpError(404, 'LOCATION_CAPTURE_NOT_FOUND');
    const draft: CaptureDraft = JSON.parse(row.payload);
    if ((await db('location_questions').where({ id }).first()))
      throw new HttpError(409, 'LOCATION_STALE_STATE');
    if (
      draft.asset?.url === asset.url &&
      draft.asset.thumbnailUrl === asset.thumbnailUrl &&
      draft.asset.hash === asset.hash
    )
      return draft;
    if (draft.version !== version)
      throw new HttpError(409, 'LOCATION_STALE_STATE');
    if ((await verifyAsset(asset.url)) !== asset.hash)
      throw new HttpError(400, 'LOCATION_INVALID_ASSET');
    await verifyAsset(asset.thumbnailUrl);
    const next = { ...draft, asset, version: draft.version + 1 };
    await db('location_capture_drafts')
      .where({ id })
      .update({ payload: JSON.stringify(next) });
    return next;
  });
}

export async function removeCaptureDraft(
  id: string,
  version: number
): Promise<void> {
  await withKeyLock('location:catalog', async () => {
    const row = await db('location_capture_drafts').where({ id }).first();
    if (row && JSON.parse(row.payload).version !== version)
      throw new HttpError(409, 'LOCATION_STALE_STATE');
    await db('location_capture_drafts').where({ id }).delete();
  });
}

export async function appendCaptureImage(
  id: string,
  version: number,
  imageId: string,
  asset: CaptureAsset
): Promise<CaptureDraft> {
  return withKeyLock('location:catalog', async () => {
    const row = await db('location_capture_drafts').where({ id }).first();
    if (!row) throw new HttpError(404, 'LOCATION_CAPTURE_NOT_FOUND');
    const point: CaptureDraft = JSON.parse(row.payload);
    const images = captureImages(point);
    const previous = images.find((image) => image.id === imageId);
    if (previous) {
      if (JSON.stringify(previous.asset) !== JSON.stringify(asset))
        throw new HttpError(409, 'LOCATION_STALE_STATE');
      return point;
    }
    if (point.version !== version) throw new HttpError(409, 'LOCATION_STALE_STATE');
    if (images.length >= 100) throw new HttpError(400, 'LOCATION_CAPTURE_IMAGE_LIMIT');
    if (images.some((image) => image.asset.hash === asset.hash))
      throw new HttpError(409, 'LOCATION_DUPLICATE_IMAGE');
    if (await db('location_questions').where({ image_hash: asset.hash }).first())
      throw new HttpError(409, 'LOCATION_DUPLICATE_IMAGE');
    if (
      (await db('location_questions').where({ id: imageId }).first()) ||
      (await captureImageIdExists(imageId))
    ) throw new HttpError(409, 'LOCATION_STALE_STATE');
    if ((await verifyAsset(asset.url)) !== asset.hash)
      throw new HttpError(400, 'LOCATION_INVALID_ASSET');
    await verifyAsset(asset.thumbnailUrl);
    const { asset: legacy, ...rest } = point;
    const next: CaptureDraft = { ...rest, images: [...images, { id: imageId, asset, createdAt: new Date().toISOString() }], version: point.version + 1 };
    await db('location_capture_drafts').where({ id }).update({ payload: JSON.stringify(next) });
    return next;
  });
}

export async function removeCaptureImage(id: string, imageId: string, version: number): Promise<CaptureDraft> {
  return withKeyLock('location:catalog', async () => {
    const row = await db('location_capture_drafts').where({ id }).first();
    if (!row) throw new HttpError(404, 'LOCATION_CAPTURE_NOT_FOUND');
    const point: CaptureDraft = JSON.parse(row.payload);
    if (point.version !== version) throw new HttpError(409, 'LOCATION_STALE_STATE');
    const images = captureImages(point);
    if (!images.some((image) => image.id === imageId)) return point;
    const { asset: legacy, ...rest } = point;
    const next = { ...rest, images: images.filter((image) => image.id !== imageId), version: point.version + 1 };
    await db('location_capture_drafts').where({ id }).update({ payload: JSON.stringify(next) });
    return next;
  });
}

