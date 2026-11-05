import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import type { CaptureDraft, MapDefinition, Question } from '../types';
import { worldToRadar } from '../coordinates';

export interface PointGroup { questions: Question[]; drafts: CaptureDraft[] }
export const pointFingerprint = (group: PointGroup) => createHash('sha256').update(JSON.stringify(group)).digest('hex');

export async function readPointGroups(connection: Knex, mapId: string, ids?: string[]) {
  const groups = new Map<string, PointGroup>();
  for (const [table, field] of [['location_questions', 'questions'], ['location_capture_drafts', 'drafts']] as const) {
    const query = connection(table).where({ map_id: mapId }).orderBy('id').select('payload');
    if (ids) query.whereIn('point_id', ids);
    for (const row of await query) {
      const value = JSON.parse(row.payload);
      const group = groups.get(value.capturePointId) || { questions: [], drafts: [] };
      group[field].push(value); groups.set(value.capturePointId, group);
    }
  }
  return groups;
}

/** Matches the established measured-point priority; callers validate map/floor first. */
export function existingPointPosition(group: PointGroup, map: MapDefinition) {
  const measured = group.drafts.find(p => p.world) || group.questions.find(p => p.world);
  if (measured?.world) return { ...worldToRadar(map, measured.world), world: measured.world };
  const anchor = group.questions[0] || group.drafts[0];
  return { u: anchor.u, v: anchor.v };
}
