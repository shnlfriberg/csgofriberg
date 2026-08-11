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
    expect(await instance.schema.hasTable('daily_challenges')).toBe(true);
    expect(await instance.schema.hasTable('daily_challenge_attempts')).toBe(true);
    expect(await instance.schema.hasColumn('guest_accounts', 'matchmaking_restricted')).toBe(false);

    expect(await instance.schema.hasColumn('players', 'age')).toBe(true);
    expect(await instance.schema.hasColumn('players', 'team_history')).toBe(true);
    expect(await instance.schema.hasColumn('games', 'first_guess_player_id')).toBe(true);
    expect(await instance.schema.hasColumn('games', 'guess_times')).toBe(true);
    expect(await instance.schema.hasColumn('match_records', 'winner_key')).toBe(true);
    expect(await instance.schema.hasColumn('match_records', 'finish_reason')).toBe(true);
    expect(await instance.schema.hasColumn('match_players', 'winning_guess_sum')).toBe(true);
    expect(await instance.schema.hasColumn('announcements', 'is_popup')).toBe(true);
    expect(await instance.schema.hasColumn('daily_challenges', 'target_player_id')).toBe(true);
    expect(await instance.schema.hasColumn('daily_challenges', 'solved_count')).toBe(true);
    expect(await instance.schema.hasColumn('daily_challenge_attempts', 'guess_count')).toBe(true);
    expect(await instance.schema.hasColumn('daily_challenge_attempts', 'solve_order')).toBe(true);

    const difficulties = await instance('difficulty_levels').orderBy('sort_order').pluck('key');
    expect(difficulties).toEqual(['beginner', 'easy', 'normal']);
  });

  it('backfills solve order when upgrading existing daily challenge tables', async () => {
    const instance = createInstance();
    await instance.schema.createTable('daily_challenges', (table) => {
      table.increments('id').primary();
      table.string('challenge_date', 10).notNullable();
      table.string('difficulty_key', 32).notNullable();
      table.integer('target_player_id').notNullable();
      table.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
    await instance.schema.createTable('daily_challenge_attempts', (table) => {
      table.increments('id').primary();
      table.integer('challenge_id').notNullable();
      table.string('identity_key', 80).notNullable();
      table.integer('user_id').nullable();
      table.string('guest_key', 64).nullable();
      table.string('display_name', 32).notNullable();
      table.string('status', 16).notNullable();
      table.integer('guess_count').notNullable();
      table.text('guesses').notNullable().defaultTo('[]');
      table.text('guess_times').notNullable().defaultTo('[]');
      table.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
      table.timestamp('finished_at').notNullable().defaultTo(instance.fn.now());
    });
    await instance('daily_challenges').insert({
      id: 1,
      challenge_date: '2026-08-11',
      difficulty_key: 'beginner',
      target_player_id: 1,
    });
    await instance('daily_challenge_attempts').insert([
      {
        id: 1,
        challenge_id: 1,
        identity_key: 'g:later',
        display_name: 'later',
        status: 'won',
        guess_count: 2,
        finished_at: new Date('2026-08-11T00:00:02.000Z'),
      },
      {
        id: 2,
        challenge_id: 1,
        identity_key: 'g:first',
        display_name: 'first',
        status: 'won',
        guess_count: 3,
        finished_at: new Date('2026-08-11T00:00:01.000Z'),
      },
      {
        id: 3,
        challenge_id: 1,
        identity_key: 'g:lost',
        display_name: 'lost',
        status: 'lost',
        guess_count: 8,
        finished_at: new Date('2026-08-11T00:00:03.000Z'),
      },
    ]);

    await ensureSchema(instance);

    const attempts = await instance('daily_challenge_attempts')
      .orderBy('id')
      .select('id', 'solve_order');
    expect(attempts.map((row) => ({
      id: Number(row.id),
      solveOrder: row.solve_order == null ? null : Number(row.solve_order),
    }))).toEqual([
      { id: 1, solveOrder: 2 },
      { id: 2, solveOrder: 1 },
      { id: 3, solveOrder: null },
    ]);
    expect(Number((await instance('daily_challenges').where({ id: 1 }).first()).solved_count)).toBe(2);
  });
});
