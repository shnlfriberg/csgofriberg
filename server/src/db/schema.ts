import { Knex } from 'knex';
import { db } from './knex';
import { DIFFICULTY_LEVELS } from '../difficulties';

export async function ensureSchema(instance: Knex = db): Promise<void> {
  if (!(await instance.schema.hasTable('users'))) {
    await instance.schema.createTable('users', (t) => {
      t.increments('id').primary();
      t.string('username', 32).notNullable().unique();
      t.string('display_id', 8).nullable();
      t.string('password_hash', 128).notNullable();
      t.string('role', 16).notNullable().defaultTo('user');
      t.integer('token_version').notNullable().defaultTo(0);
      t.boolean('leaderboard_hidden').notNullable().defaultTo(false);
      t.boolean('matchmaking_restricted').notNullable().defaultTo(false);
      t.string('email', 320).nullable().unique();
      t.timestamp('email_verified_at').nullable();
      t.timestamp('banned_at').nullable();
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
  }
  if (!(await instance.schema.hasColumn('users', 'token_version'))) {
    await instance.schema.alterTable('users', (t) => t.integer('token_version').notNullable().defaultTo(0));
  }
  if (!(await instance.schema.hasColumn('users', 'display_id'))) {
    await instance.schema.alterTable('users', (t) => t.string('display_id', 8).nullable());
  }
  if (!(await instance.schema.hasColumn('users', 'leaderboard_hidden'))) {
    await instance.schema.alterTable('users', (t) => {
      t.boolean('leaderboard_hidden').notNullable().defaultTo(false);
    });
  }
  if (!(await instance.schema.hasColumn('users', 'matchmaking_restricted'))) {
    await instance.schema.alterTable('users', (t) => {
      t.boolean('matchmaking_restricted').notNullable().defaultTo(false);
    });
  }
  if (!(await instance.schema.hasColumn('users', 'email'))) {
    await instance.schema.alterTable('users', (t) => t.string('email', 320).nullable());
  }
  if (!(await instance.schema.hasColumn('users', 'email_verified_at'))) {
    await instance.schema.alterTable('users', (t) => t.timestamp('email_verified_at').nullable());
  }
  if (!(await instance.schema.hasColumn('users', 'banned_at'))) {
    await instance.schema.alterTable('users', (t) => t.timestamp('banned_at').nullable());
  }
  await instance.raw('create unique index if not exists "users_email_unique" on "users" ("email") where "email" is not null');
  if (!(await instance.schema.hasTable('email_verifications'))) {
    await instance.schema.createTable('email_verifications', (t) => {
      t.increments('id').primary();
      t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.string('email', 320).notNullable();
      t.string('token_hash', 128).notNullable().unique();
      t.timestamp('expires_at').notNullable();
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
      t.index(['user_id', 'expires_at']);
    });
  }
  if (!(await instance.schema.hasTable('guest_accounts'))) {
    await instance.schema.createTable('guest_accounts', (t) => {
      t.increments('id').primary();
      t.string('guest_key', 64).notNullable().unique();
      t.string('guest_key_hash', 128).notNullable().unique();
      t.string('display_id', 16).notNullable();
      t.timestamp('banned_at').nullable();
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
      t.timestamp('last_seen_at').notNullable().defaultTo(instance.fn.now());
      t.index(['banned_at', 'last_seen_at']);
    });
  }
  if (!(await instance.schema.hasColumn('guest_accounts', 'guest_key'))) {
    await instance.schema.alterTable('guest_accounts', (t) => t.string('guest_key', 64).nullable());
  }
  if (await instance.schema.hasColumn('guest_accounts', 'matchmaking_restricted')) {
    await instance.schema.alterTable('guest_accounts', (t) => t.dropColumn('matchmaking_restricted'));
  }
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

  if (!(await instance.schema.hasTable('players'))) {
    await instance.schema.createTable('players', (t) => {
      t.increments('id').primary();
      t.string('nickname', 64).notNullable().unique();
      t.string('nationality', 64).notNullable();
      t.string('region', 32).notNullable().defaultTo('');
      t.string('team', 64).notNullable().defaultTo('');
      t.text('team_history').notNullable().defaultTo('[]');
      t.integer('age').notNullable();
      t.string('role', 32).notNullable().defaultTo('Rifler');
      t.integer('major_championships').notNullable().defaultTo(0);
      t.integer('major_appearances').notNullable().defaultTo(0);
      t.boolean('is_active').notNullable().defaultTo(true);
      t.boolean('is_enabled').notNullable().defaultTo(true);
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
  }
  if (!(await instance.schema.hasColumn('players', 'major_championships'))) {
    await instance.schema.alterTable('players', (t) => {
      t.integer('major_championships').notNullable().defaultTo(0);
    });
  }
  if (!(await instance.schema.hasColumn('players', 'is_enabled'))) {
    await instance.schema.alterTable('players', (t) => {
      t.boolean('is_enabled').notNullable().defaultTo(true);
    });
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

  if (!(await instance.schema.hasTable('games'))) {
    await instance.schema.createTable('games', (t) => {
      t.increments('id').primary();
      t.string('session_id', 64).nullable();
      t.integer('user_id').nullable().references('id').inTable('users');
      t.string('guest_key', 64).nullable().index();
      t.integer('target_player_id').notNullable().references('id').inTable('players');
      t.string('mode', 16).notNullable().defaultTo('easy');
      t.text('guesses').notNullable().defaultTo('[]');
      t.text('guess_times').notNullable().defaultTo('[]');
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
  if (!(await instance.schema.hasColumn('players', 'team_history'))) {
    await instance.schema.alterTable('players', (t) => {
      t.text('team_history').notNullable().defaultTo('[]');
    });
  }
  if (!(await instance.schema.hasColumn('games', 'guess_times'))) {
    await instance.schema.alterTable('games', (t) => t.text('guess_times').notNullable().defaultTo('[]'));
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
  if (!(await instance.schema.hasTable('player_change_submissions'))) {
    await instance.schema.createTable('player_change_submissions', (t) => {
      t.increments('id').primary();
      t.integer('api_token_id')
        .nullable()
        .references('id')
        .inTable('api_tokens')
        .onDelete('SET NULL');
      t.string('api_token_name', 64).notNullable();
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
  }
  if (!(await instance.schema.hasTable('player_change_items'))) {
    await instance.schema.createTable('player_change_items', (t) => {
      t.increments('id').primary();
      t.integer('submission_id')
        .notNullable()
        .references('id')
        .inTable('player_change_submissions')
        .onDelete('CASCADE');
      t.integer('player_id')
        .nullable()
        .references('id')
        .inTable('players')
        .onDelete('SET NULL');
      t.string('player_nickname', 64).notNullable();
      t.string('field', 32).notNullable();
      t.text('old_value').notNullable();
      t.text('new_value').notNullable();
      t.string('status', 16).notNullable().defaultTo('pending');
      t.integer('handled_by_user_id')
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL');
      t.timestamp('handled_at').nullable();
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
      t.index(['status', 'created_at'], 'player_change_items_status_created_idx');
      t.index(['player_id', 'field', 'status'], 'player_change_items_player_field_status_idx');
      t.index(['submission_id'], 'player_change_items_submission_idx');
    });
  }
  if (!(await instance.schema.hasColumn('games', 'first_guess_player_id'))) {
    await instance.schema.alterTable('games', (t) => t.integer('first_guess_player_id').nullable());
  }
  await instance.raw(
    'create unique index if not exists "games_session_id_unique" on "games" ("session_id")'
  );
  // Active single-player games now live only in Redis and are not historical records.
  await instance('games').where({ status: 'playing' }).del();

  if (!(await instance.schema.hasTable('match_records'))) {
    await instance.schema.createTable('match_records', (t) => {
      t.increments('id').primary();
      t.string('room_id', 64).notNullable();
      t.string('db_type', 16).notNullable().defaultTo('easy');
      t.integer('bo_type').notNullable().defaultTo(3);
      t.string('game_mode', 16).notNullable().defaultTo('classic');
      t.integer('total_rounds').notNullable().defaultTo(3);
      t.integer('relay_solved_rounds').notNullable().defaultTo(0);
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
      t.integer('winning_guess_sum').notNullable().defaultTo(0);
      t.integer('winning_rounds').notNullable().defaultTo(0);
      t.unique(['match_id', 'player_key']);
      t.index(['user_id', 'is_winner'], 'match_players_user_winner_idx');
    });
  }
  if (!(await instance.schema.hasColumn('match_records', 'game_mode'))) {
    await instance.schema.alterTable('match_records', (t) => t.string('game_mode', 16).notNullable().defaultTo('classic'));
  }
  if (!(await instance.schema.hasColumn('match_records', 'total_rounds'))) {
    await instance.schema.alterTable('match_records', (t) => t.integer('total_rounds').notNullable().defaultTo(3));
  }
  if (!(await instance.schema.hasColumn('match_records', 'relay_solved_rounds'))) {
    await instance.schema.alterTable('match_records', (t) => t.integer('relay_solved_rounds').notNullable().defaultTo(0));
  }
  await instance('match_records')
    .where('game_mode', 'classic')
    .update({ total_rounds: instance.ref('bo_type') });
  if (!(await instance.schema.hasColumn('match_players', 'winning_guess_sum'))) {
    await instance.schema.alterTable('match_players', (t) => {
      t.integer('winning_guess_sum').notNullable().defaultTo(0);
    });
  }
  if (!(await instance.schema.hasColumn('match_players', 'winning_rounds'))) {
    await instance.schema.alterTable('match_players', (t) => {
      t.integer('winning_rounds').notNullable().defaultTo(0);
    });
  }

  if (!(await instance.schema.hasTable('match_reports'))) {
    await instance.schema.createTable('match_reports', (t) => {
      t.increments('id').primary();
      t.integer('match_id').notNullable().references('id').inTable('match_records').onDelete('CASCADE');
      t.string('reporter_key', 80).notNullable();
      t.string('reported_key', 80).notNullable();
      t.string('description', 50).notNullable().defaultTo('');
      t.string('status', 16).notNullable().defaultTo('pending');
      t.string('admin_note', 500).nullable();
      t.integer('handled_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
      t.timestamp('handled_at').nullable();
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
  } else {
    if (!(await instance.schema.hasColumn('match_reports', 'description'))) {
      await instance.schema.alterTable('match_reports', (t) => t.string('description', 50).notNullable().defaultTo(''));
    }
    if (!(await instance.schema.hasColumn('match_reports', 'status'))) {
      await instance.schema.alterTable('match_reports', (t) => t.string('status', 16).notNullable().defaultTo('pending'));
    }
    if (!(await instance.schema.hasColumn('match_reports', 'admin_note'))) {
      await instance.schema.alterTable('match_reports', (t) => t.string('admin_note', 500).nullable());
    }
    if (!(await instance.schema.hasColumn('match_reports', 'handled_by_user_id'))) {
      await instance.schema.alterTable('match_reports', (t) => t.integer('handled_by_user_id').nullable());
    }
    if (!(await instance.schema.hasColumn('match_reports', 'handled_at'))) {
      await instance.schema.alterTable('match_reports', (t) => t.timestamp('handled_at').nullable());
    }
    if (!(await instance.schema.hasColumn('match_reports', 'created_at'))) {
      await instance.schema.alterTable('match_reports', (t) => t.timestamp('created_at').notNullable().defaultTo(instance.fn.now()));
    }
  }
  await instance.raw(
    'create unique index if not exists "match_reports_match_reporter_unique" on "match_reports" ("match_id", "reporter_key")'
  );
  await instance.raw(
    'create index if not exists "match_reports_status_created_idx" on "match_reports" ("status", "created_at")'
  );

  if (!(await instance.schema.hasTable('report_whitelist'))) {
    await instance.schema.createTable('report_whitelist', (t) => {
      t.string('identity_key', 80).primary();
      t.string('display_name', 64).notNullable().defaultTo('');
      t.string('admin_note', 500).nullable();
      t.integer('created_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
  } else {
    if (!(await instance.schema.hasColumn('report_whitelist', 'display_name'))) {
      await instance.schema.alterTable('report_whitelist', (t) => t.string('display_name', 64).notNullable().defaultTo(''));
    }
    if (!(await instance.schema.hasColumn('report_whitelist', 'admin_note'))) {
      await instance.schema.alterTable('report_whitelist', (t) => t.string('admin_note', 500).nullable());
    }
    if (!(await instance.schema.hasColumn('report_whitelist', 'created_by_user_id'))) {
      await instance.schema.alterTable('report_whitelist', (t) => t.integer('created_by_user_id').nullable());
    }
    if (!(await instance.schema.hasColumn('report_whitelist', 'created_at'))) {
      await instance.schema.alterTable('report_whitelist', (t) => t.timestamp('created_at').notNullable().defaultTo(instance.fn.now()));
    }
  }
  await instance.raw(
    'create index if not exists "report_whitelist_created_idx" on "report_whitelist" ("created_at")'
  );

  if (instance.client.config.client === 'pg') {
    await instance.raw(
      'alter table "match_records" alter column "room_id" type varchar(64)'
    );
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
      t.boolean('is_popup').notNullable().defaultTo(false);
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
    });
  }
  if (!(await instance.schema.hasColumn('announcements', 'is_popup'))) {
    await instance.schema.alterTable('announcements', (t) => {
      t.boolean('is_popup').notNullable().defaultTo(false);
    });
  }

  if (!(await instance.schema.hasTable('daily_challenges'))) {
    await instance.schema.createTable('daily_challenges', (t) => {
      t.increments('id').primary();
      t.string('challenge_date', 10).notNullable();
      t.string('difficulty_key', 32)
        .notNullable()
        .references('key')
        .inTable('difficulty_levels');
      t.integer('target_player_id')
        .notNullable()
        .references('id')
        .inTable('players');
      t.integer('solved_count').notNullable().defaultTo(0);
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
      t.unique(['challenge_date', 'difficulty_key']);
      t.index(['challenge_date']);
    });
  }
  const dailyChallengesHadSolvedCount = await instance.schema.hasColumn(
    'daily_challenges',
    'solved_count'
  );
  if (!dailyChallengesHadSolvedCount) {
    await instance.schema.alterTable('daily_challenges', (t) => {
      t.integer('solved_count').notNullable().defaultTo(0);
    });
  }

  if (!(await instance.schema.hasTable('daily_challenge_attempts'))) {
    await instance.schema.createTable('daily_challenge_attempts', (t) => {
      t.increments('id').primary();
      t.integer('challenge_id')
        .notNullable()
        .references('id')
        .inTable('daily_challenges')
        .onDelete('CASCADE');
      t.string('identity_key', 80).notNullable();
      t.integer('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
      t.string('guest_key', 64).nullable();
      t.string('display_name', 32).notNullable();
      t.string('status', 16).notNullable();
      t.integer('guess_count').notNullable();
      t.integer('solve_order').nullable();
      t.text('guesses').notNullable().defaultTo('[]');
      t.text('guess_times').notNullable().defaultTo('[]');
      t.timestamp('created_at').notNullable().defaultTo(instance.fn.now());
      t.timestamp('finished_at').notNullable().defaultTo(instance.fn.now());
      t.unique(['challenge_id', 'identity_key']);
      t.index(
        ['challenge_id', 'status', 'guess_count', 'finished_at', 'id'],
        'daily_attempts_leaderboard_idx'
      );
      t.index(['user_id', 'finished_at'], 'daily_attempts_user_finished_idx');
      t.index(['guest_key', 'finished_at'], 'daily_attempts_guest_finished_idx');
    });
  }
  const dailyAttemptsHadSolveOrder = await instance.schema.hasColumn(
    'daily_challenge_attempts',
    'solve_order'
  );
  if (!dailyAttemptsHadSolveOrder) {
    await instance.schema.alterTable('daily_challenge_attempts', (t) => {
      t.integer('solve_order').nullable();
    });
    if (instance.client.config.client === 'pg') {
      await instance.raw(`
        with ranked as (
          select
            "id",
            row_number() over (
              partition by "challenge_id"
              order by "finished_at" asc, "id" asc
            ) as "solve_order"
          from "daily_challenge_attempts"
          where "status" = 'won'
        )
        update "daily_challenge_attempts" as "attempt"
        set "solve_order" = "ranked"."solve_order"
        from "ranked"
        where "attempt"."id" = "ranked"."id"
      `);
    } else {
      await instance.raw(`
        with ranked as (
          select
            "id",
            row_number() over (
              partition by "challenge_id"
              order by "finished_at" asc, "id" asc
            ) as "solve_order"
          from "daily_challenge_attempts"
          where "status" = 'won'
        )
        update "daily_challenge_attempts"
        set "solve_order" = (
          select "ranked"."solve_order"
          from "ranked"
          where "ranked"."id" = "daily_challenge_attempts"."id"
        )
        where "id" in (select "id" from "ranked")
      `);
    }
  }
  if (!dailyChallengesHadSolvedCount || !dailyAttemptsHadSolveOrder) {
    await instance.raw(`
      update "daily_challenges"
      set "solved_count" = coalesce((
        select max("attempt"."solve_order")
        from "daily_challenge_attempts" as "attempt"
        where "attempt"."challenge_id" = "daily_challenges"."id"
      ), 0)
    `);
  }
  await instance.raw(
    'create unique index if not exists "daily_attempts_solve_order_unique" on "daily_challenge_attempts" ("challenge_id", "solve_order") where "solve_order" is not null'
  );

}
