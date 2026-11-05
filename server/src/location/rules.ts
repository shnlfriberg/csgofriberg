import { randomInt } from 'crypto';
import { inspectCalibration } from './calibration';
import { HttpError } from '../middleware/common';
import type {
  Difficulty,
  Guess,
  MapDefinition,
  QuestionSnapshot,
  RoundResult,
  Tier,
} from './types';

export const MIX: Record<Difficulty, Record<Tier, number>> = {
  easy: { easy: 3, medium: 1, hard: 1 },
  normal: { easy: 2, medium: 2, hard: 1 },
  hard: { easy: 1, medium: 2, hard: 2 },
};
export const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export function shuffle<T>(items: T[], pick = randomInt): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function sample(
  pool: QuestionSnapshot[],
  difficulty: Difficulty,
  excluded = new Set<string>(),
  pick = randomInt
): QuestionSnapshot[] {
  const tiers = shuffle(
    Object.entries(MIX[difficulty]).flatMap(([tier, count]) =>
      Array<Tier>(count).fill(tier as Tier)
    ),
    pick
  );
  return selectTiers(pool, tiers, excluded, pick);
}
export function sampleDaily(
  pool: QuestionSnapshot[],
  pick = randomInt
): Record<Difficulty, QuestionSnapshot[]> {
  const tiers = DIFFICULTIES.flatMap((difficulty) =>
    shuffle(
      Object.entries(MIX[difficulty]).flatMap(([tier, count]) =>
        Array<Tier>(count).fill(tier as Tier)
      ),
      pick
    )
  );
  const deck = selectTiers(pool, tiers, new Set(), pick);
  return {
    easy: deck.slice(0, 5),
    normal: deck.slice(5, 10),
    hard: deck.slice(10, 15),
  };
}
function selectTiers(
  pool: QuestionSnapshot[],
  tiers: Tier[],
  excluded: Set<string>,
  pick: typeof randomInt
): QuestionSnapshot[] {
  const candidatesPool = pool.filter(
    ({ question, map }) =>
      map.enabled &&
      question.status === 'published' &&
      !excluded.has(question.id) &&
      !excluded.has(`point:${map.id}:${question.capturePointId}`)
  );
  // Backtracking avoids greedy choices exhausting the sole remaining capture point of another tier.
  const visit = (
    index: number,
    result: QuestionSnapshot[],
    usedPoints: Set<string>
  ): QuestionSnapshot[] | null => {
    if (index === tiers.length) return result;
    const remaining = tiers.slice(index);
    const tierNames: Tier[] = ['easy', 'medium', 'hard'];
    for (let mask = 1; mask < 8; mask++) {
      const selected = new Set(tierNames.filter((_, bit) => mask & (1 << bit)));
      const required = remaining.filter((tier) => selected.has(tier)).length;
      const points = new Set(
        candidatesPool
          .filter(
            ({ question, map }) =>
              selected.has(question.tier) &&
              !usedPoints.has(`${map.id}:${question.capturePointId}`)
          )
          .map(({ question, map }) => `${map.id}:${question.capturePointId}`)
      );
      if (points.size < required) return null;
    }
    const usedMaps = new Set(
      result.slice(Math.floor(index / 5) * 5).map((item) => item.map.id)
    );
    const candidates = shuffle(
      candidatesPool.filter(
        ({ question, map }) =>
          question.tier === tiers[index] &&
          !usedPoints.has(`${map.id}:${question.capturePointId}`)
      ),
      pick
    );
    const mapOrder = shuffle(
      [...new Set(candidates.map((item) => item.map.id))],
      pick
    ).sort((a, b) => Number(usedMaps.has(a)) - Number(usedMaps.has(b)));
    for (const mapId of mapOrder)
      for (const candidate of candidates.filter(
        (item) => item.map.id === mapId
      )) {
        const next = visit(
          index + 1,
          [...result, candidate],
          new Set([
            ...usedPoints,
            `${mapId}:${candidate.question.capturePointId}`,
          ])
        );
        if (next) return next;
      }
    return null;
  };
  const result = visit(0, [], new Set());
  if (!result) throw new HttpError(409, 'LOCATION_POOL_INSUFFICIENT');
  return result;
}
export function dayWindow(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600_000);
  const date = shifted.toISOString().slice(0, 10);
  const startsAt = Date.parse(`${date}T00:00:00+08:00`);
  return { date, startsAt, nextRefreshAt: startsAt + 86400_000 };
}
export function assertGuess(guess: Guess, maps: MapDefinition[]): void {
  const map = maps.find((item) => item.id === guess.mapId);
  if (
    !map ||
    !map.floors.some((floor) => floor.id === guess.floorId) ||
    !Number.isFinite(guess.u) ||
    !Number.isFinite(guess.v) ||
    guess.u < 0 ||
    guess.u > 1 ||
    guess.v < 0 ||
    guess.v > 1
  )
    throw new HttpError(400, 'LOCATION_INVALID_GUESS');
}
export function score(
  snapshot: QuestionSnapshot,
  guess: Guess | null,
  maps: MapDefinition[],
  round: number
): RoundResult {
  const { question, map } = snapshot;
  const mapCorrect = guess?.mapId === map.id;
  const floorCorrect = mapCorrect && guess?.floorId === question.floorId;
  const diagonal = Math.hypot(
    map.bounds.width * map.width,
    map.bounds.height * map.height
  );
  const distanceRatio = mapCorrect
    ? Math.hypot(
        (guess!.u - question.u) * map.width,
        (guess!.v - question.v) * map.height
      ) / diagonal
    : null;
  const points =
    distanceRatio === null
      ? 0
      : Math.max(
          1,
          Math.round(
            5000 *
              Math.exp(-5 * Math.max(0, distanceRatio - 0.005)) *
              (floorCorrect ? 1 : 0.25)
          )
        );
  return {
    round,
    imageUrl: question.imageUrl,
    questionId: question.id,
    questionVersion: question.version,
    tier: question.tier,
    guess,
    answer: {
      mapId: map.id,
      floorId: question.floorId,
      u: question.u,
      v: question.v,
    },
    map,
    guessedMap: maps.find((item) => item.id === guess?.mapId) ?? null,
    score: points,
    distanceRatio,
    mapCorrect,
    floorCorrect,
  };
}
export function calibrationValid(map: MapDefinition): boolean {
  return inspectCalibration(map).valid;
}
