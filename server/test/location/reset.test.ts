import knex from 'knex';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../../src/db/schema';
import { assertDatabaseReady } from '../../src/db/ready';
import { STARTER_MAPS } from '../../src/location/schema';
import {
  LOCATION_TABLES,
  locationDataCounts,
  resetLocationDatabase,
} from '../../src/location/maintenance/reset';

const instances: ReturnType<typeof knex>[] = [];
function instance() {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  instances.push(db);
  return db;
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((db) => db.destroy()));
});

describe('location-only data reset', () => {
  it('clears all authoring and play data, restores canonical maps and preserves other domains', async () => {
    const db = instance();
    await ensureSchema(db);
    const tables = await db('sqlite_master')
      .where({ type: 'table' })
      .where('name', 'like', 'location_%')
      .select('name');
    expect(tables.map((row) => row.name).sort()).toEqual(
      [...LOCATION_TABLES].sort()
    );
    await db('users').insert({
      username: 'keep-admin',
      password_hash: 'unchanged',
      role: 'admin',
    });
    await db('announcements').insert({
      title: 'Keep announcement',
      content: 'Existing content',
    });
    const users = await db('users').select('*');
    const announcements = await db('announcements').select('*');
    await db('location_maps')
      .where({ id: STARTER_MAPS[0].id })
      .update({ payload: '{"test":true}' });
    await db('location_versions').insert({
      key: 'question:garbage:1',
      payload: '{}',
    });
    await db('location_questions').insert({
      id: 'garbage',
      image_hash: 'garbage-image',
      payload: '{}',
    });
    await db('location_capture_drafts').insert({
      id: 'garbage',
      payload: '{}',
    });
    await db('location_daily').insert({ date: '2026-10-17', payload: '{}' });
    await db('location_progress').insert({
      identity_key: 'g:garbage',
      date: '2026-10-17',
      difficulty: 'normal',
      payload: '{}',
    });
    await db('location_daily_attempts').insert({
      identity_key: 'g:garbage',
      date: '2026-10-17',
      difficulty: 'normal',
      game_id: 'garbage',
    });
    await db('location_results').insert({
      game_id: 'garbage',
      identity_key: 'g:garbage',
      mode: 'random',
      score: 1,
      finished_at: Date.now(),
      payload: '{}',
    });

    await resetLocationDatabase(db);
    await resetLocationDatabase(db);
    await expect(assertDatabaseReady(db)).resolves.toBeUndefined();
    const counts = await locationDataCounts(db);
    for (const table of LOCATION_TABLES.filter(
      (t) => !['location_maps', 'location_versions'].includes(t)
    ))
      expect(counts[table]).toBe(0);
    expect(counts.location_maps).toBe(STARTER_MAPS.length);
    expect(counts.location_versions).toBe(STARTER_MAPS.length);
    expect(
      (await db('location_maps').orderBy('id')).map((row) =>
        JSON.parse(row.payload)
      )
    ).toEqual([...STARTER_MAPS].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await db('users').select('*')).toEqual(users);
    expect(await db('announcements').select('*')).toEqual(announcements);
  });

  it('keeps calibrated maps and every historical map snapshot when only clearing the bank', async () => {
    const db = instance();
    await ensureSchema(db);
    const map = { ...STARTER_MAPS[0], version: 7, calibration: {
      posX: -2093.96875, posY: 3117.96875, scale: 5.123,
      points: [{ x: 42, y: 84, u: 0.2, v: 0.3, floorId: STARTER_MAPS[0].floors[0].id }],
    } };
    const payload = JSON.stringify(map);
    await db('location_maps').where({ id: map.id }).update({ payload });
    await db('location_versions').insert({ key: `map:${map.id}:7`, payload });
    const maps = await db('location_maps').orderBy('id');
    const versions = await db('location_versions').orderBy('key');
    await db('users').insert({ username: 'keep-admin', password_hash: 'unchanged', role: 'admin' });
    const users = await db('users').select('*');
    await db('location_questions').insert({ id: 'question', image_hash: 'hash', payload: '{}' });
    await db('location_versions').insert({ key: 'question:question:1', payload: '{}' });
    await db('location_capture_drafts').insert([
      { id: 'unbound', payload: '{}' },
      { id: 'bound', payload: '{"images":[{"id":"one","asset":{"url":"/old.webp"}}]}' },
    ]);
    await db('location_daily').insert({ date: '2026-10-18', payload: '{}' });
    await db('location_progress').insert({ identity_key: 'g:test', date: '2026-10-18', difficulty: 'normal', payload: '{}' });
    await db('location_daily_attempts').insert({ identity_key: 'g:test', date: '2026-10-18', difficulty: 'normal', game_id: 'old' });
    await db('location_results').insert({ game_id: 'old', identity_key: 'g:test', score: 1, finished_at: Date.now(), payload: '{}' });

    await resetLocationDatabase(db, { preserveMaps: true });
    await resetLocationDatabase(db, { preserveMaps: true });
    expect(await db('location_maps').orderBy('id')).toEqual(maps);
    expect(await db('location_versions').orderBy('key')).toEqual(versions);
    expect(await db('users').select('*')).toEqual(users);
    const counts = await locationDataCounts(db);
    for (const table of LOCATION_TABLES.filter(t => !['location_maps', 'location_versions'].includes(t)))
      expect(counts[table]).toBe(0);
  });

  it.each([false, true])('rolls back the whole reset if any table cannot be cleared (preserveMaps=%s)', async (preserveMaps) => {
    const db = instance();
    await ensureSchema(db);
    await db('location_daily').insert({
      date: '2026-10-17',
      payload: 'preserved',
    });
    await db.schema.dropTable('location_questions');
    await expect(resetLocationDatabase(db, { preserveMaps })).rejects.toThrow();
    expect((await db('location_daily').first()).payload).toBe('preserved');
  });
});
