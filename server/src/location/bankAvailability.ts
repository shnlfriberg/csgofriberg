import { DIFFICULTIES, sample, sampleDaily } from './rules';
import type { BankChecks, DailyAssignment, QuestionSnapshot } from './types';

/** Read-only simulation: never creates or replaces a daily assignment. */
export function bankAvailability(pool: QuestionSnapshot[], daily: DailyAssignment | null) {
  let decks = daily?.decks;
  if (!decks) { try { decks = sampleDaily(pool, () => 0); } catch { /* Report insufficient pool. */ } }
  const reserved = new Set(Object.values(decks ?? {}).flat().flatMap(item => [item.question.id, `point:${item.map.id}:${item.question.capturePointId}`]));
  const feasible = (excluded: Set<string>) => Object.fromEntries(DIFFICULTIES.map(difficulty => {
    try { sample(pool, difficulty, excluded, () => 0); return [difficulty, true]; }
    catch { return [difficulty, false]; }
  })) as BankChecks['compositions'];
  const pointKey = (item: QuestionSnapshot) => `point:${item.map.id}:${item.question.capturePointId}`;
  return {
    compositions: feasible(new Set()), dailyAvailable: Boolean(decks),
    randomAfterDaily: feasible(reserved), dailySource: daily ? 'fixed' as const : 'simulation' as const,
    uniquePoints: new Set(pool.map(pointKey)).size,
    reservedPoints: new Set(Object.values(decks ?? {}).flat().map(pointKey)).size,
    remainingByTier: Object.fromEntries(['easy', 'medium', 'hard'].map(tier => [tier,
      new Set(pool.filter(item => item.question.tier === tier && !reserved.has(item.question.id) && !reserved.has(pointKey(item))).map(pointKey)).size,
    ])) as Record<'easy' | 'medium' | 'hard', number>,
  };
}
