import knex from 'knex';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDatabaseReady } from '../../src/db/ready';
import { ensureSchema } from '../../src/db/schema';

const instances: ReturnType<typeof knex>[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.destroy()));
});

function createInstance() {
  const instance = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  instances.push(instance);
  return instance;
}

describe('database readiness check', () => {
  it('accepts a fully migrated database without changing it', async () => {
    const instance = createInstance();
    await ensureSchema(instance);
    await expect(assertDatabaseReady(instance)).resolves.toBeUndefined();
  });

  it('rejects a database whose migration has not run', async () => {
    const instance = createInstance();
    await expect(assertDatabaseReady(instance)).rejects.toThrow('DATABASE_SCHEMA_NOT_READY');
  });

  it('rejects a missing capture draft table or payload column without creating them', async () => {
    const instance = createInstance();
    await ensureSchema(instance);
    await instance.schema.dropTable('location_capture_drafts');

    await expect(assertDatabaseReady(instance)).rejects.toThrow(
      'DATABASE_SCHEMA_NOT_READY:location_capture_drafts'
    );
    expect(await instance.schema.hasTable('location_capture_drafts')).toBe(false);

    await instance.schema.createTable('location_capture_drafts', (table) => {
      table.string('id', 64).primary();
    });
    await expect(assertDatabaseReady(instance)).rejects.toThrow(
      'DATABASE_SCHEMA_NOT_READY:location_capture_drafts.payload'
    );
    expect(await instance.schema.hasColumn('location_capture_drafts', 'payload')).toBe(false);
  });

  it('upgrades a database from before batch capture while preserving existing data on repeated migrations', async () => {
    const instance = createInstance();
    await ensureSchema(instance);
    await instance.schema.dropTable('location_capture_drafts');
    await instance('users').insert({ username: 'existing-admin', password_hash: 'preserved-hash', role: 'admin' });
    const question = { id: 'existing-question', image_hash: 'existing-image', payload: '{"source":"existing"}' };
    await instance('location_questions').insert(question);
    const usersBefore = await instance('users').select('*');
    const mapsBefore = await instance('location_maps').orderBy('id');

    await ensureSchema(instance);
    await expect(assertDatabaseReady(instance)).resolves.toBeUndefined();
    const draft = { id: 'new-capture-point', payload: '{"capturePointId":"tx-001"}' };
    await instance('location_capture_drafts').insert(draft);
    await ensureSchema(instance);
    await expect(assertDatabaseReady(instance)).resolves.toBeUndefined();

    expect(await instance('users').select('*')).toEqual(usersBefore);
    expect(await instance('location_maps').orderBy('id')).toEqual(mapsBefore);
    expect(await instance('location_questions').where({ id: question.id }).first('id', 'image_hash', 'payload')).toEqual(question);
    expect(await instance('location_capture_drafts').select('id', 'payload')).toEqual([draft]);
  });
});
