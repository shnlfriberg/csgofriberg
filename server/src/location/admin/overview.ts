import { captureCounts } from './captureQueries';
import { bankAvailability } from '../bankAvailability';
import { dayWindow } from '../rules';
import { db } from '../../db/knex';
import { verifyAsset } from '../assets';
import { calibrationValid } from '../rules';
import { maps, questions } from '../store';
import { freezeSnapshot } from '../immutable';
import type {
  AdminOverview,
  BankChecks,
  DailyAssignment,
} from '../types';

// Ordinary editor refreshes read metadata only. Image integrity checks run on demand.
export async function getOverview(compact = false, includeDaily = false): Promise<AdminOverview> {
  if (!compact || includeDaily) return buildOverview(compact, includeDaily);
  const revision = String((await db('location_catalog_revision').where({ id: 1 }).first())?.revision ?? -1);
  if (overviewCache?.revision === revision && revision !== '-1') return overviewCache.value;
  const value = freezeSnapshot(await buildOverview(true, false));
  overviewCache = { revision, value };
  return value;
}
let overviewCache: { revision: string; value: AdminOverview } | null = null;
async function buildOverview(compact: boolean, includeDaily: boolean): Promise<AdminOverview> {
  const [catalog, items, capture, dailyRows] = await Promise.all([
    maps(),
    compact ? db('location_questions').select('map_id', 'map_version', 'status', 'tier').then(rows => rows.map(row => ({ mapId: row.map_id, mapVersion: row.map_version, status: row.status, tier: row.tier } as import('../types').Question))) : questions(),
    captureCounts(),
    compact && !includeDaily ? Promise.resolve([]) : db('location_daily').orderBy('date', 'desc').limit(7).select('payload'),
  ]);
  return {
    ...(compact ? { questionPoints: (await db('location_questions').groupBy('map_id', 'point_id').select('map_id', 'point_id').count({ count: '*' }) as unknown as Array<{ map_id: string; point_id: string; count: number }>).map(row => ({ mapId: row.map_id, capturePointId: row.point_id, count: Number(row.count) })) } : {}),
    maps: catalog,
    questions: compact ? [] : items,
    capture,
    counts: catalog.map((map) => {
      const published = items.filter(
        (q) =>
          q.mapId === map.id &&
          q.status === 'published' &&
          q.mapVersion === map.version
      );
      return {
        mapId: map.id,
        calibrationValid: calibrationValid(map),
        easy: published.filter((q) => q.tier === 'easy').length,
        medium: published.filter((q) => q.tier === 'medium').length,
        hard: published.filter((q) => q.tier === 'hard').length,
        stale: items.filter(
          (q) => q.mapId === map.id && q.mapVersion !== map.version
        ).length,
      };
    }),
    daily: dailyRows.map((row) => JSON.parse(row.payload) as DailyAssignment),
  };
}

export async function checkBank(): Promise<BankChecks> {
  const overview = await getOverview();
  const missingAssets: string[] = [];
  for (const question of overview.questions) {
    try {
      if ((await verifyAsset(question.imageUrl)) !== question.imageHash)
        throw new Error('hash');
      await verifyAsset(question.thumbnailUrl);
    } catch {
      missingAssets.push(question.id);
    }
  }
  const available = overview.questions.flatMap((question) => {
    const map = overview.maps.find((m) => m.id === question.mapId && m.enabled);
    return map &&
      question.status === 'published' &&
      question.mapVersion === map.version &&
      !missingAssets.includes(question.id)
      ? [{ question, map }]
      : [];
  });
  const fixed = await db('location_daily').where({ date: dayWindow().date }).first('payload');
  return { missingAssets, ...bankAvailability(available, fixed ? JSON.parse(fixed.payload) : null) };
}
