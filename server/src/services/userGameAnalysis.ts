import type { Player } from '../types';

// Keep the benchmark bounded while covering the full catalog in normal deployments.
const MAX_BENCHMARK_GUESSES = 1000;
const MAX_ANALYZED_STEPS = 60;
const BENCHMARK_CHUNK_SIZE = 64;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface AnalysisRoundInput {
  source: 'single' | 'multi';
  recordId: number;
  mode: string;
  finishedAt: string;
  round: number;
  targetPlayerId: number;
  guessPlayerIds: number[];
}

export interface AnalysisStep {
  guessNumber: number;
  guessPlayerId: number;
  guessNickname: string;
  candidateCountBefore: number;
  candidateCountAfter: number;
  informationGain: number;
  bestInformationGain: number;
  entropyPercentile: number;
  bestGuessPlayerId: number;
  bestGuessNickname: string;
}

export interface AnalysisTrajectory {
  source: 'single' | 'multi';
  recordId: number;
  mode: string;
  finishedAt: string;
  round: number;
  targetPlayerId: number;
  targetNickname: string;
  steps: AnalysisStep[];
}

function feedbackSignature(guess: Player, target: Player): string {
  const numberPart = (guessValue: number, targetValue: number, closeRange: number) => {
    if (guessValue === targetValue) return 'c';
    return `${Math.abs(guessValue - targetValue) <= closeRange ? 'n' : 'w'}${targetValue > guessValue ? 'h' : 'l'}`;
  };
  const nationality = guess.nationality === target.nationality
    ? 'c'
    : guess.region && guess.region === target.region ? 'n' : 'w';
  return [
    guess.id === target.id ? '1' : '0',
    nationality,
    guess.team === target.team ? 'c' : 'w',
    numberPart(guess.age, target.age, 3),
    guess.role === target.role ? 'c' : 'w',
    numberPart(guess.major_championships, target.major_championships, 1),
    numberPart(guess.major_appearances, target.major_appearances, 1),
    Boolean(guess.is_active) === Boolean(target.is_active) ? 'c' : 'w',
  ].join('|');
}

function informationGain(guess: Player, candidates: Player[]): number {
  if (candidates.length <= 1) return 0;
  const partitions = new Map<string, number>();
  for (const target of candidates) {
    const signature = feedbackSignature(guess, target);
    partitions.set(signature, (partitions.get(signature) ?? 0) + 1);
  }
  let expectedRemainingEntropy = 0;
  for (const count of partitions.values()) {
    const probability = count / candidates.length;
    expectedRemainingEntropy += probability * Math.log2(count);
  }
  return Math.log2(candidates.length) - expectedRemainingEntropy;
}

function benchmarkGuesses(allGuesses: Player[], actual: Player): Player[] {
  if (allGuesses.length <= MAX_BENCHMARK_GUESSES) return allGuesses;
  const selected: Player[] = [];
  const used = new Set<number>();
  for (let index = 0; index < MAX_BENCHMARK_GUESSES - 1; index++) {
    const player = allGuesses[Math.floor(index * allGuesses.length / (MAX_BENCHMARK_GUESSES - 1))];
    if (player && !used.has(player.id)) {
      selected.push(player);
      used.add(player.id);
    }
  }
  if (!used.has(actual.id)) selected.push(actual);
  return selected;
}

