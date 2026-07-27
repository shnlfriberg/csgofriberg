import { Knex } from 'knex';
import { db } from './knex';
import { userNameFromUsername } from '../services/identityDisplay';
import { DIFFICULTY_LEVELS } from '../difficulties';

const FIRST_GUESS_BACKFILL_BATCH_SIZE = 1000;
const USER_DISPLAY_ID_BACKFILL_BATCH_SIZE = 1000;
const PLAYER_DIFFICULTIES_BACKFILL_MIGRATION = '20260724-player-difficulties-backfill';

export async function backfillLegacyPlayerDifficulties(instance: Knex = db): Promise<void> {
  await instance.transaction(async (trx) => {
    const applied = await trx('app_migrations')
      .where({ name: PLAYER_DIFFICULTIES_BACKFILL_MIGRATION })
      .first();
    if (applied) return;

    const players = await trx('players').select('id', 'is_easy');
    const memberships = players.flatMap((player) => [
      { player_id: player.id, difficulty_key: 'normal' },
      ...(Boolean(player.is_easy) ? [{ player_id: player.id, difficulty_key: 'easy' }] : []),
    ]);
    for (let index = 0; index < memberships.length; index += 500) {
      await trx('player_difficulties')
        .insert(memberships.slice(index, index + 500))
        .onConflict(['player_id', 'difficulty_key'])
        .ignore();
    }
    await trx('app_migrations')
      .insert({ name: PLAYER_DIFFICULTIES_BACKFILL_MIGRATION })
      .onConflict('name')
      .ignore();
  });
}

async function backfillUserDisplayIds(instance: Knex): Promise<void> {
  let cursor = 0;
  while (true) {
    const users = await instance('users')
      .select('id', 'username')
      .where('id', '>', cursor)
      .where((builder) => builder.whereNull('display_id').orWhere('display_id', ''))
      .orderBy('id')
      .limit(USER_DISPLAY_ID_BACKFILL_BATCH_SIZE);
    if (!users.length) return;
    cursor = Number(users[users.length - 1].id);
    await instance.transaction(async (trx) => {
      for (const user of users) {
        await trx('users').where({ id: user.id }).update({
          display_id: userNameFromUsername(user.username),
        });
      }
    });
  }
}

function firstGuessPlayerId(value: unknown): number {
  try {
    const guesses = JSON.parse(String(value));
    if (!Array.isArray(guesses) || !guesses.length) return 0;
    const first = guesses[0];
    const id = Number(
      typeof first === 'object' && first
        ? (first as { playerId?: unknown }).playerId
        : first
    );
    return Number.isInteger(id) && id > 0 ? id : 0;
  } catch {
    return 0;
  }
}

async function backfillFirstGuessPlayerIds(instance: Knex): Promise<void> {
  let cursor = 0;
  while (true) {
    const rows = await instance('games')
      .select('id', 'guesses')
      .where('id', '>', cursor)
      .whereNull('first_guess_player_id')
      .where('guess_count', '>', 0)
      .whereNot('status', 'playing')
      .orderBy('id')
      .limit(FIRST_GUESS_BACKFILL_BATCH_SIZE);
    if (!rows.length) return;
    cursor = Number(rows[rows.length - 1].id);

    const grouped = new Map<number, number[]>();
    for (const row of rows) {
      const playerId = firstGuessPlayerId(row.guesses);
      const ids = grouped.get(playerId) ?? [];
      ids.push(Number(row.id));
      grouped.set(playerId, ids);
    }
    await instance.transaction(async (trx) => {
      for (const [playerId, ids] of grouped) {
        await trx('games').whereIn('id', ids).update({ first_guess_player_id: playerId });
      }
    });
  }
}

