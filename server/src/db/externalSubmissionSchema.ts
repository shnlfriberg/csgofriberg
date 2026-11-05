import type { Knex } from 'knex';

export const EXTERNAL_REQUIRED_COLUMNS = {
  external_submission_requests: ['token_id', 'request_key', 'payload_hash', 'response', 'created_at'],
};

// Additive only; null scopes retain the permissions of pre-migration tokens.
export async function ensureExternalSubmissionSchema(db: Knex): Promise<void> {
  if (!await db.schema.hasColumn('api_tokens', 'scopes'))
    await db.schema.alterTable('api_tokens', t => { t.text('scopes').nullable(); });
  if (!await db.schema.hasColumn('player_change_items', 'observed_value'))
    await db.schema.alterTable('player_change_items', t => { t.text('observed_value').nullable(); });
  if (!await db.schema.hasTable('external_submission_requests'))
    await db.schema.createTable('external_submission_requests', t => {
      t.integer('token_id').notNullable();
      t.string('request_key', 200).notNullable();
      t.string('payload_hash', 64).notNullable();
      t.text('response').nullable();
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
      t.primary(['token_id', 'request_key']);
    });
}
