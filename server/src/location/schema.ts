import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { MapDefinition } from './types';
import catalog from './catalog.json';
import { ensureLocationProjections } from './projections';
import { ensurePointModels } from './pointStore';

export const STARTER_MAPS = catalog as MapDefinition[];
// Readiness and local maintenance share this inventory. Schema tests verify it stays complete.
export const LOCATION_REQUIRED_COLUMNS: Record<string, string[]> = {
  location_maps: ['id', 'payload'],
  location_versions: ['key', 'payload'],
  location_questions: ['id', 'image_hash', 'payload', 'map_id', 'floor_id', 'point_id', 'map_version', 'status', 'tier', 'u', 'v', 'source'],
  location_capture_drafts: ['id', 'payload', 'map_id', 'floor_id', 'point_id', 'map_version', 'u', 'v'],
  location_daily: ['date', 'payload'],
  location_progress: ['identity_key', 'date', 'difficulty', 'payload', 'game_id', 'expires_at', 'status', 'storage_version'],
  location_results: ['game_id', 'identity_key', 'score', 'payload', 'rank', 'retired'],
  location_daily_attempts: ['identity_key', 'date', 'difficulty', 'game_id'],
  location_submissions: ['id', 'identity_key', 'user_id', 'guest_key', 'name', 'image_hash', 'request_hash', 'created_at', 'payload'],
  location_contributions: ['id', 'identity_key', 'user_id', 'guest_key', 'name', 'question_id', 'request_hash', 'accepted_at'],
  location_asset_tasks: ['url', 'attempts', 'due_at', 'last_error'],
  location_catalog_revision: ['id', 'revision'],
  location_result_outbox: ['game_id', 'payload', 'attempts', 'due_at', 'last_error'],
  location_replay_snapshots: ['hash', 'payload'],
  location_points: ['map_id', 'point_id', 'version', 'payload'],
  location_point_versions: ['map_id', 'point_id', 'version', 'payload'],
  location_progress_archive: ['identity_key', 'date', 'difficulty', 'game_id', 'payload'],
};
export async function ensureLocationSchema(instance: Knex = db): Promise<void> {
  if (!(await instance.schema.hasTable('location_progress_archive'))) await instance.schema.createTable('location_progress_archive', t => {
    t.string('identity_key', 150); t.string('date', 10); t.string('difficulty', 10);
    t.string('game_id', 64).notNullable(); t.text('payload').notNullable();
    t.primary(['identity_key', 'date', 'difficulty']); t.index(['identity_key', 'game_id']);
  });
  if (!(await instance.schema.hasTable('location_replay_snapshots'))) await instance.schema.createTable('location_replay_snapshots', t => {
    t.string('hash', 64).primary(); t.text('payload').notNullable();
  });
  if (!(await instance.schema.hasTable('location_result_outbox'))) await instance.schema.createTable('location_result_outbox', t => {
    t.string('game_id', 64).primary(); t.text('payload').notNullable();
    t.integer('attempts').notNullable().defaultTo(0); t.bigInteger('due_at').notNullable().index(); t.string('last_error', 500).nullable();
  });
  if (!(await instance.schema.hasTable('location_asset_tasks'))) await instance.schema.createTable('location_asset_tasks', (t) => {
    t.string('url', 160).primary(); t.integer('attempts').notNullable().defaultTo(0);
    t.bigInteger('due_at').notNullable().index(); t.string('last_error', 500).nullable();
  });
  if (!(await instance.schema.hasTable('location_submissions')))
    await instance.schema.createTable('location_submissions', (t) => {
      t.string('id', 64).primary();
      t.string('identity_key', 150).notNullable();
      t.integer('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
      t.string('guest_key', 64).nullable();
      t.string('name', 64).notNullable();
      t.string('image_hash', 64).notNullable().unique();
      t.string('request_hash', 64).notNullable();
      t.bigInteger('created_at').notNullable();
      t.text('payload').notNullable();
      t.index(['identity_key', 'created_at']);
    });
  if (!(await instance.schema.hasTable('location_contributions')))
    await instance.schema.createTable('location_contributions', (t) => {
      t.string('id', 64).primary();
      t.string('identity_key', 150).notNullable();
      t.integer('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
      t.string('guest_key', 64).nullable();
      t.string('name', 64).notNullable();
      // Credits are cumulative, even when a question is later disabled or removed.
      t.string('question_id', 64).notNullable().unique();
      t.string('request_hash', 64).notNullable();
      t.bigInteger('accepted_at').notNullable();
      t.index(['identity_key', 'accepted_at']);
    });
  if (!(await instance.schema.hasTable('location_maps')))
    await instance.schema.createTable('location_maps', (t) => {
      t.string('id', 64).primary();
      t.text('payload').notNullable();
    });
  if (!(await instance.schema.hasTable('location_versions')))
    await instance.schema.createTable('location_versions', (t) => {
      t.string('key', 100).primary();
      t.text('payload').notNullable();
    });
  if (!(await instance.schema.hasTable('location_questions')))
    await instance.schema.createTable('location_questions', (t) => {
      t.string('id', 64).primary();
      t.string('image_hash', 64).notNullable().unique();
      t.text('payload').notNullable();
    });
  if (!(await instance.schema.hasTable('location_capture_drafts')))
    await instance.schema.createTable('location_capture_drafts', (t) => {
      t.string('id', 64).primary();
      t.text('payload').notNullable();
    });
  if (!(await instance.schema.hasTable('location_daily')))
    await instance.schema.createTable('location_daily', (t) => {
      t.string('date', 10).primary();
      t.text('payload').notNullable();
    });
  if (!(await instance.schema.hasTable('location_progress')))
    await instance.schema.createTable('location_progress', (t) => {
      t.string('identity_key', 150);
      t.string('date', 10);
      t.string('difficulty', 10);
      t.text('payload').notNullable();
      t.primary(['identity_key', 'date', 'difficulty']);
    });
  if (!(await instance.schema.hasTable('location_results')))
    await instance.schema.createTable('location_results', (t) => {
      t.string('game_id', 64);
      t.string('identity_key', 150);
      t.integer('user_id')
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE');
      t.string('mode', 16);
      t.string('difficulty', 10);
      t.string('date', 10).nullable();
      t.integer('score').notNullable();
      t.bigInteger('finished_at').notNullable();
      t.text('payload').notNullable();
      t.primary(['game_id', 'identity_key']);
      t.index(['identity_key', 'finished_at']);
      t.index(['date', 'difficulty', 'score']);
    });
  if (!(await instance.schema.hasTable('location_daily_attempts')))
    await instance.schema.createTable('location_daily_attempts', (t) => {
      t.string('identity_key', 150);
      t.string('date', 10);
      t.string('difficulty', 10);
      t.string('game_id', 64).notNullable();
      t.primary(['identity_key', 'date', 'difficulty']);
    });
  await ensureLocationProjections(instance);
  await ensurePointModels(instance);
  for (const map of STARTER_MAPS) {
    const existing = await instance('location_maps')
      .where({ id: map.id })
      .first();
    if (existing) {
      const previous: MapDefinition = JSON.parse(existing.payload);
      if (
        previous.version === 1 &&
        previous.floors.every((floor) => !floor.radarUrl) &&
        previous.calibration.points.length === 0
      ) {
        const upgraded = {
          ...map,
          enabled: previous.enabled,
          order: previous.order,
          version: 2,
        };
        await instance('location_maps')
          .where({ id: map.id })
          .update({ payload: JSON.stringify(upgraded) });
        await instance('location_versions')
          .insert({ key: `map:${map.id}:2`, payload: JSON.stringify(upgraded) })
          .onConflict('key')
          .ignore();
      }
    }
    await instance('location_maps')
      .insert({ id: map.id, payload: JSON.stringify(map) })
      .onConflict('id')
      .ignore();
    await instance('location_versions')
      .insert({ key: `map:${map.id}:1`, payload: JSON.stringify(map) })
      .onConflict('key')
      .ignore();
  }
}
