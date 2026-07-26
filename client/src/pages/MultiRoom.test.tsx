import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuessFeedback, PlayerInfo, RoomState } from '../types';
import { renderAtRoute } from '../test/render';
import MultiRoom from './MultiRoom';

const socket = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../api/socket', () => ({ getSocket: () => socket }));

const answer: PlayerInfo = {
  id: 1,
  nickname: 'Answer',
  nationality: 'CN',
  region: 'Asia',
  team: 'Team',
  age: 24,
  role: 'Rifler',
  majorChampionships: 1,
  majorAppearances: 4,
  isActive: true,
};

function guess(playerId: number, nickname: string, correct = false): GuessFeedback {
  const attribute = { value: 'value', level: correct ? 'correct' as const : 'wrong' as const };
  return {
    playerId,
    nickname,
    correct,
    attributes: {
      nationality: attribute,
      team: attribute,
      age: { value: 24, level: attribute.level },
      role: attribute,
      majorChampionships: { value: 1, level: attribute.level },
      majorAppearances: { value: 4, level: attribute.level },
      isActive: { value: true, level: attribute.level },
    },
  };
}

const room: RoomState = {
  id: 'ABCDE',
  hostKey: 'g:me',
  status: 'finished',
  dbType: 'easy',
  boType: 3,
  rematchAllowed: false,
  rematchInvite: null,
  allowSpectators: true,
  anonymous: false,
  round: 2,
  roundId: 2,
  stateVersion: 8,
  winsNeeded: 2,
  maxGuesses: 8,
  roundEndsAt: null,
  matchStartsAt: null,
  spectatorCount: 0,
  players: [
    { key: 'g:me', name: 'Me', ready: true, connected: true, score: 2, guessCount: 0, guesses: [] },
    { key: 'g:opponent', name: 'Opponent', ready: true, connected: true, score: 0, guessCount: 0, guesses: [] },
  ],
  roundResult: null,
  matchResult: {
    winnerKey: 'g:me',
    reason: 'score',
    answer: {
      nickname: answer.nickname,
      team: answer.team,
      nationality: answer.nationality,
      role: answer.role,
      majorChampionships: answer.majorChampionships,
      majorAppearances: answer.majorAppearances,
    },
  },
  matchReplay: {
    id: 'record',
    mode: 'easy',
    boType: 3,
    finishedAt: '2026-07-26T00:00:00.000Z',
    result: 'won',
    me: { score: 2 },
    opponent: { displayId: 'Opponent', score: 0 },
    rounds: [
      {
        round: 1,
        reason: 'guessed',
        winner: 'me',
        answer,
        me: { guesses: [guess(2, 'My Round 1')] },
        opponent: { guesses: [guess(3, 'Opponent Round 1')] },
      },
      {
        round: 2,
        reason: 'guessed',
        winner: 'me',
        answer,
        me: { guesses: [guess(4, 'My Round 2')] },
        opponent: { guesses: [guess(5, 'Opponent Round 2')] },
      },
    ],
  },
};

describe('MultiRoom replay', () => {
  beforeEach(() => {
    socket.on.mockReset();
    socket.off.mockReset();
    socket.connect.mockReset();
    socket.disconnect.mockReset();
    socket.emit.mockReset();
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room, selfKey: 'g:me', serverNow: Date.now() });
      }
    });
  });

  it('shows completed match rounds in the existing boards instead of a replay modal', async () => {
    const user = userEvent.setup();
    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });

    await user.click(await screen.findByRole('button', { name: '查看对局' }));

    expect(screen.queryByRole('dialog', { name: '多人对局回放' })).not.toBeInTheDocument();
    expect(screen.getByText('第 1 / 2 轮')).toBeInTheDocument();
    expect(screen.getByText('Opponent Round 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '下一轮' }));
    expect(screen.getByText('第 2 / 2 轮')).toBeInTheDocument();
    expect(screen.getByText('Opponent Round 2')).toBeInTheDocument();
    expect(screen.queryByText('Opponent Round 1')).not.toBeInTheDocument();
  });
});
