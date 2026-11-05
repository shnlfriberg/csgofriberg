import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/knex';
import { initDb } from '../../src/db/init';
import { config } from '../../src/config';
import { initRedis } from '../../src/redis';
import { signToken } from '../../src/middleware/auth';
import { errorHandler } from '../../src/middleware/common';
import { rejectOversizedBody } from '../../src/middleware/jsonBody';
import { assetPath } from '../../src/location/assets';
import { saveQuestion } from '../../src/location/admin/questions';
import { listMergePoints, mergePoints } from '../../src/location/admin/pointMerge';
import { adminLocationRoutes } from '../../src/location/admin/routes';
import submissionRoutes from '../../src/location/submissionRoutes';
import { acceptedSubmissionCount, claimSubmissions, contributorLeaderboard, createSubmission, listSubmissions, reviewSubmission } from '../../src/location/submissions';
import { locationStatistics } from '../../src/location/statistics';
import { pool } from '../../src/location/store';
import type { Identity, LocationSubmission } from '../../src/location/types';
import { SUBMISSION_LIMITS } from '@friberg/location-core';
import { testMap } from './fixtures';

describe('community question submissions', () => {
  const map = testMap(`test_submission_${randomUUID().slice(0, 8)}`);
  const guest: Identity = { key: `g:submit-${randomUUID()}`, userId: null, name: 'Guest contributor' };
  const other: Identity = { key: `g:submit-${randomUUID()}`, userId: null, name: 'Other guest' };
  const ids: string[] = []; const assets = new Set<string>(); const users: number[] = [];
  let server: http.Server; let base: string; let adminCookie: string; let regularCookie: string; let user: Identity;
  const input = (extra = {}) => { const id = randomUUID(); ids.push(id); return { id, mapId: map.id, floorId: map.floors[0].id, u: .25, v: .4, mapVersion: map.version, note: '真实墙面', ...extra }; };
  const picture = (color: string) => sharp({ create: { width: 800, height: 600, channels: 3, background: color } }).png().toBuffer();
  const approval = { decision: 'approve' as const, mapId: map.id, floorId: map.floors[0].id, u: .3, v: .6, mapVersion: map.version, tier: 'medium' as const, verified: true as const };
  async function remember(id: string) {
    const row = await db('location_submissions').where({ id }).first();
    if (row) { const v: LocationSubmission = JSON.parse(row.payload); assets.add(v.imageUrl); assets.add(v.thumbnailUrl); return v; }
    throw new Error('missing submission');
  }
  function cookie(owner: Identity) { return `csgofriberg_guest=${jwt.sign({ typ: 'guest', key: owner.key.slice(2) }, config.jwtSecret, { expiresIn: '1h' })}`; }
  beforeAll(async () => {
    await initDb(); await initRedis();
    await db('location_maps').insert({ id: map.id, payload: JSON.stringify(map) });
    for (const role of ['admin', 'user']) {
      const [created] = await db('users').insert({ username: `submission-${role}-${randomUUID().slice(0, 8)}`, password_hash: 'test', role }).returning(['id', 'username', 'token_version']);
      users.push(Number(created.id));
      const value = `csgofriberg_session=${signToken(created)}`;
      if (role === 'admin') adminCookie = value;
      else { regularCookie = value; user = { key: `u:${created.id}`, userId: Number(created.id), name: 'User contributor' }; }
    }
    const app = express();
    app.use('/api/location/submissions', submissionRoutes);
    app.use('/api/admin/location', adminLocationRoutes);
    app.use('/api', rejectOversizedBody(64 * 1024));
    app.use(errorHandler);
    server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await db('location_contributions').whereIn('id', ids).delete();
    await db('location_submissions').whereIn('id', ids).delete();
    for (const id of ids) {
      await db('location_versions').where('key', 'like', `question:submission-${id}:%`).delete();
      await db('location_questions').where({ id: `submission-${id}` }).delete();
    }
    await db('location_maps').where({ id: map.id }).delete();
    await db('users').whereIn('id', users).delete();
    await Promise.all([...assets].map(url => fs.rm(assetPath(url), { force: true })));
  });
  it('allows guest uploads larger than the generic body limit, crops them and isolates pending submissions', async () => {
    const data = input();
    const image = await sharp(randomBytes(640 * 640 * 3), { raw: { width: 640, height: 640, channels: 3 } }).png().toBuffer();
    expect(image.length).toBeGreaterThan(64 * 1024);
    const uploaded = await fetch(base + '/api/location/submissions?' + new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)])), {
      method: 'POST', headers: { Cookie: cookie(guest), 'Content-Type': 'image/png' }, body: image,
    });
    expect(uploaded.status).toBe(201); expect(await uploaded.json()).toMatchObject({ id: data.id, status: 'pending' });
    const value = await remember(data.id);
    expect(await sharp(assetPath(value.imageUrl)).metadata()).toMatchObject({ width: 360, height: 360 });
    expect((await pool()).some(q => q.question.imageHash === value.imageHash)).toBe(false);
    const own = await fetch(base + '/api/location/submissions', { headers: { Cookie: cookie(guest) } });
    expect((await own.json()).items).toHaveLength(1);
    expect((await listSubmissions(1, other.key)).items).toEqual([]);
    const forbidden = await fetch(base + '/api/admin/location/submissions', { headers: { Cookie: regularCookie } });
    expect(forbidden.status).toBe(403);
    const admin = await fetch(base + '/api/admin/location/submissions', { headers: { Cookie: adminCookie } });
    expect((await admin.json()).items.some((s: any) => s.id === data.id)).toBe(true);
  });
  it('deduplicates retries and cropped images, and rejects changed retries without orphan files', async () => {
    const data = input(); const image = await picture('#aabb33');
    await createSubmission(other, data, image); await remember(data.id);
    expect(await createSubmission(other, data, image)).toMatchObject({ status: 'pending' });
    await expect(createSubmission(other, { ...data, u: .8 }, image)).rejects.toThrow('LOCATION_STALE_STATE');
    await expect(createSubmission(guest, input(), image)).rejects.toThrow('LOCATION_DUPLICATE_IMAGE');
    expect((await db('location_submissions').where({ identity_key: other.key })).length).toBe(1);
  });
  it('deletes rejected records, screenshots and pins without granting any credit', async () => {
    const data = input(); await createSubmission(guest, data, await picture('#ce5511')); const value = await remember(data.id);
    await reviewSubmission(data.id, { decision: 'reject' });
    expect(await db('location_submissions').where({ id: data.id }).first()).toBeUndefined();
    await expect(fs.access(assetPath(value.imageUrl))).rejects.toThrow();
    await expect(fs.access(assetPath(value.thumbnailUrl))).rejects.toThrow();
    expect(await db('location_contributions').where({ id: data.id }).first()).toBeUndefined();
    expect(await db('location_questions').where({ id: `submission-${data.id}` }).first()).toBeUndefined();
  });
  it('requires admin difficulty and verification; accepts once under concurrent review and manages the result normally', async () => {
    const data = input(); await createSubmission(guest, data, await picture('#153388')); await remember(data.id);
    const review = (body: unknown) => fetch(base + `/api/admin/location/submissions/${data.id}/review`, { method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { tier, ...withoutTier } = approval;
    expect((await review(withoutTier)).status).toBe(400);
    expect((await review({ ...approval, verified: false })).status).toBe(400);
    expect((await review({ ...approval, mapVersion: map.version + 1 })).status).toBe(409);
    const results = await Promise.all([review(approval), review(approval)]);
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(await acceptedSubmissionCount(guest.key)).toBe(1);
    const question = JSON.parse((await db('location_questions').where({ id: `submission-${data.id}` }).first()).payload);
    expect(question).toMatchObject({ tier: 'medium', u: .3, v: .6, status: 'published' });
    expect((await pool()).some(q => q.question.id === question.id)).toBe(true);
    expect(await db('location_submissions').where({ id: data.id }).first()).toBeUndefined();
    await saveQuestion({ ...question, status: 'disabled' });
    expect(await acceptedSubmissionCount(guest.key)).toBe(1);
    await expect(reviewSubmission(data.id, { decision: 'reject' })).rejects.toThrow('LOCATION_SUBMISSION_REVIEWED');
  });
  it('ranks guests and players with ties, credits pending claims to the user, and never exposes guest identity keys', async () => {
    const userData = input(); await createSubmission(user, userData, await picture('#128890')); await remember(userData.id);
    await reviewSubmission(userData.id, approval);
    const board = await contributorLeaderboard(guest, 1);
    expect(board.currentUser).toMatchObject({ accepted: 1, rank: 1 });
    expect(board.items.filter(r => r.accepted === 1).every(r => r.rank === 1)).toBe(true);
    expect(JSON.stringify(board)).not.toContain(guest.key.slice(2));
    expect(await claimSubmissions(guest.key.slice(2), user.userId!, user.name)).toBe(2); // one pending and one accepted
    expect(await acceptedSubmissionCount(guest.key)).toBe(0);
    expect(await acceptedSubmissionCount(user.key)).toBe(2);
    const pending = (await listSubmissions(1, user.key)).items.find(r => r.id !== userData.id)!;
    await reviewSubmission(pending.id, approval);
    expect(await acceptedSubmissionCount(user.key)).toBe(3);
    expect(await claimSubmissions(guest.key.slice(2), user.userId!, user.name)).toBe(0);
    const stats = await locationStatistics(user.key, ['hard']);
    expect(stats.personal.acceptedSubmissions).toBe(3); // independent of played difficulty
    await db('users').where({ id: user.userId }).update({ leaderboard_hidden: true });
    expect((await contributorLeaderboard(user, 1)).items.some(r => r.me)).toBe(false);
    expect((await contributorLeaderboard(user, 1)).currentUser.accepted).toBe(3);
  });
  it('validates map versions, floors and image dimensions before leaving queue data', async () => {
    await expect(createSubmission(other, input({ mapVersion: 999 }), await picture('red'))).rejects.toThrow('LOCATION_CAPTURE_MAP_CHANGED');
    await expect(createSubmission(other, input({ floorId: 'missing' }), await picture('red'))).rejects.toThrow('LOCATION_INVALID_GUESS');
    const small = await sharp({ create: { width: 200, height: 200, channels: 3, background: 'red' } }).png().toBuffer();
    await expect(createSubmission(other, input(), small)).rejects.toThrow('LOCATION_CAPTURE_TOO_SMALL');
  });

  it('keeps same-point images together through claims and reviews, while separating corrected answers and other owners', async () => {
    const owner: Identity = { key: `g:batch-${randomUUID()}`, userId: null, name: 'Batch contributor' };
    const pointId = randomUUID();
    const first = input({ pointId }); const second = input({ pointId }); const corrected = input({ pointId });
    const foreign = input({ pointId });
    for (const [data, color, identity] of [
      [first, '#123abc', owner], [second, '#456abc', owner], [corrected, '#789abc', owner], [foreign, '#abcdef', other],
    ] as const) { await createSubmission(identity, data, await picture(color)); await remember(data.id); }
    const a = await remember(first.id); const b = await remember(second.id);
    expect(a.capturePointId).toBe(b.capturePointId);
    expect(a.capturePointId).not.toBe((await remember(foreign.id)).capturePointId);
    expect(await claimSubmissions(owner.key.slice(2), user.userId!, user.name)).toBe(3);
    await reviewSubmission(first.id, approval);
    await reviewSubmission(second.id, approval);
    await reviewSubmission(corrected.id, { ...approval, u: .8 });
    const readQuestion = async (id: string) => JSON.parse((await db('location_questions').where({ id: `submission-${id}` }).first()).payload);
    const q1 = await readQuestion(first.id); const q2 = await readQuestion(second.id); const q3 = await readQuestion(corrected.id);
    expect(q1.capturePointId).toBe(q2.capturePointId);
    expect(q3.capturePointId).not.toBe(q1.capturePointId);
    expect(q3.u).toBe(.8); // Do not silently snap an individually corrected answer.
    expect(await createSubmission(user, first, await picture('#123abc'))).toMatchObject({ status: 'accepted' });
  });

  it('accepts a batch larger than the former six-per-hour limit through the protected upload route', async () => {
    const owner: Identity = { key: `g:many-${randomUUID()}`, userId: null, name: 'Batch route contributor' };
    const pointId = randomUUID();
    for (let index = 0; index < 8; index++) {
      const data = input({ pointId });
      const response = await fetch(base + '/api/location/submissions?' + new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)])), {
        method: 'POST', headers: { Cookie: cookie(owner), 'Content-Type': 'image/png' }, body: await picture(`rgb(${index * 25}, 93, 178)`),
      });
      expect(response.status).toBe(201); await remember(data.id);
    }
    expect((await listSubmissions(1, owner.key)).total).toBe(8);
  });

  it('enforces the increased pending limit before decoding another image, while still allowing idempotent retries', async () => {
    const owner: Identity = { key: `g:full-${randomUUID()}`, userId: null, name: 'Full batch contributor' };
    const data = input({ pointId: randomUUID() }); const image = await picture('#04579e');
    await createSubmission(owner, data, image); await remember(data.id);
    const original = await db('location_submissions').where({ id: data.id }).first();
    const fillers = Array.from({ length: SUBMISSION_LIMITS.pending - 1 }, () => {
      const id = input().id; const imageHash = randomBytes(32).toString('hex');
      return { ...original, id, image_hash: imageHash, payload: JSON.stringify({ ...JSON.parse(original.payload), id, imageHash }) };
    });
    await db('location_submissions').insert(fillers);
    expect(await createSubmission(owner, data, image)).toMatchObject({ status: 'pending' });
    await expect(createSubmission(owner, input(), image)).rejects.toThrow('LOCATION_SUBMISSION_LIMIT');
    expect(Number((await db('location_submissions').where({ identity_key: owner.key }).count({ count: '*' }).first())?.count)).toBe(SUBMISSION_LIMITS.pending);
  });

  it('approves into an existing measured question point without creating a point or modifying its existing questions', async () => {
    const original = input(); await createSubmission(other, original, await picture('#9213ab')); await remember(original.id);
    await reviewSubmission(original.id, approval);
    const originalQuestion = JSON.parse((await db('location_questions').where({ id: `submission-${original.id}` }).first()).payload);
    const measured = await saveQuestion({ ...originalQuestion, world: { x: 300, y: 200, z: 42 } });
    const url = base + `/api/admin/location/submission-points?mapId=${map.id}&floorId=${approval.floorId}`;
    expect((await fetch(url, { headers: { Cookie: regularCookie } })).status).toBe(403);
    const response = await fetch(url, { headers: { Cookie: adminCookie } }); expect(response.status).toBe(200);
    const point = (await response.json()).items.find((p: any) => p.capturePointId === measured.capturePointId);
    expect(point).toMatchObject({ u: .3, v: .6, eligible: true, questions: 1 });
    const pending = input(); await createSubmission(other, pending, await picture('#a42bdc')); await remember(pending.id);
    const existingPoint = { capturePointId: point.capturePointId, fingerprint: point.fingerprint };
    const before = Number((await db('location_points').where({ map_id: map.id }).count({ n: '*' }).first())?.n);
    const credit = await acceptedSubmissionCount(other.key);
    const review = { ...approval, u: .99, v: .99, existingPoint }; // Client cannot move an existing point.
    const result = await fetch(base + `/api/admin/location/submissions/${pending.id}/review`, {
      method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify(review),
    });
    expect(result.status).toBe(200);
    await reviewSubmission(pending.id, review);
    const saved = JSON.parse((await db('location_questions').where({ id: `submission-${pending.id}` }).first()).payload);
    expect(saved).toMatchObject({ capturePointId: measured.capturePointId, u: .3, v: .6, world: measured.world, tier: 'medium' });
    expect(JSON.parse((await db('location_questions').where({ id: measured.id }).first()).payload)).toEqual(measured);
    expect(Number((await db('location_points').where({ map_id: map.id }).count({ n: '*' }).first())?.n)).toBe(before);
    expect(await acceptedSubmissionCount(other.key)).toBe(credit + 1);
    expect(await db('location_submissions').where({ id: pending.id }).first()).toBeUndefined();
  });

  it('rejects stale, missing and cross-floor targets, retaining the pending submission for another review', async () => {
    const original = input(); await createSubmission(other, original, await picture('#3319ab')); await remember(original.id);
    await reviewSubmission(original.id, approval);
    const q = JSON.parse((await db('location_questions').where({ id: `submission-${original.id}` }).first()).payload);
    const point = (await listMergePoints(map.id, approval.floorId, true)).items.find(p => p.capturePointId === q.capturePointId)!;
    const pending = input(); await createSubmission(other, pending, await picture('#443acd')); const image = await remember(pending.id);
    const oldTarget = { capturePointId: point.capturePointId, fingerprint: point.fingerprint };
    await saveQuestion({ ...q, status: 'disabled' });
    await expect(reviewSubmission(pending.id, { ...approval, existingPoint: oldTarget })).rejects.toThrow('LOCATION_STALE_STATE');
    await expect(reviewSubmission(pending.id, { ...approval, existingPoint: { ...oldTarget, capturePointId: 'nonexistent' } })).rejects.toThrow('LOCATION_STALE_STATE');
    const fresh = (await listMergePoints(map.id, approval.floorId, true)).items.find(p => p.capturePointId === q.capturePointId)!;
    await expect(reviewSubmission(pending.id, { ...approval, floorId: 'lower', existingPoint: { capturePointId: fresh.capturePointId, fingerprint: fresh.fingerprint } })).rejects.toThrow('LOCATION_CAPTURE_POSITION_MISMATCH');
    expect(await db('location_submissions').where({ id: pending.id }).first()).toBeTruthy();
    expect(await db('location_contributions').where({ id: pending.id }).first()).toBeUndefined();
    await expect(fs.access(assetPath(image.imageUrl))).resolves.toBeUndefined();
    expect((await listMergePoints(map.id, 'lower', true)).items.some(p => p.capturePointId === q.capturePointId)).toBe(false);
  });

  it('does not recreate a source point merged away between preview and approval', async () => {
    const accepted = [];
    for (const color of ['#5518ae', '#6619ba']) {
      const data = input(); await createSubmission(other, data, await picture(color)); await remember(data.id); await reviewSubmission(data.id, approval);
      accepted.push(JSON.parse((await db('location_questions').where({ id: `submission-${data.id}` }).first()).payload));
    }
    const points = (await listMergePoints(map.id, approval.floorId, true)).items;
    const targets = accepted.map(q => { const p = points.find(p => p.capturePointId === q.capturePointId)!; return { capturePointId: p.capturePointId, fingerprint: p.fingerprint }; });
    const pending = input(); await createSubmission(other, pending, await picture('#771aeb')); await remember(pending.id);
    const operationId = randomUUID();
    try {
      await mergePoints({ operationId, ...approval, points: targets, u: .4, v: .5 });
      await expect(reviewSubmission(pending.id, { ...approval, existingPoint: targets[1] })).rejects.toThrow('LOCATION_STALE_STATE');
      expect(await db('location_questions').where({ map_id: map.id, point_id: targets[1].capturePointId })).toHaveLength(0);
      expect(await db('location_submissions').where({ id: pending.id }).first()).toBeTruthy();
    } finally { await db('location_versions').where({ key: `point-merge:${operationId}` }).delete(); }
  });
});