export async function ensureSchema(instance: Knex = db): Promise<void> {
  if (!(await instance.schema.hasTable('users'))) {
    await instance.schema.createTable('users', (t) => {
      t.increments('id').primary();
      t.string('username', 32).notNullable().unique();
      t.string('display_id', 8).nullable();
      t.string('password_hash', 128).notNullable();
      t.string('role', 16).notNullable().defaultTo('user');
      t.integer('token_version').notNullable().defaultTo(0);
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
  }
  if (!(await instance.schema.hasColumn('users', 'token_version'))) {
    await instance.schema.alterTable('users', (t) => t.integer('token_version').notNullable().defaultTo(0));
  }
  if (!(await instance.schema.hasColumn('users', 'display_id'))) {
    await instance.schema.alterTable('users', (t) => t.string('display_id', 8).nullable());
  }
  await backfillUserDisplayIds(instance);
  const usersIndexConcurrently = instance.client.config.client === 'pg' ? ' concurrently' : '';
  await instance.raw(
    `create index${usersIndexConcurrently} if not exists "users_display_id_idx" on "users" ("display_id")`
  );

  if (!(await instance.schema.hasTable('api_tokens'))) {
    await instance.schema.createTable('api_tokens', (t) => {
      t.increments('id').primary();
      t.string('name', 64).notNullable();
      t.string('token_hash', 64).notNullable().unique();
      t.string('prefix', 16).notNullable();
      t.integer('created_by_user_id')
        .notNullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE');
      t.timestamp('expires_at').notNullable();
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
  }
  const apiTokensIndexConcurrently = instance.client.config.client === 'pg' ? ' concurrently' : '';
  await instance.raw(
    `create index${apiTokensIndexConcurrently} if not exists "api_tokens_owner_created_idx" on "api_tokens" ("created_by_user_id", "created_at")`
  );

  if (!(await instance.schema.hasTable('app_migrations'))) {
    await instance.schema.createTable('app_migrations', (t) => {
      t.string('name', 128).primary();
      t.timestamp('applied_at').notNullable().defaultTo(instance.fn.now());
    });
  }

  if (!(await instance.schema.hasTable('players'))) {
    await instance.schema.createTable('players', (t) => {
      t.increments('id').primary();
      t.string('nickname', 64).notNullable().unique();
      t.string('nationality', 64).notNullable();
      t.string('region', 32).notNullable().defaultTo('');
      t.string('team', 64).notNullable().defaultTo('');
      t.integer('age').notNullable();
      t.string('role', 32).notNullable().defaultTo('Rifler');
      t.integer('major_championships').notNullable().defaultTo(0);
      t.integer('major_appearances').notNullable().defaultTo(0);
      t.boolean('is_easy').notNullable().defaultTo(false);
      t.boolean('is_active').notNullable().defaultTo(true);
      t.boolean('is_enabled').notNullable().defaultTo(true);
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
  }
  const hasPlayerAge = await instance.schema.hasColumn('players', 'age');
  const hasPlayerBirthYear = await instance.schema.hasColumn('players', 'birth_year');
  if (!hasPlayerAge) {
    await instance.schema.alterTable('players', (t) => {
      t.integer('age').nullable();
    });
  }
  if (hasPlayerBirthYear) {
    const currentYear = new Date().getFullYear();
    const players = await instance('players').select('id', 'age', 'birth_year');
    for (const player of players) {
      if (player.age != null) continue;
      const age = currentYear - Number(player.birth_year);
      if (!Number.isInteger(age) || age < 0) {
        throw new Error(`INVALID_PLAYER_BIRTH_YEAR:${player.id}`);
      }
      await instance('players').where({ id: player.id }).update({ age });
    }
  }
  const missingPlayerAge = await instance('players').whereNull('age').first('id');
  if (missingPlayerAge) throw new Error(`MISSING_PLAYER_AGE:${missingPlayerAge.id}`);
  if (!hasPlayerAge || hasPlayerBirthYear) {
    await instance.schema.alterTable('players', (t) => {
      t.integer('age').notNullable().alter();
      if (hasPlayerBirthYear) t.dropColumn('birth_year');
    });
  }
  if (!(await instance.schema.hasColumn('players', 'major_championships'))) {
    await instance.schema.alterTable('players', (t) => {
      t.integer('major_championships').notNullable().defaultTo(0);
    });
  }
  if (!(await instance.schema.hasColumn('players', 'is_easy'))) {
    await instance.schema.alterTable('players', (t) => {
      t.boolean('is_easy').notNullable().defaultTo(false);
    });
  }
  if (!(await instance.schema.hasColumn('players', 'is_enabled'))) {
    await instance.schema.alterTable('players', (t) => {
      t.boolean('is_enabled').notNullable().defaultTo(true);
    });
  }
  if (await instance.schema.hasColumn('players', 'real_name')) {
    if (instance.client.config.client === 'pg') {
      await instance.raw('drop index if exists "players_real_name_trgm_idx"');
    }
    await instance.schema.alterTable('players', (t) => t.dropColumn('real_name'));
  }
  if (instance.client.config.client === 'pg') {
    await instance.raw('create extension if not exists pg_trgm');
    await instance.raw(
      'create index if not exists "players_nickname_trgm_idx" on "players" using gin ("nickname" gin_trgm_ops)'
    );
    await instance.raw(
      'create index if not exists "players_team_trgm_idx" on "players" using gin ("team" gin_trgm_ops)'
    );
  }

  // 旧版 games 表 user_id 不可空且无 guest_key;检测到旧结构则重建(开发期数据可丢弃)
  if (
    (await instance.schema.hasTable('games')) &&
    !(await instance.schema.hasColumn('games', 'guest_key'))
  ) {
    await instance.schema.dropTable('games');
  }
  if (!(await instance.schema.hasTable('games'))) {
    await instance.schema.createTable('games', (t) => {
      t.increments('id').primary();
      t.string('session_id', 64).nullable();
      t.integer('user_id').nullable().references('id').inTable('users');
      t.string('guest_key', 64).nullable().index();
      t.integer('target_player_id').notNullable().references('id').inTable('players');
      t.string('mode', 16).notNullable().defaultTo('easy');
      t.text('guesses').notNullable().defaultTo('[]');
      t.integer('first_guess_player_id').nullable();
      t.string('status', 16).notNullable().defaultTo('playing');
      t.integer('guess_count').notNullable().defaultTo(0);
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
      t.timestamp('finished_at').nullable();
    });
  }
  if (!(await instance.schema.hasColumn('games', 'session_id'))) {
    await instance.schema.alterTable('games', (t) => t.string('session_id', 64).nullable());
  }
  if (!(await instance.schema.hasTable('difficulty_levels'))) {
    await instance.schema.createTable('difficulty_levels', (t) => {
      t.string('key', 32).primary();
      t.integer('sort_order').notNullable().defaultTo(0);
      t.boolean('is_enabled').notNullable().defaultTo(true);
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
  }
  await instance('difficulty_levels')
    .insert(DIFFICULTY_LEVELS.map((difficulty) => ({
      key: difficulty.key,
      sort_order: difficulty.sortOrder,
      is_enabled: difficulty.isEnabled,
    })))
    .onConflict('key')
    .merge(['sort_order', 'is_enabled']);
  if (!(await instance.schema.hasTable('player_difficulties'))) {
    await instance.schema.createTable('player_difficulties', (t) => {
      t.integer('player_id').notNullable().references('id').inTable('players').onDelete('CASCADE');
      t.string('difficulty_key', 32).notNullable().references('key').inTable('difficulty_levels').onDelete('CASCADE');
      t.primary(['player_id', 'difficulty_key']);
      t.index(['difficulty_key', 'player_id']);
    });
  }
  if (!(await instance.schema.hasColumn('games', 'first_guess_player_id'))) {
    await instance.schema.alterTable('games', (t) => t.integer('first_guess_player_id').nullable());
  }
  await backfillFirstGuessPlayerIds(instance);
  await instance.raw(
    'create unique index if not exists "games_session_id_unique" on "games" ("session_id")'
  );
  // Active single-player games now live only in Redis and are not historical records.
  await instance('games').where({ status: 'playing' }).del();

  if (
    (await instance.schema.hasTable('match_records')) &&
    !(await instance.schema.hasColumn('match_records', 'bo_type'))
  ) {
    await instance.schema.dropTable('match_records');
  }
  if (!(await instance.schema.hasTable('match_records'))) {
    await instance.schema.createTable('match_records', (t) => {
      t.increments('id').primary();
      t.string('room_id', 64).notNullable();
      t.string('db_type', 16).notNullable().defaultTo('easy');
      t.integer('bo_type').notNullable().defaultTo(3);
      t.integer('winner_id').nullable().references('id').inTable('users');
      t.string('winner_key', 80).nullable();
      t.string('finish_reason', 32).nullable();
      t.string('forfeited_key', 80).nullable();
      t.text('players').notNullable().defaultTo('[]');
      t.text('replay').notNullable().defaultTo('[]');
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
      t.unique(['room_id']);
    });
  }
  if (!(await instance.schema.hasColumn('match_records', 'replay'))) {
    await instance.schema.alterTable('match_records', (t) => {
      t.text('replay').notNullable().defaultTo('[]');
    });
  }
  if (!(await instance.schema.hasColumn('match_records', 'db_type'))) {
    await instance.schema.alterTable('match_records', (t) => {
      t.string('db_type', 16).notNullable().defaultTo('easy');
    });
  }
  if (!(await instance.schema.hasColumn('match_records', 'winner_key'))) {
    await instance.schema.alterTable('match_records', (t) => {
      t.string('winner_key', 80).nullable();
    });
  }
  if (!(await instance.schema.hasColumn('match_records', 'finish_reason'))) {
    await instance.schema.alterTable('match_records', (t) => {
      t.string('finish_reason', 32).nullable();
    });
  }
  if (!(await instance.schema.hasColumn('match_records', 'forfeited_key'))) {
    await instance.schema.alterTable('match_records', (t) => {
      t.string('forfeited_key', 80).nullable();
    });
  }

  if (!(await instance.schema.hasTable('match_players'))) {
    await instance.schema.createTable('match_players', (t) => {
      t.increments('id').primary();
      t.integer('match_id').notNullable().references('id').inTable('match_records').onDelete('CASCADE');
      t.integer('user_id').nullable().references('id').inTable('users');
      t.string('player_key', 80).notNullable();
      t.string('player_name', 32).notNullable().defaultTo('');
      t.integer('score').notNullable().defaultTo(0);
      t.boolean('is_winner').notNullable().defaultTo(false);
      t.unique(['match_id', 'player_key']);
      t.index(['user_id', 'is_winner'], 'match_players_user_winner_idx');
    });
  }

  if (instance.client.config.client === 'pg') {
    await instance.raw(
      'alter table "match_records" alter column "room_id" type varchar(64)'
    );
  }

  const matchPlayerCount = Number(
    (await instance('match_players').count<{ count: number }[]>({ count: '*' }))[0].count
  );
  if (matchPlayerCount === 0) {
    const legacyMatches = await instance('match_records').select('id', 'winner_id', 'players');
    for (const match of legacyMatches) {
      let players: { userId: number | null; name: string; score: number }[] = [];
      try {
        players = JSON.parse(match.players);
      } catch {
        continue;
      }
      if (players.length) {
        await instance('match_players').insert(
          players.map((player, index) => ({
            match_id: match.id,
            user_id: player.userId,
            player_key: player.userId != null ? `u:${player.userId}` : `legacy:${match.id}:${index}`,
            player_name: player.name,
            score: player.score,
            is_winner: player.userId != null && player.userId === match.winner_id,
          }))
        );
      }
    }
  }

  const gameIndexes = [
    ['games_user_status_mode_idx', ['user_id', 'status', 'mode']],
    ['games_guest_status_mode_idx', ['guest_key', 'status', 'mode']],
    ['games_user_finished_idx', ['user_id', 'finished_at']],
    ['games_guest_finished_idx', ['guest_key', 'finished_at']],
  ] as const;
  for (const [name, columns] of gameIndexes) {
    const quotedColumns = columns.map((column) => `\"${column}\"`).join(', ');
    await instance.raw(`create index if not exists \"${name}\" on \"games\" (${quotedColumns})`);
  }
  const firstGuessIndexes = [
    ['games_first_guess_idx', ['first_guess_player_id']],
    ['games_user_first_guess_idx', ['user_id', 'first_guess_player_id']],
    ['games_guest_first_guess_idx', ['guest_key', 'first_guess_player_id']],
  ] as const;
  for (const [name, columns] of firstGuessIndexes) {
    const quotedColumns = columns.map((column) => `\"${column}\"`).join(', ');
    const concurrently = instance.client.config.client === 'pg' ? ' concurrently' : '';
    await instance.raw(
      `create index${concurrently} if not exists \"${name}\" on \"games\" (${quotedColumns})`
    );
  }

  await instance.raw(
    'create unique index if not exists "match_records_room_id_unique" on "match_records" ("room_id")'
  );
  await instance.raw(
    'create index if not exists "match_records_created_at_idx" on "match_records" ("created_at", "id")'
  );
  await instance.raw(
    'create index if not exists "match_players_user_match_idx" on "match_players" ("user_id", "match_id")'
  );
  await instance.raw(
    'create index if not exists "match_players_key_match_idx" on "match_players" ("player_key", "match_id")'
  );

  if (!(await instance.schema.hasTable('announcements'))) {
    await instance.schema.createTable('announcements', (t) => {
      t.increments('id').primary();
      t.string('title', 128).notNullable();
      t.text('content').notNullable();
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
  }
}
