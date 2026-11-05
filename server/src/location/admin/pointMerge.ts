import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Knex } from 'knex';
import type { MergePoint, MergePointsInput, MergePointsResult } from '@friberg/location-core';
import { db } from '../../db/knex';
import { HttpError } from '../../middleware/common';
import { withKeyLock } from '../lock';
import { savePointModels } from '../pointStore';
import { captureImages } from '../capturePoints';
import type { CaptureDraft, MapDefinition, Question } from '../types';
import { readPointGroups as readGroups, existingPointPosition } from './pointCatalog';

export const mergePointQuery = z.object({ mapId: z.string().min(1).max(64), floorId: z.string().min(1).max(64) }).strict();
export const mergePointsSchema = mergePointQuery.extend({
  operationId: z.string().uuid(), mapVersion: z.number().int().positive(),
  u: z.number().min(0).max(1), v: z.number().min(0).max(1),
  points: z.array(z.object({ capturePointId: z.string().min(1).max(160), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
    .min(2).max(100).refine(points => new Set(points.map(p => p.capturePointId)).size === points.length),
}).strict();

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function readMap(connection: Knex, mapId: string, floorId: string): Promise<MapDefinition> {
  const row = await connection('location_maps').where({ id: mapId }).first('payload');
  const map: MapDefinition | undefined = row && JSON.parse(row.payload);
  if (!map?.floors.some(f => f.id === floorId)) throw new HttpError(400, 'LOCATION_INVALID_GUESS');
  return map;
}

export async function listMergePoints(mapId: string, floorId: string, questionsOnly = false): Promise<{ items: MergePoint[]; mapVersion: number }> {
  return withKeyLock('location:catalog', async () => {
    const map = await readMap(db, mapId, floorId);
    const groups = await readGroups(db, mapId);
    const items: MergePoint[] = [];
    for (const [capturePointId, group] of groups) {
      if (questionsOnly && !group.questions.length) continue;
      const members = [...group.questions, ...group.drafts];
      const anchor = members.find(p => p.floorId === floorId);
      if (!anchor) continue;
      const images = group.drafts.flatMap(captureImages);
      const position = questionsOnly ? existingPointPosition(group, map) : anchor;
      items.push({ mapId, floorId, capturePointId, u: position.u, v: position.v,
        fingerprint: hash(group), questions: group.questions.length, images: images.length,
        thumbnails: [...group.questions.map(q => q.thumbnailUrl), ...images.map(i => i.asset.thumbnailUrl)].slice(0, 3),
        eligible: members.every(p => p.floorId === floorId && p.mapVersion === map.version) &&
          Number.isFinite(position.u) && Number.isFinite(position.v) && position.u >= 0 && position.u <= 1 && position.v >= 0 && position.v <= 1,
      });
    }
    return { items: items.sort((a, b) => a.capturePointId.localeCompare(b.capturePointId)), mapVersion: map.version };
  });
}

export async function mergePoints(input: MergePointsInput): Promise<MergePointsResult> {
  return withKeyLock('location:catalog', () => db.transaction(async trx => {
    const receiptKey = `point-merge:${input.operationId}`;
    const requestHash = hash(input);
    const receipt = await trx('location_versions').where({ key: receiptKey }).first('payload');
    if (receipt) {
      const saved = JSON.parse(receipt.payload);
      if (saved.requestHash !== requestHash) throw new HttpError(409, 'LOCATION_STALE_STATE');
      return saved.result;
    }
    const map = await readMap(trx, input.mapId, input.floorId);
    if (map.version !== input.mapVersion) throw new HttpError(409, 'LOCATION_CAPTURE_MAP_CHANGED');
    const ids = input.points.map(p => p.capturePointId);
    const groups = await readGroups(trx, input.mapId, ids);
    for (const point of input.points) {
      const group = groups.get(point.capturePointId);
      if (!group || hash(group) !== point.fingerprint) throw new HttpError(409, 'LOCATION_STALE_STATE');
      if ([...group.questions, ...group.drafts].some(p => p.floorId !== input.floorId || p.mapVersion !== map.version))
        throw new HttpError(409, 'LOCATION_CAPTURE_MAP_CHANGED');
    }
    const questions = [...groups.values()].flatMap(g => g.questions);
    const drafts = [...groups.values()].flatMap(g => g.drafts);
    const images = drafts.flatMap(captureImages);
    // Keep all unsaved images, including legacy asset entries. Never truncate to fit a draft.
    if (images.length > 100) throw new HttpError(400, 'LOCATION_CAPTURE_IMAGE_LIMIT');
    if (new Set(images.map(i => i.id)).size !== images.length) throw new HttpError(409, 'LOCATION_STALE_STATE');
    const capturePointId = ids[0];
    const position = { mapId: input.mapId, floorId: input.floorId, mapVersion: map.version,
      capturePointId, u: input.u, v: input.v };
    for (const question of questions) {
      // A newly marked radar answer must not inherit obsolete measured XYZ coordinates.
      const { world: _world, ...rest } = question;
      const next: Question = { ...rest, ...position, version: question.version + 1 };
      await trx('location_versions').insert({ key: `question:${question.id}:${question.version}`, payload: JSON.stringify(question) }).onConflict('key').ignore();
      await trx('location_questions').where({ id: question.id }).update({ payload: JSON.stringify(next) });
      await trx('location_versions').insert({ key: `question:${next.id}:${next.version}`, payload: JSON.stringify(next) });
    }
    if (drafts.length) {
      const keeper = drafts.find(d => d.capturePointId === capturePointId) || drafts[0];
      const { asset: _asset, world: _world, ...rest } = keeper;
      const next: CaptureDraft = { ...rest, ...position, images, version: keeper.version + 1 };
      await trx('location_capture_drafts').where({ id: keeper.id }).update({ payload: JSON.stringify(next) });
      const removed = drafts.filter(d => d.id !== keeper.id).map(d => d.id);
      if (removed.length) await trx('location_capture_drafts').whereIn('id', removed).delete();
    }
    await savePointModels(trx, [position]);
    // Keep unused point models and their version sequence, as normal draft removal does.
    // Active points are derived from current questions/drafts, so retired sources no longer appear.
    const result = { capturePointId, points: ids.length, questions: questions.length, images: images.length };
    // Recoverable pre-merge metadata and the idempotency receipt live with existing version history.
    await trx('location_versions').insert({ key: receiptKey, payload: JSON.stringify({ requestHash, input, result, questions, drafts }) });
    return result;
  }));
}
