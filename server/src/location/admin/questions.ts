import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { Knex } from 'knex';
import { db } from '../../db/knex';
import { HttpError } from '../../middleware/common';
import { withKeyLock } from '../lock';
import { verifyAsset, assetPath } from '../assets';
import { savePointModels } from '../pointStore';
import { maps } from '../store';
import { captureImages, sameCapturePoint, sameWorldPosition } from '../capturePoints';
import {
  worldToRadar,
  coordinateDistance,
  COORDINATE_TOLERANCE,
} from '../coordinates';
import { questionSchema } from '../validation';
import type { Question, CaptureDraft } from '../types';
import { readPointGroups, pointFingerprint, existingPointPosition } from './pointCatalog';

export async function saveQuestion(
  input: z.infer<typeof questionSchema>,
  capture?: { id: string; version: number; imageId?: string },
  options: { pendingOnly?: boolean; expectedMapVersion?: number; existingPointFingerprint?: string; onSaved?: (trx: Knex.Transaction, question: Question) => Promise<void> } = {}
): Promise<Question> {
  const id = input.id || randomUUID();
  // Assets are immutable UUID files; expensive hashing need not hold the catalog lock.
  if ((await verifyAsset(input.imageUrl)) !== input.imageHash)
    throw new HttpError(400, 'LOCATION_INVALID_ASSET');
  await verifyAsset(input.thumbnailUrl);
  return withKeyLock('location:catalog', () =>
    withKeyLock(`location:question:${id}`, async () => {
      // A committed rejection may have removed an unreferenced file while hashing.
      try { await Promise.all([fs.access(assetPath(input.imageUrl)), fs.access(assetPath(input.thumbnailUrl))]); }
      catch { throw new HttpError(400, 'LOCATION_INVALID_ASSET'); }
      const row = await db('location_questions').where({ id }).first();
      const previous: Question | null = row ? JSON.parse(row.payload) : null;
      if (options.pendingOnly && (!previous || !['draft', 'review'].includes(previous.status)))
        throw new HttpError(409, 'LOCATION_QUESTION_NOT_PENDING');
      const allCapturePoints = (await db('location_capture_drafts').where({ map_id: input.mapId, point_id: input.capturePointId }).select('payload'))
        .map((row) => JSON.parse(row.payload) as CaptureDraft);
      const idCandidates = !capture && !previous ? (await db('location_capture_drafts')
        .where('id', id).orWhereRaw("payload like ? escape '\\'", [`%${id.replace(/[\\%_]/g, '\\$&')}%`]).select('payload'))
        .map(row => JSON.parse(row.payload) as CaptureDraft) : [];
      if (
        !capture &&
        !previous &&
        idCandidates.some((point) => point.id === id || captureImages(point).some((image) => image.id === id))
      )
        throw new HttpError(409, 'LOCATION_STALE_STATE');
      let captureMapVersion: number | undefined;
      let capturePoint: CaptureDraft | undefined;
      if (capture) {
        const draftRow = await db('location_capture_drafts')
          .where({ id: capture.id })
          .first();
        if (!draftRow) {
          if (previous && sameCapturePoint(previous, input) && previous.imageHash === input.imageHash) return previous;
          throw new HttpError(404, 'LOCATION_CAPTURE_NOT_FOUND');
        }
        const draft: CaptureDraft = JSON.parse(draftRow.payload);
        capturePoint = draft;
        captureMapVersion = draft.mapVersion;
        if (
          input.mapId !== draft.mapId ||
          input.floorId !== draft.floorId ||
          input.capturePointId !== draft.capturePointId
        )
          throw new HttpError(400, 'LOCATION_INVALID_GUESS');
        const image = captureImages(draft).find((image) => image.id === (capture.imageId || draft.id));
        if (!image && previous && sameCapturePoint(previous, draft) && previous.imageHash === input.imageHash)
          return previous;
        if (draft.version !== capture.version)
          throw new HttpError(409, 'LOCATION_STALE_STATE');
        if (!image)
          throw new HttpError(400, 'LOCATION_CAPTURE_IMAGE_REQUIRED');
      }
      if (previous && input.version !== previous.version)
        throw new HttpError(409, 'LOCATION_STALE_STATE');
      const map = (await maps()).find((item) => item.id === input.mapId);
      if (!map || !map.floors.some((floor) => floor.id === input.floorId))
        throw new HttpError(400, 'LOCATION_INVALID_GUESS');
      if (options.expectedMapVersion !== undefined && map.version !== options.expectedMapVersion)
        throw new HttpError(409, 'LOCATION_CAPTURE_MAP_CHANGED');
      // Bulk publication cannot stand in for reviewing an answer on a new map.
      if (options.pendingOnly && previous?.mapVersion !== map.version)
        throw new HttpError(409, 'LOCATION_CAPTURE_MAP_CHANGED');
      if (
        captureMapVersion !== undefined &&
        captureMapVersion !== map.version &&
        input.mapVersion !== map.version
      )
        throw new HttpError(409, 'LOCATION_CAPTURE_MAP_CHANGED');

      const siblings = (await db('location_questions').where({ map_id: input.mapId, point_id: input.capturePointId }).select('payload'))
        .map((row) => JSON.parse(row.payload) as Question)
        .filter((q) => q.id !== id && sameCapturePoint(q, input));
      const anchors = allCapturePoints.filter((p) => sameCapturePoint(p, input));
      const anchor = anchors.find((p) => p.world) || siblings.find((q) => q.world);
      if ([...siblings, ...anchors].some((q) => q.floorId !== input.floorId))
        throw new HttpError(400, 'LOCATION_CAPTURE_POSITION_MISMATCH');
      if (options.existingPointFingerprint) {
        // Validate under the SAME catalog lock as publication, so a removed/merged
        // target can never silently turn into a newly created point.
        const group = (await readPointGroups(db, input.mapId, [input.capturePointId])).get(input.capturePointId);
        if (!group?.questions.length || pointFingerprint(group) !== options.existingPointFingerprint)
          throw new HttpError(409, 'LOCATION_STALE_STATE');
        if ([...group.questions, ...group.drafts].some(p => p.floorId !== input.floorId || p.mapVersion !== map.version))
          throw new HttpError(409, 'LOCATION_CAPTURE_MAP_CHANGED');
        const position = existingPointPosition(group, map);
        if (![position.u, position.v].every(n => Number.isFinite(n) && n >= 0 && n <= 1))
          throw new HttpError(400, 'LOCATION_INVALID_GUESS');
        input = { ...input, ...position };
      } else if (anchor?.world) {
        if (input.world && !sameWorldPosition(input.world, anchor.world))
          throw new HttpError(400, 'LOCATION_CAPTURE_POSITION_MISMATCH');
        input = { ...input, world: anchor.world, ...worldToRadar(map, anchor.world) };
      } else {
        // Unmeasured drafts also share one radar answer. The first measured
        // screenshot establishes the permanent world position for the point.
        const reference = siblings.find((q) => q.mapVersion === map.version) || anchors.find((p) => p.mapVersion === map.version);
        if (reference && !input.world) input = { ...input, u: reference.u, v: reference.v };
      }
      if (
        input.world &&
        coordinateDistance(worldToRadar(map, input.world), input) >
          COORDINATE_TOLERANCE
      )
        throw new HttpError(400, 'LOCATION_COORDINATE_MISMATCH');
      const duplicate = await db('location_questions')
        .where({ image_hash: input.imageHash })
        .whereNot('id', id)
        .first();
      if (duplicate) throw new HttpError(409, 'LOCATION_DUPLICATE_IMAGE');
      const question: Question = {
        ...input,
        id,
        version: (previous?.version || 0) + 1,
        mapVersion: map.version,
      };
      await db.transaction(async (trx) => {
        await savePointModels(trx, [question]);
        await trx('location_questions')
          .insert({
            id,
            image_hash: question.imageHash,
            payload: JSON.stringify(question),
          })
          .onConflict('id')
          .merge();
        await trx('location_versions').insert({
          key: `question:${id}:${question.version}`,
          payload: JSON.stringify(question),
        });
        for (const anchorPoint of options.existingPointFingerprint ? [] : anchors) {
          if (capture && capturePoint && anchorPoint.id === capture.id) {
            const { asset: legacy, ...rest } = capturePoint;
            const next: CaptureDraft = {
              ...rest,
              images: captureImages(capturePoint).filter((image) => image.id !== (capture.imageId || capturePoint.id)),
              u: question.u, v: question.v, mapVersion: map.version,
              ...(question.world ? { world: question.world } : {}),
              version: capturePoint.version + 1,
            };
            await trx('location_capture_drafts').where({ id: capture.id }).update({ payload: JSON.stringify(next) });
          } else if (question.world) {
            const next: CaptureDraft = { ...anchorPoint, world: question.world, u: question.u, v: question.v, mapVersion: map.version, version: anchorPoint.version + 1 };
            await trx('location_capture_drafts').where({ id: anchorPoint.id }).update({ payload: JSON.stringify(next) });
          }
        }
        if (!anchor?.world && question.world) {
          for (const sibling of siblings) {
            const normalized: Question = { ...sibling, world: question.world, u: question.u, v: question.v, mapVersion: map.version, version: sibling.version + 1 };
            await trx('location_questions').where({ id: sibling.id }).update({ payload: JSON.stringify(normalized) });
            await trx('location_versions').insert({ key: `question:${sibling.id}:${normalized.version}`, payload: JSON.stringify(normalized) });
          }
        }
        await options.onSaved?.(trx, question);
      });
      return question;
    })
  );
}

export async function publishQuestions(targets: Array<{ id: string; version: number }>) {
  const results: Array<
    | { id: string; capturePointId: string; ok: true }
    | { id: string; capturePointId: string; ok: false; code: string }
  > = [];
  for (const target of targets) {
    let capturePointId = target.id;
    try {
      const row = await db('location_questions').where({ id: target.id }).first();
      if (!row) throw new HttpError(404, 'LOCATION_QUESTION_NOT_FOUND');
      const stored: Question = JSON.parse(row.payload);
      capturePointId = stored.capturePointId;
      const input = questionSchema.safeParse({ ...stored, version: target.version, status: 'published' });
      if (!input.success) throw new HttpError(400, 'VALIDATION_FAILED');
      await saveQuestion(input.data, undefined, { pendingOnly: true });
      results.push({ id: target.id, capturePointId, ok: true });
    } catch (error) {
      results.push({ id: target.id, capturePointId, ok: false,
        code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' });
    }
  }
  return { results };
}
