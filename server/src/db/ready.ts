import { Knex } from 'knex';
import { db } from './knex';

const REQUIRED_COLUMNS: Record<string, string[]> = {
  users: ['id', 'username', 'password_hash', 'role', 'token_version', 'leaderboard_hidden', 'matchmaking_restricted', 'email', 'email_verified_at', 'banned_at'],
  email_verifications: ['id', 'user_id', 'email', 'token_hash', 'expires_at'],
  guest_accounts: ['id', 'guest_key', 'guest_key_hash', 'display_id', 'banned_at'],
  api_tokens: ['id', 'name', 'token_hash', 'prefix', 'created_by_user_id', 'expires_at'],
  players: [
    'id',
    'nickname',
    'age',
    'major_championships',
    'major_appearances',
    'team_history',
    'is_enabled',
  ],
  difficulty_levels: ['key', 'sort_order', 'is_enabled'],
  player_difficulties: ['player_id', 'difficulty_key'],
  player_change_submissions: ['id', 'api_token_id', 'api_token_name', 'created_at'],
  player_change_items: [
    'id',
    'submission_id',
    'player_id',
    'player_nickname',
    'field',
    'old_value',
    'new_value',
    'status',
    'handled_by_user_id',
    'handled_at',
    'created_at',
  ],
  games: ['id', 'session_id', 'user_id', 'guest_key', 'guess_times', 'first_guess_player_id', 'status'],
  match_records: [
    'id',
    'room_id',
    'db_type',
    'bo_type',
    'game_mode',
    'total_rounds',
    'relay_solved_rounds',
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
    'is_eliminated',
    'elimination_reason',
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
  daily_challenges: [
    'id',
    'challenge_date',
    'difficulty_key',
    'target_player_id',
    'solved_count',
    'created_at',
  ],
  daily_challenge_attempts: [
    'id',
    'challenge_id',
    'identity_key',
    'user_id',
    'guest_key',
    'display_name',
    'status',
    'guess_count',
    'solve_order',
    'guesses',
    'guess_times',
    'created_at',
    'finished_at',
  ],
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
