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
});
