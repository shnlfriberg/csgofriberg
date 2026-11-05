import { z } from 'zod';
import { db } from '../../db/knex';
import type { Question } from '../types';

export const questionQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(40),
  mapId: z.string().max(64).optional(), floorId: z.string().max(64).optional(),
  pointId: z.string().max(160).optional(), search: z.string().max(160).optional(),
  status: z.enum(['draft', 'review', 'published', 'disabled']).optional(),
  tier: z.enum(['easy', 'medium', 'hard']).optional(),
  minU: z.coerce.number().min(0).max(1).optional(), maxU: z.coerce.number().min(0).max(1).optional(),
  minV: z.coerce.number().min(0).max(1).optional(), maxV: z.coerce.number().min(0).max(1).optional(),
}).superRefine((q, ctx) => {
  const bounds = [q.minU, q.maxU, q.minV, q.maxV];
  if (bounds.some(v => v !== undefined) && (!q.mapId || !q.floorId || bounds.some(v => v === undefined) || q.minU! > q.maxU! || q.minV! > q.maxV!))
    ctx.addIssue({ code: 'custom', message: 'Complete map, floor and bounds are required' });
});

export async function queryQuestions(q: z.infer<typeof questionQuery>) {
  const query = db('location_questions');
  for (const [input, column] of Object.entries({ mapId: 'map_id', floorId: 'floor_id', pointId: 'point_id', status: 'status', tier: 'tier' })) {
    const value = q[input as keyof typeof q]; if (value) query.where(column, value);
  }
  if (q.minU !== undefined) query.whereBetween('u', [q.minU - 1e-10, q.maxU! + 1e-10]).whereBetween('v', [q.minV! - 1e-10, q.maxV! + 1e-10]);
  if (q.search) {
    // Escape LIKE metacharacters so text search remains a literal substring match.
    const term = `%${q.search.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    query.where(function () { for (const column of ['id', 'point_id', 'source']) this.orWhereRaw(`lower(${column}) like ? escape '\\'`, [term]); });
  }
  const [total, rows, pending] = await Promise.all([
    query.clone().count({ count: '*' }).first(),
    query.clone().orderBy('id').limit(q.pageSize).offset((q.page - 1) * q.pageSize).select('payload'),
    db('location_questions').count({ count: '*' }).sum({ pending: db.raw("case when status in ('draft', 'review') then 1 else 0 end") }).first(),
  ]);
  const items = rows.map(row => JSON.parse(row.payload) as Question);
  const counts: Record<string, number> = {};
  if (items.length) {
    const groups = await db('location_questions').where(function () {
      for (const item of items) this.orWhere({ map_id: item.mapId, point_id: item.capturePointId });
    }).groupBy('map_id', 'point_id').select('map_id', 'point_id').count({ count: '*' }) as unknown as Array<{ map_id: string; point_id: string; count: number }>;
    for (const row of groups) counts[JSON.stringify([row.map_id, row.point_id])] = Number(row.count);
  }
  return { items, total: Number(total?.count ?? 0), totalAll: Number(pending?.count ?? 0), pending: Number(pending?.pending ?? 0), page: q.page, pageSize: q.pageSize, pointCounts: counts };
}
