import type { Knex } from 'knex';

// Additive read models. JSON remains the lossless source for existing records.
const fields: Record<string, Record<string, [string, string]>> = {
  location_questions: {
    map_id: ['mapId', 'text'], floor_id: ['floorId', 'text'], point_id: ['capturePointId', 'text'],
    map_version: ['mapVersion', 'integer'], status: ['status', 'text'], tier: ['tier', 'text'],
    u: ['u', 'real'], v: ['v', 'real'], source: ['source', 'text'],
  },
  location_capture_drafts: {
    map_id: ['mapId', 'text'], floor_id: ['floorId', 'text'], point_id: ['capturePointId', 'text'],
    map_version: ['mapVersion', 'integer'], u: ['u', 'real'], v: ['v', 'real'],
  },
  location_progress: { game_id: ['id', 'text'], expires_at: ['expiresAt', 'bigint'], status: ['status', 'text'], storage_version: ['storageVersion', 'integer'] },
  location_results: { rank: ['rank', 'integer'], retired: ['retired', 'boolean'] },
};

export async function ensureLocationProjections(db: Knex) {
  const pg = db.client.config.client === 'pg';
  for (const [table, columns] of Object.entries(fields)) {
    let added = false;
    for (const [name, [, type]] of Object.entries(columns)) {
      if (await db.schema.hasColumn(table, name)) continue;
      await db.schema.alterTable(table, t => { t.specificType(name, pg && type === 'real' ? 'double precision' : type).nullable(); });
      added = true;
    }
    const extract = (path: string, type: string, prefix = '') => pg
      ? `cast(${prefix}payload::jsonb ->> '${path}' as ${type === 'real' ? 'double precision' : type})`
      : `json_extract(${prefix}payload, '$.${path}')`;
    const assignments = (prefix = '') => Object.entries(columns).map(([name, [path, type]]) =>
      `${name} = ${extract(path, type, prefix)}`).join(', ');
    // Only projection columns are updated during backfill, never payload or history.
    const [firstName, [firstPath, firstType]] = Object.entries(columns)[0];
    await db.raw(`update ${table} set ${assignments()} ${added ? '' : `where ${firstName} is null and ${extract(firstPath, firstType)} is not null`}`);
    if (pg) {
      const body = Object.entries(columns).map(([name, [path, type]]) => `NEW.${name} := ${extract(path, type, 'NEW.')};`).join('\n');
      await db.raw(`create or replace function ${table}_project() returns trigger language plpgsql as $$ begin ${body} return NEW; end $$`);
      await db.raw(`drop trigger if exists ${table}_project on ${table}`);
      await db.raw(`create trigger ${table}_project before insert or update of payload on ${table} for each row execute function ${table}_project()`);
    } else {
      for (const event of ['insert', 'update of payload']) {
        if (added) await db.raw(`drop trigger if exists ${table}_project_${event.split(' ')[0]}`);
        await db.raw(`create trigger if not exists ${table}_project_${event.split(' ')[0]} after ${event} on ${table} begin update ${table} set ${assignments('NEW.')} where rowid = NEW.rowid; end`);
      }
    }
    const indexes = table === 'location_progress' ? [['identity_key', 'game_id'], ['storage_version', 'expires_at']]
      : table === 'location_results' ? [['difficulty', 'mode', 'rank', 'retired']]
      : [['map_id', 'point_id'], ['map_id', 'floor_id', 'u', 'v'], ...(table === 'location_questions' ? [['status', 'map_id', 'map_version', 'tier']] : [])];
    for (const columns of indexes) await db.raw(`create index if not exists ${table}_${columns.join('_')}_idx on ${table} (${columns.join(', ')})`);
  }
  if (!await db.schema.hasTable('location_catalog_revision')) {
    await db.schema.createTable('location_catalog_revision', t => { t.integer('id').primary(); t.bigInteger('revision').notNullable(); });
  }
  await db('location_catalog_revision').insert({ id: 1, revision: 0 }).onConflict('id').ignore();
  await db('location_catalog_revision').insert({ id: 2, revision: 0 }).onConflict('id').ignore();
  for (const table of ['location_maps', 'location_questions', 'location_capture_drafts', 'location_results', 'location_contributions']) {
    const revisionId = ['location_results', 'location_contributions'].includes(table) ? 2 : 1;
    const updateEvent = table === 'location_contributions' ? 'update' : 'update of payload';
    if (pg) {
      await db.raw(`create or replace function location_catalog_changed_${revisionId}() returns trigger language plpgsql as $$ begin update location_catalog_revision set revision = revision + 1 where id = ${revisionId}; return null; end $$`);
      await db.raw(`drop trigger if exists ${table}_revision on ${table}`);
      await db.raw(`create trigger ${table}_revision after insert or delete or ${updateEvent} on ${table} for each row execute function location_catalog_changed_${revisionId}()`);
    } else for (const event of ['insert', 'delete', updateEvent]) await db.raw(
      `create trigger if not exists ${table}_revision_${event.split(' ')[0]} after ${event} on ${table} begin update location_catalog_revision set revision = revision + 1 where id = ${revisionId}; end`);
  }
}