export async function analyzeGameChoices(
  rounds: AnalysisRoundInput[],
  playersById: ReadonlyMap<number, Player>,
  difficultyPools: ReadonlyMap<string, Player[]>,
  allEnabledPlayers: Player[]
) {
  const trajectories: AnalysisTrajectory[] = [];
  const percentiles: number[] = [];
  const regretRatios: number[] = [];
  let truncated = false;

  for (const round of rounds) {
    if (percentiles.length >= MAX_ANALYZED_STEPS) {
      truncated = true;
      break;
    }
    const target = playersById.get(round.targetPlayerId);
    const initialPool = difficultyPools.get(round.mode) ?? [];
    if (!target || !initialPool.length) continue;
    let candidates = initialPool.slice();
    const steps: AnalysisStep[] = [];
    for (let index = 0; index < round.guessPlayerIds.length; index++) {
      if (percentiles.length >= MAX_ANALYZED_STEPS) {
        truncated = true;
        break;
      }
      const actual = playersById.get(round.guessPlayerIds[index]);
      if (!actual || candidates.length <= 1 || actual.id === target.id) break;
      const actualSignature = feedbackSignature(actual, target);
      const actualGain = informationGain(actual, candidates);
      const benchmark = benchmarkGuesses(allEnabledPlayers, actual);
      const scored: Array<{ guess: Player; gain: number }> = [];
      for (let benchmarkIndex = 0; benchmarkIndex < benchmark.length; benchmarkIndex++) {
        const guess = benchmark[benchmarkIndex];
        scored.push({ guess, gain: informationGain(guess, candidates) });
        if ((benchmarkIndex + 1) % BENCHMARK_CHUNK_SIZE === 0) {
          await yieldToEventLoop();
        }
      }
      scored.sort((a, b) => b.gain - a.gain || a.guess.id - b.guess.id);
      const best = scored[0] ?? { guess: actual, gain: actualGain };
      const belowOrEqual = scored.filter((item) => item.gain <= actualGain + 1e-9).length;
      const percentile = scored.length ? belowOrEqual / scored.length : 0;
      const nextCandidates = candidates.filter(
        (candidate) => feedbackSignature(actual, candidate) === actualSignature
      );
      steps.push({
        guessNumber: index + 1,
        guessPlayerId: actual.id,
        guessNickname: actual.nickname,
        candidateCountBefore: candidates.length,
        candidateCountAfter: nextCandidates.length,
        informationGain: Number(actualGain.toFixed(4)),
        bestInformationGain: Number(best.gain.toFixed(4)),
        entropyPercentile: Number((percentile * 100).toFixed(1)),
        bestGuessPlayerId: best.guess.id,
        bestGuessNickname: best.guess.nickname,
      });
      percentiles.push(percentile);
      regretRatios.push(best.gain > 0 ? Math.max(0, 1 - actualGain / best.gain) : 0);
      candidates = nextCandidates;
    }
    if (steps.length) {
      trajectories.push({
        source: round.source,
        recordId: round.recordId,
        mode: round.mode,
        finishedAt: round.finishedAt,
        round: round.round,
        targetPlayerId: target.id,
        targetNickname: target.nickname,
        steps,
      });
    }
  }

  const sampleSize = percentiles.length;
  const meanPercentile = sampleSize
    ? percentiles.reduce((sum, value) => sum + value, 0) / sampleSize
    : 0;
  const topDecileRate = sampleSize
    ? percentiles.filter((value) => value >= 0.9).length / sampleSize
    : 0;
  const lowRegretRate = sampleSize
    ? regretRatios.filter((value) => value <= 0.1).length / sampleSize
    : 0;
  const similarityIndex = sampleSize
    ? Math.round(100 * (0.55 * meanPercentile + 0.25 * topDecileRate + 0.2 * lowRegretRate))
    : 0;
  const confidence = Math.min(1, sampleSize / 30);
  const level = sampleSize < 10
    ? 'insufficient'
    : similarityIndex >= 90 && sampleSize >= 20
      ? 'high'
      : similarityIndex >= 78
        ? 'elevated'
        : 'common';

  return {
    summary: {
      similarityIndex,
      level,
      sampleSize,
      confidence: Number((confidence * 100).toFixed(1)),
      averageEntropyPercentile: Number((meanPercentile * 100).toFixed(1)),
      topDecileRate: Number((topDecileRate * 100).toFixed(1)),
      lowRegretRate: Number((lowRegretRate * 100).toFixed(1)),
      analyzedRounds: trajectories.length,
      truncated,
    },
    trajectories,
  };
}
