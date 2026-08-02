import { Knex } from 'knex';
import { db } from './knex';

const REQUIRED_COLUMNS: Record<string, string[]> = {
  users: ['id', 'username', 'password_hash', 'role', 'token_version', 'leaderboard_hidden', 'matchmaking_restricted', 'email', 'email_verified_at', 'banned_at'],
  email_verifications: ['id', 'user_id', 'email', 'token_hash', 'expires_at'],
  guest_accounts: ['id', 'guest_key', 'guest_key_hash', 'display_id', 'banned_at', 'matchmaking_restricted'],
  api_tokens: ['id', 'name', 'token_hash', 'prefix', 'created_by_user_id', 'expires_at'],
  app_migrations: ['name', 'applied_at'],
  players: [
    'id',
    'nickname',
    'age',
    'major_championships',
    'major_appearances',
    'is_enabled',
  ],
  difficulty_levels: ['key', 'sort_order', 'is_enabled'],
  player_difficulties: ['player_id', 'difficulty_key'],
  games: ['id', 'session_id', 'user_id', 'guest_key', 'guess_times', 'first_guess_player_id', 'status'],
  match_records: [
    'id',
    'room_id',
    'db_type',
    'bo_type',
    'winner_id',
    'winner_key',
    'finish_reason',
    'forfeited_key',
    'replay',
  ],
  match_players: [
    'id',
    'match_id',
    'player_key',
    'is_winner',
    'winning_guess_sum',
    'winning_rounds',
  ],
  match_reports: [
    'id',
    'match_id',
    'reporter_key',
    'reported_key',
    'description',
    'status',
    'admin_note',
    'handled_by_user_id',
    'handled_at',
    'created_at',
  ],
  report_whitelist: ['identity_key', 'display_name', 'admin_note', 'created_by_user_id', 'created_at'],
  announcements: ['id', 'title', 'content', 'is_popup'],
};

/** Applications only verify the migrated schema; DDL remains owned by the migrate service. */
export async function assertDatabaseReady(instance: Knex = db): Promise<void> {
  await instance.raw('select 1');
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!(await instance.schema.hasTable(table))) {
      missing.push(table);
      continue;
    }
    for (const column of columns) {
      if (!(await instance.schema.hasColumn(table, column))) missing.push(`${table}.${column}`);
    }
  }
  if (missing.length) throw new Error(`DATABASE_SCHEMA_NOT_READY:${missing.join(',')}`);
}
