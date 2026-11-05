import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/init';
import { db } from '../../src/db/knex';
import { initRedis, redis, redisKey } from '../../src/redis';
import { catalogSnapshot, saveGame, loadGame, deleteState } from '../../src/location/store';
import { archiveExpiredProgress } from '../../src/location/progressArchive';
import { questionQuery, queryQuestions } from '../../src/location/admin/questionQuery';
import { encodeReplay, decodeReplay } from '../../src/location/replayStorage';
import { recordResult, replay } from '../../src/location/games';
import { flushResult, saveRoom, roomView } from '../../src/location/rooms';
import { queueAssetRemoval, flushAssetRemovals } from '../../src/location/assetTasks';
import { uploadAsset, assetPath } from '../../src/location/assets';
import { withImageBudget, withRasterBudget, imageBudget } from '../../src/location/workBudget';
import { score } from '../../src/location/rules';
import { testPool } from './fixtures';
import type { ReplayRecord, RoomState, GameState } from '../../src/location/types';

describe('location optimization integrity', () => {
  const tag = `optimization_${randomUUID().slice(0, 8)}`;
  const snapshot = testPool()[0];
  const map = { ...snapshot.map, id: tag };
  const question = { ...snapshot.question, id: tag, mapId: tag, capturePointId: 'literal_point', u: .25, v: .75 };
  const owner = { key: `g:${tag}`, userId: null, name: 'Integrity' };
  const files: string[] = [];
  beforeAll(async () => {
    await initDb(); await initRedis();
    await db('location_maps').insert({ id: tag, payload: JSON.stringify(map) });
    await db('location_questions').insert({ id: tag, image_hash: tag, payload: JSON.stringify(question) });
  });
  afterAll(async () => {
    await db('location_questions').where({ id: tag }).delete();
    await db('location_maps').where({ id: tag }).delete();
    await db('location_results').where({ identity_key: owner.key }).delete();
    await db('location_progress').where({ identity_key: owner.key }).delete();
    await db('location_progress_archive').where({ identity_key: owner.key }).delete();
    await db('location_result_outbox').where('game_id', 'like', `${tag}%`).delete();
    await db('location_versions').where('key', 'like', `${tag}%`).delete();
    await db('location_asset_tasks').whereIn('url', files).delete();
    await Promise.all(files.map(url => fs.rm(assetPath(url), { force: true })));
  });
  it('automatically indexes writes, filters inclusive bounds and escapes literal text', async () => {
    const raw = JSON.stringify(question);
    expect((await db('location_questions').where({ id: tag }).first()).payload).toBe(raw);
    const q = questionQuery.parse({ mapId: tag, floorId: question.floorId, minU: .25, maxU: .25, minV: .75, maxV: .75, search: 'literal_' });
    const result = await queryQuestions(q);
    expect(result.items.map(q => q.id)).toEqual([tag]);
    expect(result.pointCounts[JSON.stringify([tag, question.capturePointId])]).toBe(1);
    expect((await queryQuestions(questionQuery.parse({ ...q, minU: .26, maxU: .9 }))).total).toBe(0);
    expect(questionQuery.safeParse({ minU: .1 }).success).toBe(false);
    expect((await queryQuestions(questionQuery.parse({ mapId: tag, search: 'literal%' }))).total).toBe(0);
  });
  it('invalidates catalog caches on edits and never exposes mutable cache objects', async () => {
    const first = await catalogSnapshot();
    expect(() => { first.maps.find(m => m.id === tag)!.name = 'mutated'; }).toThrow();
    expect((await catalogSnapshot()).maps.find(m => m.id === tag)!.name).toBe(map.name);
    await db('location_questions').where({ id: tag }).update({ payload: JSON.stringify({ ...question, status: 'disabled' }) });
    expect((await catalogSnapshot()).pool.some(q => q.question.id === tag)).toBe(false);
    await db('location_questions').where({ id: tag }).update({ payload: JSON.stringify(question) });
    expect((await catalogSnapshot()).pool.some(q => q.question.id === tag)).toBe(question.status === 'published');
  });
  it('round trips compact snapshots exactly and leaves legacy records readable', async () => {
    const rounds = [1, 2, 3, 4, 5].map(round => score({ question, map }, { mapId: tag, floorId: question.floorId, u: .2, v: .7 }, [map], round));
    const record: ReplayRecord = { gameId: tag, owner, mode: 'multiplayer', difficulty: 'easy', date: null,
      difficultyMix: { easy: 5, medium: 0, hard: 0 }, totalScore: rounds.reduce((s, r) => s + r.score, 0), results: rounds, scoringVersion: 1,
      rank: 1, roomResults: [{ key: owner.key, name: owner.name, rounds }] };
    const packed = await encodeReplay(record);
    expect(packed.length).toBeLessThan(JSON.stringify(record).length);
    expect(await decodeReplay(packed)).toEqual(record);
    expect(await decodeReplay(JSON.stringify(record))).toEqual(record);
    await recordResult(tag, owner, 'multiplayer', 'easy', null, rounds, undefined, { rank: 1, roomResults: record.roomResults });
    expect((await replay(tag, owner)).results).toEqual(rounds);
  });
  it('removes more than one queue page of expired outbox pointers', async () => {
    const client = redis()!;
    const ids = Array.from({ length: 60 }, (_, i) => `${tag}-missing-${i}`);
    await client.zAdd(redisKey('location:outbox'), ids.map(value => ({ value, score: 0 })));
    for (const id of ids) await flushResult(id);
    for (const id of ids) expect(await client.zScore(redisKey('location:outbox'), id)).toBeNull();
  });
  it('recovers a finished room from SQL after the Redis payload is lost', async () => {
    const room: RoomState = { id: tag, gameId: `${tag}-recover`, host: owner.key, difficulty: 'easy', duration: 60,
      status: 'finished', players: [{ identity: owner, socketId: 'gone', ready: true, connected: false, disconnectAt: null, retired: false, guesses: [null], currentGuess: null, requests: {} }],
      maps: [map], questions: [{ question, map }], round: 1, startsAt: null, endsAt: null, nextAt: null, createdAt: Date.now(), revision: 0 };
    const expected = roomView(room, owner.key).results[0].rounds;
    await saveRoom(room);
    await redis()!.del(redisKey(`location:outbox:${room.gameId}`));
    await flushResult(room.gameId);
    expect((await replay(room.gameId, owner)).results).toEqual(expected);
    expect(await db('location_result_outbox').where({ game_id: room.gameId }).first()).toBeUndefined();
    await redis()!.del([redisKey(`location:room:${room.id}`), redisKey(`location:room-owner:${owner.key}`)]);
  });
  it('never removes an asset on SQL rollback or while a historical snapshot references it', async () => {
    const asset = await uploadAsset(await sharp({ create: { width: 360, height: 360, channels: 3, background: '#126789' } }).png().toBuffer());
    files.push(asset.url, asset.thumbnailUrl);
    await expect(db.transaction(async trx => { await queueAssetRemoval(trx, files); throw new Error('rollback'); })).rejects.toThrow('rollback');
    await flushAssetRemovals();
    await expect(fs.stat(assetPath(asset.url))).resolves.toBeTruthy();
    await db('location_versions').insert({ key: `${tag}:asset`, payload: JSON.stringify(asset) });
    await db.transaction(trx => queueAssetRemoval(trx, files));
    await flushAssetRemovals();
    await expect(fs.stat(assetPath(asset.url))).resolves.toBeTruthy();
  });
  it('bounds image processing and releases capacity after a failed task', async () => {
    let release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const a = withImageBudget(16 * 1024 * 1024, () => blocker);
    const b = withImageBudget(16 * 1024 * 1024, () => blocker);
    await expect(withImageBudget(1, async () => undefined)).rejects.toThrow('LOCATION_BUSY');
    release(); await Promise.all([a, b]);
    await expect(withImageBudget(1, async () => { throw new Error('decode'); })).rejects.toThrow('decode');
    expect(imageBudget().active).toBe(0);
  });
  it('bounds decoded pixels independently of compressed size and releases them on failure', async () => {
    let release!: () => void;
    const first = withRasterBudget(16_000_000, () => new Promise<void>(resolve => { release = resolve; }));
    await expect(withRasterBudget(1, async () => undefined)).rejects.toThrow('LOCATION_BUSY');
    expect(imageBudget().pixels).toBe(16_000_000);
    release(); await first;
    await expect(withRasterBudget(8_000_000, async () => { throw Error('decode failed'); })).rejects.toThrow('decode failed');
    expect(imageBudget().pixels).toBe(0);
    await expect(withRasterBudget(16_000_000, async () => 'ok')).resolves.toBe('ok');
  });
  it('archives new expired progress losslessly while retaining all legacy progress', async () => {
    const game: GameState = { id: `${tag}-progress`, owner, mode: 'daily', difficulty: 'easy', date: '2000-01-01', status: 'abandoned',
      questions: [{ question, map }], maps: [map], guesses: [], requests: {}, version: 1, scoringVersion: 1,
      createdAt: 1, updatedAt: 1, expiresAt: 1 };
    await saveGame(game);
    await deleteState(`game:${game.id}`);
    const legacy = { ...game, id: `${tag}-legacy`, date: '2000-01-02' };
    await db('location_progress').insert({ identity_key: owner.key, date: legacy.date, difficulty: legacy.difficulty, payload: JSON.stringify(legacy) });
    await archiveExpiredProgress();
    expect(await loadGame(game.id, owner)).toEqual(game);
    expect((await db('location_progress').where({ identity_key: owner.key, date: legacy.date }).first()).payload).toBe(JSON.stringify(legacy));
    expect(await loadGame(legacy.id, owner)).toEqual(legacy);
  });
});
