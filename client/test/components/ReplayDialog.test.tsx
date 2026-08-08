import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ReplayDialog, { type MultiReplay } from '../../src/components/ReplayDialog';
import type { PlayerPerformanceStats } from '../../src/types';

const guess = {
  playerId: 2,
  nickname: 'Guess',
  correct: false,
  attributes: {
    nationality: { value: 'CN', level: 'wrong' as const },
    team: { value: 'Team', level: 'wrong' as const },
    age: { value: 20, level: 'wrong' as const },
    role: { value: 'Rifler', level: 'wrong' as const },
    majorChampionships: { value: 0, level: 'wrong' as const },
    majorAppearances: { value: 1, level: 'wrong' as const },
    isActive: { value: true, level: 'wrong' as const },
  },
};

const replay: MultiReplay = {
  type: 'multi',
  id: 42,
  mode: 'easy',
  boType: 3,
  finishedAt: '2026-07-26T00:00:00.000Z',
  result: 'won',
  me: { score: 2 },
  opponent: { displayId: 'Opponent', score: 1 },
  rounds: [{
    round: 1,
    reason: 'guessed',
    winner: 'me',
    answer: {
      id: 1,
      nickname: 'Answer',
      nationality: 'CN',
      region: 'Asia',
      team: 'Team',
      age: 20,
      role: 'Rifler',
      majorChampionships: 0,
      majorAppearances: 1,
      isActive: true,
    },
    me: { guesses: [] },
    opponent: { guesses: [] },
  }],
};

const stats: PlayerPerformanceStats = {
  single: { games: 8, wins: 5, losses: 3, winRate: 0.625, avgGuesses: 3.2, bestGuesses: 1 },
  multi: {
    games: 12,
    wins: 7,
    losses: 5,
    winRate: 7 / 12,
    recentAverageWinningGuesses: null,
    recentMatches: [],
  },
};

describe('ReplayDialog', () => {
  it('shows compact decision times only when explicitly enabled', () => {
    const timedReplay: MultiReplay = {
      ...replay,
      rounds: [{
        ...replay.rounds[0],
        me: { guesses: [guess], guessTimes: [1_200] },
        opponent: { guesses: [guess], guessTimes: [null] },
      }],
    };
    const { rerender } = render(<ReplayDialog replay={timedReplay} onClose={vi.fn()} />);
    expect(screen.queryByLabelText('每步用时')).not.toBeInTheDocument();

    rerender(<ReplayDialog replay={timedReplay} onClose={vi.fn()} showDecisionTimes />);
    expect(screen.getAllByLabelText('每步用时')).toHaveLength(2);
    expect(screen.getByText('1.2s')).toBeInTheDocument();
  });

  it('loads opponent stats into a modal from a multiplayer replay', async () => {
    const user = userEvent.setup();
    const onViewOpponentStats = vi.fn();
    const { rerender } = render(
      <ReplayDialog
        replay={replay}
        onClose={vi.fn()}
        onViewOpponentStats={onViewOpponentStats}
      />
    );

    await user.click(screen.getByRole('button', { name: /查看 Opponent 的战绩/ }));
    expect(onViewOpponentStats).toHaveBeenCalledTimes(1);

    rerender(
      <ReplayDialog
        replay={replay}
        onClose={vi.fn()}
        opponentStats={stats}
        onViewOpponentStats={onViewOpponentStats}
      />
    );

    expect(screen.getByRole('dialog', { name: '玩家战绩' })).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('62.5%')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '关闭战绩' }));
    expect(screen.queryByRole('dialog', { name: '玩家战绩' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '多人对局回放' })).toBeInTheDocument();
  });
});
