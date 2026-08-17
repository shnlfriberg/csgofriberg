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
  it('labels guesses made by additional relay teammates', () => {
    const relayReplay: MultiReplay = {
      ...replay,
      gameMode: 'relay',
      totalRounds: 1,
      relaySolvedRounds: 1,
      result: 'cooperative',
      rounds: [{
        ...replay.rounds[0],
        sharedGuesses: [{
          actor: null,
          actorDisplayId: 'Teammate C',
          feedback: guess,
          guessTime: 900,
        }],
      }],
    };

    render(<ReplayDialog replay={relayReplay} onClose={vi.fn()} />);

    expect(screen.getByText('Teammate C')).toBeInTheDocument();
  });

  it('groups 2v2 replay guesses and scores by team', () => {
    const relay2v2Replay: MultiReplay = {
      ...replay,
      gameMode: 'relay2v2',
      teamScores: { a: 2, b: 1 },
      participants: [
        { id: 'p1', displayId: 'Me', score: 0, isMe: true, isWinner: true, team: 'a' },
        { id: 'p2', displayId: 'A2', score: 0, isWinner: true, team: 'a' },
        { id: 'p3', displayId: 'B1', score: 0, isWinner: false, team: 'b' },
        { id: 'p4', displayId: 'B2', score: 0, isWinner: false, team: 'b' },
      ],
      rounds: [{
        ...replay.rounds[0],
        winner: null,
        winnerTeam: 'a',
        teamScores: { a: 1, b: 0 },
        teamGuesses: {
          a: [{ actor: 'me', actorDisplayId: 'Me', feedback: { ...guess, nickname: 'A Guess' }, guessTime: 800 }],
          b: [{ actor: null, actorDisplayId: 'B1', feedback: { ...guess, playerId: 3, nickname: 'B Guess' }, guessTime: 1_400 }],
        },
      }],
    };

    render(<ReplayDialog replay={relay2v2Replay} onClose={vi.fn()} showDecisionTimes />);

    expect(screen.getByText('A队 拿下本局')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'A队 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'B队 0' })).toBeInTheDocument();
    expect(screen.getByText('A Guess')).toBeInTheDocument();
    expect(screen.getByText('B Guess')).toBeInTheDocument();
    expect(screen.getByText('B1')).toBeInTheDocument();
    expect(screen.getByText('800ms')).toBeInTheDocument();
    expect(screen.getByText('1.4s')).toBeInTheDocument();
    expect(screen.queryByText('平局')).not.toBeInTheDocument();
  });

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
