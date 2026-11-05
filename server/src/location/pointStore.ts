import type { Knex } from 'knex';
import type { CaptureDraft, Question } from './types';

type PointSource = Pick<Question | CaptureDraft, 'mapId' | 'capturePointId' | 'floorId' | 'mapVersion' | 'u' | 'v' | 'world'>;
export async function savePointModels(trx: Knex, sources: PointSource[]) {
  for (const source of sources) {
    const key = { map_id: source.mapId, point_id: source.capturePointId };
    if (!key.map_id || !key.point_id) continue;
    const value = { mapId: source.mapId, capturePointId: source.capturePointId, floorId: source.floorId,
      mapVersion: source.mapVersion, u: source.u, v: source.v, ...(source.world ? { world: source.world } : {}) };
    const payload = JSON.stringify(value);
    const old = await trx('location_points').where(key).first();
    if (old?.payload === payload) continue;
    const version = Number(old?.version || 0) + 1;
    await trx('location_points').insert({ ...key, version, payload }).onConflict(['map_id', 'point_id']).merge();
    await trx('location_point_versions').insert({ ...key, version, payload });
  }
}

export async function ensurePointModels(db: Knex) {
  const fresh = !await db.schema.hasTable('location_points');
  if (fresh) await db.schema.createTable('location_points', t => {
    t.string('map_id', 64); t.string('point_id', 160); t.integer('version').notNullable(); t.text('payload').notNullable(); t.primary(['map_id', 'point_id']);
  });
  if (!await db.schema.hasTable('location_point_versions')) await db.schema.createTable('location_point_versions', t => {
    t.string('map_id', 64); t.string('point_id', 160); t.integer('version'); t.text('payload').notNullable(); t.primary(['map_id', 'point_id', 'version']);
  });
  if (fresh) await db.transaction(async trx => {
    const sources: PointSource[] = [];
    for (const table of ['location_capture_drafts', 'location_questions']) {
      for (const row of await trx(table).select('payload')) sources.push(JSON.parse(row.payload));
    }
    const points = new Map<string, PointSource>();
    for (const source of sources) {
      const key = JSON.stringify([source.mapId, source.capturePointId]);
      if (!points.get(key)?.world || source.world) points.set(key, source);
    }
    await savePointModels(trx, [...points.values()]);
  });
}
