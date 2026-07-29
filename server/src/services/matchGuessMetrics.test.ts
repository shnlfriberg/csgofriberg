import { describe, expect, it } from 'vitest';
import { winningGuessMetricsByPlayer } from './matchGuessMetrics';

describe('winningGuessMetricsByPlayer', () => {
  it('aggregates guesses across won multiplayer rounds', () => {
    const metrics = winningGuessMetricsByPlayer([
      {
        winnerKey: 'g:winner',
        guessesByPlayer: { 'g:winner': [1], 'g:other': [2, 3] },
      },
      {
        winnerKey: 'g:other',
        guessesByPlayer: { 'g:winner': [1, 2], 'g:other': [3, 4, 5] },
      },
      {
        winnerKey: 'g:winner',
        guessesByPlayer: { 'g:winner': [6, 7], 'g:other': [] },
      },
      { winnerKey: null, guessesByPlayer: {} },
    ]);

    expect(metrics.get('g:winner')).toEqual({ winningGuessSum: 3, winningRounds: 2 });
    expect(metrics.get('g:other')).toEqual({ winningGuessSum: 3, winningRounds: 1 });
  });
});
