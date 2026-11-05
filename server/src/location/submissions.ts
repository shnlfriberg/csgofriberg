import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { db } from '../db/knex';
import { HttpError } from '../middleware/common';
import { guestNameFromKey, userNameFromUsername } from '../services/identityDisplay';
import { assetPath, uploadAsset } from './assets';
import { withKeyLock } from './lock';
import { maps } from './store';
import { saveQuestion } from './admin/questions';
import { guessSchema } from './validation';
import type { ContributorBoard, Identity, LocationSubmission, SubmissionPage } from './types';
import { queueAssetRemoval, flushAssetRemovals } from './assetTasks';
import { SUBMISSION_LIMITS } from '@friberg/location-core';

export const submissionInput = z.object({
  id: z.string().uuid(), mapId: guessSchema.shape.mapId, floorId: guessSchema.shape.floorId,
  u: z.coerce.number().finite().min(0).max(1), v: z.coerce.number().finite().min(0).max(1),
  mapVersion: z.coerce.number().int().positive(), note: z.string().trim().max(500).default(''),
  pointId: z.string().uuid().optional(),
}).strict();
export const submissionPageQuery = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) });
export const submissionReview = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('reject') }).strict(),
  guessSchema.extend({ decision: z.literal('approve'), tier: z.enum(['easy', 'medium', 'hard']),
    mapVersion: z.number().int().positive(), verified: z.literal(true),
    existingPoint: z.object({ capturePointId: z.string().min(1).max(160), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  }).strict(),
]);

async function removeImages(value: Pick<LocationSubmission, 'imageUrl' | 'thumbnailUrl'>) {
  await Promise.all([value.imageUrl, value.thumbnailUrl].map(url => fs.rm(assetPath(url), { force: true })));
}

export async function createSubmission(owner: Identity, input: z.infer<typeof submissionInput>, bytes: Buffer) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new HttpError(400, 'LOCATION_INVALID_ASSET');
  const fingerprint = createHash('sha256').update(bytes).update(JSON.stringify(input)).digest('hex');
  return withKeyLock('location:submissions', async () => {
    for (const table of ['location_submissions', 'location_contributions']) {
      const existing = await db(table).where({ id: input.id }).first();
      if (!existing) continue;
      if (existing.identity_key !== owner.key) throw new HttpError(404, 'LOCATION_SUBMISSION_NOT_FOUND');
      if (existing.request_hash !== fingerprint) throw new HttpError(409, 'LOCATION_STALE_STATE');
      return { id: input.id, status: table === 'location_submissions' ? 'pending' : 'accepted' };
    }
    const count = await db('location_submissions').where({ identity_key: owner.key }).count({ count: '*' }).first();
    if (Number(count?.count) >= SUBMISSION_LIMITS.pending) throw new HttpError(429, 'LOCATION_SUBMISSION_LIMIT');
    const map = (await maps()).find(item => item.id === input.mapId && item.enabled);
    if (!map || !map.floors.some(f => f.id === input.floorId && f.radarUrl)) throw new HttpError(400, 'LOCATION_INVALID_GUESS');
    if (map.version !== input.mapVersion) throw new HttpError(409, 'LOCATION_CAPTURE_MAP_CHANGED');
    const asset = await uploadAsset(bytes);
    // Never accept a catalog point ID from a public client. Persist the group now
    // so guest-to-account claims do not split images submitted in the same batch.
    const { pointId, ...details } = input;
    const capturePointId = pointId ? 'community-' + createHash('sha256')
      .update(JSON.stringify([owner.key, pointId, input.mapId, input.floorId, input.mapVersion, input.u, input.v]))
      .digest('hex').slice(0, 40) : undefined;
    const value: LocationSubmission = { ...details, ...(capturePointId ? { capturePointId } : {}), submitterName: owner.name,
      imageUrl: asset.url, thumbnailUrl: asset.thumbnailUrl, imageHash: asset.hash, createdAt: new Date().toISOString() };
    try {
      // The catalog lock also serializes duplicate checks with normal admin edits/imports.
      await withKeyLock('location:catalog', async () => {
        const current = (await maps()).find(item => item.id === input.mapId && item.enabled);
        if (!current || current.version !== input.mapVersion) throw new HttpError(409, 'LOCATION_CAPTURE_MAP_CHANGED');
        if (await db('location_questions').where({ image_hash: asset.hash }).first() ||
            await db('location_submissions').where({ image_hash: asset.hash }).first())
          throw new HttpError(409, 'LOCATION_DUPLICATE_IMAGE');
        await db('location_submissions').insert({ id: input.id, identity_key: owner.key, user_id: owner.userId,
          guest_key: owner.userId === null ? owner.key.slice(2) : null, name: owner.name,
          image_hash: asset.hash, request_hash: fingerprint, created_at: Date.now(), payload: JSON.stringify(value) });
      });
      return { id: input.id, status: 'pending' };
    } catch (error) { await removeImages(value); throw error; }
  });
}

export async function listSubmissions(page: number, owner?: string): Promise<SubmissionPage> {
  const query = db('location_submissions');
  if (owner) query.where({ identity_key: owner });
  const total = Number((await query.clone().count({ count: '*' }).first())?.count || 0);
  const rows = await query.orderBy('created_at', 'asc').orderBy('id').limit(12).offset((page - 1) * 12).select('payload', 'name');
  return { items: rows.map(row => ({ ...JSON.parse(row.payload), submitterName: row.name })), total, page, pageSize: 12 };
}

