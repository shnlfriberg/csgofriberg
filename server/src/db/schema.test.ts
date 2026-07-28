import knex from 'knex';
import { afterEach, describe, expect, it } from 'vitest';
import { backfillLegacyPlayerDifficulties, ensureSchema } from './schema';
import { backfillBeginnerPlayers } from './init';
import { userNameFromUsername } from '../services/identityDisplay';

const instances: ReturnType<typeof knex>[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.destroy()));
});

describe('player schema migration', () => {
  it('replaces birth years with fixed ages without losing players', async () => {
    const instance = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    instances.push(instance);
    await instance.schema.createTable('players', (table) => {
      table.increments('id').primary();
      table.string('nickname', 64).notNullable().unique();
      table.string('real_name', 128).notNullable().defaultTo('');
      table.string('nationality', 64).notNullable();
      table.string('region', 32).notNullable().defaultTo('');
      table.string('team', 64).notNullable().defaultTo('');
      table.integer('birth_year').notNullable();
      table.string('role', 32).notNullable().defaultTo('Rifler');
      table.integer('major_appearances').notNullable().defaultTo(0);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
    await instance('players').insert({
      nickname: 'legacy',
      real_name: 'must be removed',
      nationality: '丹麦',
      region: '欧洲',
      team: 'NIP',
      birth_year: 1990,
      role: 'Rifler',
      major_appearances: 2,
    });

    await ensureSchema(instance);
    await backfillLegacyPlayerDifficulties(instance);

    expect(await instance.schema.hasColumn('players', 'real_name')).toBe(false);
    expect(await instance.schema.hasColumn('players', 'major_championships')).toBe(true);
    expect(await instance.schema.hasColumn('players', 'is_easy')).toBe(true);
    expect(await instance.schema.hasColumn('players', 'is_enabled')).toBe(true);
    expect(await instance.schema.hasTable('difficulty_levels')).toBe(true);
    expect(await instance.schema.hasTable('player_difficulties')).toBe(true);
    expect(await instance.schema.hasColumn('players', 'age')).toBe(true);
    expect(await instance.schema.hasColumn('players', 'birth_year')).toBe(false);
    expect(await instance.schema.hasTable('app_migrations')).toBe(true);
    expect(await instance.schema.hasColumn('match_records', 'winner_key')).toBe(true);
    expect(await instance.schema.hasColumn('match_records', 'finish_reason')).toBe(true);
    expect(await instance.schema.hasColumn('match_records', 'forfeited_key')).toBe(true);
    expect(await instance.schema.hasColumn('games', 'first_guess_player_id')).toBe(true);
    expect(await instance.schema.hasColumn('users', 'display_id')).toBe(true);
    expect(await instance.schema.hasColumn('users', 'leaderboard_hidden')).toBe(true);
    expect(await instance.schema.hasTable('api_tokens')).toBe(true);
    expect(await instance.schema.hasColumn('api_tokens', 'token_hash')).toBe(true);
    expect(await instance.schema.hasColumn('announcements', 'is_popup')).toBe(true);
    expect(await instance.schema.hasTable('special_thanks')).toBe(true);
    expect(await instance.schema.hasColumn('special_thanks', 'name')).toBe(true);
    expect(await instance.schema.hasColumn('special_thanks', 'note')).toBe(true);
    expect(await instance.schema.hasColumn('special_thanks', 'sort_order')).toBe(true);
    const player = await instance('players').where({ nickname: 'legacy' }).first();
    expect(player.age).toBe(new Date().getFullYear() - 1990);
    expect((await instance('players').columnInfo('age')).nullable).toBe(false);
    expect(player.major_championships).toBe(0);
    expect(player.is_easy).toBe(0);
    expect(player.is_enabled).toBe(1);
    expect(await instance('player_difficulties').where({ player_id: player.id }).pluck('difficulty_key')).toEqual(['normal']);
    await instance('player_difficulties').where({ player_id: player.id }).del();
    await ensureSchema(instance);
    await backfillLegacyPlayerDifficulties(instance);
    expect(await instance('player_difficulties').where({ player_id: player.id })).toEqual([]);

    await instance('games').insert({
      session_id: 'legacy-first-guess',
      guest_key: 'legacy-guest',
      target_player_id: player.id,
      mode: 'easy',
      guesses: JSON.stringify([{ playerId: player.id }]),
      first_guess_player_id: null,
      status: 'won',
      guess_count: 1,
      finished_at: instance.fn.now(),
    });
    await ensureSchema(instance);
    const game = await instance('games').where({ session_id: 'legacy-first-guess' }).first();
    expect(game.first_guess_player_id).toBe(player.id);

    await instance('users').insert({
      username: 'legacy-user',
      display_id: null,
      password_hash: 'test',
      role: 'user',
    });
    await ensureSchema(instance);
    const user = await instance('users').where({ username: 'legacy-user' }).first();
    expect(user.display_id).toBe(userNameFromUsername('legacy-user'));
  });

  it('adds the popup flag to an existing announcements table', async () => {
    const instance = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    instances.push(instance);
    await instance.schema.createTable('announcements', (table) => {
      table.increments('id').primary();
      table.string('title', 128).notNullable();
      table.text('content').notNullable();
      table.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
    await instance('announcements').insert({ title: 'legacy', content: 'content' });

    await ensureSchema(instance);

    expect(await instance.schema.hasColumn('announcements', 'is_popup')).toBe(true);
    expect((await instance('announcements').where({ title: 'legacy' }).first()).is_popup).toBe(0);
  });

  it('adds notes and stable ordering to an existing special thanks table', async () => {
    const instance = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    instances.push(instance);
    await instance.schema.createTable('special_thanks', (table) => {
      table.increments('id').primary();
      table.string('name', 80).notNullable().unique();
      table.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
    await instance('special_thanks').insert([{ name: 'First' }, { name: 'Second' }]);

    await ensureSchema(instance);

    expect(await instance.schema.hasColumn('special_thanks', 'note')).toBe(true);
    expect(await instance.schema.hasColumn('special_thanks', 'sort_order')).toBe(true);
    expect(await instance('special_thanks').select('name', 'note', 'sort_order').orderBy('sort_order')).toEqual([
      { name: 'First', note: '', sort_order: 0 },
      { name: 'Second', note: '', sort_order: 1 },
    ]);
  });

  it('backfills beginner membership only for easy Major champions', async () => {
    const instance = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
    });
    instances.push(instance);
    await ensureSchema(instance);
    const players = await instance('players').insert([
      {
        nickname: 's1mple',
        nationality: '测试',
        age: 25,
        major_championships: 0,
        is_easy: true,
      },
      {
        nickname: 'beginner-non-champion',
        nationality: '测试',
        age: 25,
        major_championships: 0,
        is_easy: true,
      },
    ]).returning(['id', 'nickname']);

    await backfillBeginnerPlayers(instance);

    const memberships = await instance('player_difficulties')
      .where({ difficulty_key: 'beginner' })
      .pluck('player_id');
    const champion = players.find((player) => player.nickname === 's1mple')!;
    expect(memberships).toEqual([champion.id]);
    expect(await instance('difficulty_levels').where({ key: 'beginner' }).first())
      .toMatchObject({ sort_order: 5, is_enabled: 1 });
  });
});
