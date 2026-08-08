import knex from 'knex';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('database schema initialization', () => {
  it('creates the current schema and remains idempotent', async () => {
    const instance = createInstance();
    await instance.schema.createTable('guest_accounts', (table) => {
      table.increments('id').primary();
      table.string('guest_key', 64).notNullable().unique();
      table.string('guest_key_hash', 128).notNullable().unique();
      table.string('display_id', 16).notNullable();
      table.timestamp('banned_at').nullable();
      table.boolean('matchmaking_restricted').notNullable().defaultTo(false);
      table.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
      table.timestamp('last_seen_at').notNullable().defaultTo(instance.fn.now());
    });

    await ensureSchema(instance);
    await ensureSchema(instance);

    expect(await instance.schema.hasTable('users')).toBe(true);
    expect(await instance.schema.hasTable('guest_accounts')).toBe(true);
    expect(await instance.schema.hasTable('players')).toBe(true);
    expect(await instance.schema.hasTable('difficulty_levels')).toBe(true);
    expect(await instance.schema.hasTable('player_difficulties')).toBe(true);
    expect(await instance.schema.hasTable('games')).toBe(true);
    expect(await instance.schema.hasTable('match_records')).toBe(true);
    expect(await instance.schema.hasTable('match_players')).toBe(true);
    expect(await instance.schema.hasTable('match_reports')).toBe(true);
    expect(await instance.schema.hasTable('report_whitelist')).toBe(true);
    expect(await instance.schema.hasTable('announcements')).toBe(true);
    expect(await instance.schema.hasColumn('guest_accounts', 'matchmaking_restricted')).toBe(false);

    expect(await instance.schema.hasColumn('players', 'age')).toBe(true);
    expect(await instance.schema.hasColumn('players', 'team_history')).toBe(true);
    expect(await instance.schema.hasColumn('games', 'first_guess_player_id')).toBe(true);
    expect(await instance.schema.hasColumn('games', 'guess_times')).toBe(true);
    expect(await instance.schema.hasColumn('match_records', 'winner_key')).toBe(true);
    expect(await instance.schema.hasColumn('match_records', 'finish_reason')).toBe(true);
    expect(await instance.schema.hasColumn('match_players', 'winning_guess_sum')).toBe(true);
    expect(await instance.schema.hasColumn('announcements', 'is_popup')).toBe(true);

    const difficulties = await instance('difficulty_levels').orderBy('sort_order').pluck('key');
    expect(difficulties).toEqual(['beginner', 'easy', 'normal']);
  });
});
