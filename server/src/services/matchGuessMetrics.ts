export interface WinningGuessMetrics {
  winningGuessSum: number;
  winningRounds: number;
}

interface StoredRound {
  winnerKey?: unknown;
  guessesByPlayer?: unknown;
}

function replayRounds(value: unknown): StoredRound[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.filter((round): round is StoredRound => Boolean(round) && typeof round === 'object')
      : [];
  } catch {
    return [];
  }
}

export function winningGuessMetricsByPlayer(value: unknown): Map<string, WinningGuessMetrics> {
  const metrics = new Map<string, WinningGuessMetrics>();
  for (const round of replayRounds(value)) {
    if (typeof round.winnerKey !== 'string' || !round.winnerKey) continue;
    const guessesByPlayer = round.guessesByPlayer;
    const guesses = guessesByPlayer && typeof guessesByPlayer === 'object'
      ? (guessesByPlayer as Record<string, unknown>)[round.winnerKey]
      : null;
    const current = metrics.get(round.winnerKey) ?? { winningGuessSum: 0, winningRounds: 0 };
    current.winningGuessSum += Array.isArray(guesses) ? guesses.length : 0;
    current.winningRounds += 1;
    metrics.set(round.winnerKey, current);
  }
  return metrics;
}