export async function acceptedSubmissionCount(owner?: string): Promise<number> {
  const query = db('location_contributions');
  if (owner) query.where({ identity_key: owner });
  return Number((await query.count({ count: '*' }).first())?.count || 0);
}

export async function reviewSubmission(id: string, input: z.infer<typeof submissionReview>) {
  return withKeyLock('location:submissions', async () => {
    const credit = await db('location_contributions').where({ id }).first();
    if (credit && input.decision === 'approve') return { accepted: true, questionId: credit.question_id };
    if (credit) throw new HttpError(409, 'LOCATION_SUBMISSION_REVIEWED');
    const row = await db('location_submissions').where({ id }).first();
    if (!row) throw new HttpError(404, 'LOCATION_SUBMISSION_NOT_FOUND');
    const value: LocationSubmission = JSON.parse(row.payload);
    if (input.decision === 'reject') {
      await db.transaction(async trx => {
        await queueAssetRemoval(trx, [value.imageUrl, value.thumbnailUrl]);
        await trx('location_submissions').where({ id }).delete();
      });
      await flushAssetRemovals().catch((error) => console.error('[location:asset-removal]', error));
      return { accepted: false };
    }
    const map = (await maps()).find(item => item.id === input.mapId && item.enabled);
    if (!map || !map.floors.some(f => f.id === input.floorId && f.radarUrl)) throw new HttpError(400, 'LOCATION_INVALID_GUESS');
    if (map.version !== input.mapVersion) throw new HttpError(409, 'LOCATION_CAPTURE_MAP_CHANGED');
    // A reviewer may correct individual pictures to different answers. Group only
    // matching reviewed positions; saveQuestion must never silently snap a newly
    // reviewed answer to a sibling that was accepted with different coordinates.
    const pointGroup = value.capturePointId ? 'community-' + createHash('sha256')
      .update(JSON.stringify([value.capturePointId, input.mapId, input.floorId, input.mapVersion, input.u, input.v]))
      .digest('hex').slice(0, 40) : `community-${id}`;
    const question = await saveQuestion({
      id: `submission-${id}`, capturePointId: input.existingPoint?.capturePointId || pointGroup, mapId: input.mapId, floorId: input.floorId,
      u: input.u, v: input.v, mapVersion: input.mapVersion, tier: input.tier, status: 'published',
      imageUrl: value.imageUrl, thumbnailUrl: value.thumbnailUrl, imageHash: value.imageHash,
      capturedAt: value.createdAt, build: '', source: `投稿 / ${row.name}`,
    }, undefined, { expectedMapVersion: input.mapVersion, existingPointFingerprint: input.existingPoint?.fingerprint, onSaved: async (trx, saved) => {
      await trx('location_contributions').insert({ id, identity_key: row.identity_key, user_id: row.user_id,
        guest_key: row.guest_key, name: row.name, question_id: saved.id, request_hash: row.request_hash, accepted_at: Date.now() });
      await trx('location_submissions').where({ id }).delete();
    } });
    return { accepted: true, questionId: question.id };
  });
}

export async function claimSubmissions(guestKey: string, userId: number, name: string): Promise<number> {
  return withKeyLock('location:submissions', () => db.transaction(async trx => {
    let claimed = 0;
    for (const table of ['location_submissions', 'location_contributions']) {
      claimed += Number(await trx(table).where({ identity_key: `g:${guestKey}` })
        .update({ identity_key: `u:${userId}`, user_id: userId, guest_key: null, name }));
    }
    return claimed;
  }));
}

export async function contributorLeaderboard(owner: Identity, page: number): Promise<ContributorBoard> {
  const counts = db('location_contributions as c')
    .leftJoin('users as u', 'u.id', 'c.user_id').leftJoin('guest_accounts as g', 'g.guest_key', 'c.guest_key')
    .where(q => q.whereNull('c.user_id').orWhere('u.leaderboard_hidden', false))
    .whereNull('u.banned_at').whereNull('g.banned_at')
    .select('c.identity_key', 'c.user_id', 'c.guest_key', 'u.username').min({ name: 'c.name' })
    .groupBy('c.identity_key', 'c.user_id', 'c.guest_key', 'u.username').count({ accepted: 'c.id' });
  const ranked = () => db.with('ranked', db.from(counts.clone().as('counts')).select('*', db.raw('rank() over (order by accepted desc) as rank'))).from('ranked');
  const [rows, own] = await Promise.all([
    ranked().orderBy('accepted', 'desc').orderBy('identity_key').offset((page - 1) * 50).limit(51),
    ranked().where({ identity_key: owner.key }).first(),
  ]);
  return { items: rows.slice(0, 50).map(row => ({
    id: createHash('sha256').update(row.identity_key).digest('hex').slice(0, 24),
    displayId: row.username ? userNameFromUsername(row.username) : row.guest_key ? guestNameFromKey(row.guest_key) : row.name,
    accepted: Number(row.accepted), rank: Number(row.rank), me: row.identity_key === owner.key,
  })), currentUser: { displayId: owner.name, accepted: await acceptedSubmissionCount(owner.key), rank: own ? Number(own.rank) : null },
  page, hasNext: rows.length > 50 };
}
