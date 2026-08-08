import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuessFeedback, PlayerInfo, RoomState } from '../../src/types';
import { renderAtRoute } from '../render';
import MultiLobby from '../../src/pages/MultiLobby';
import MultiRoom from '../../src/pages/MultiRoom';

const socket = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../../src/api/socket', () => ({ getSocket: () => socket }));

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
  matchmaking: false,
  readyCheckEndsAt: null,
  dbType: 'easy',
  boType: 3,
  rematchAllowed: false,
  rematchInvite: null,
  allowSpectators: true,
  verifiedOnly: false,
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
    { key: 'g:me', name: 'Me', ready: true, connected: true, score: 2, skipped: false, guessCount: 0, guesses: [] },
    { key: 'g:opponent', name: 'Opponent', ready: true, connected: true, score: 0, skipped: false, guessCount: 0, guesses: [] },
  ],
  roundResult: null,
  matchResult: {
    winnerKey: 'g:me',
    reason: 'score',
    answer: {
      nickname: answer.nickname,
      team: answer.team,
      nationality: answer.nationality,
      region: answer.region,
      role: answer.role,
      majorChampionships: answer.majorChampionships,
      majorAppearances: answer.majorAppearances,
    },
  },
  reportSubmitted: false,
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

  it('shows the report entry only after matchmaking settlement and submits it once', async () => {
    const user = userEvent.setup();
    const matchmakingFinishedRoom = { ...room, matchmaking: true };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: matchmakingFinishedRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
      if (event === 'match:report' && typeof ack === 'function') {
        ack({ ok: true, reportSubmitted: true });
      }
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });

    const reportEntry = await screen.findByRole('button', { name: '举报对方' });
    expect(reportEntry.querySelector('svg')).not.toBeNull();
    expect(reportEntry.parentElement?.lastElementChild).toBe(reportEntry);
    await user.click(reportEntry);
    const description = screen.getByPlaceholderText('请输入举报描述');
    await user.type(description, '疑似使用自动化脚本');
    await user.click(screen.getByRole('button', { name: '提交举报' }));

    expect(socket.emit).toHaveBeenCalledWith(
      'match:report',
      { description: '疑似使用自动化脚本' },
      expect.any(Function)
    );
    expect(await screen.findByText('已提交举报')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '举报对方' })).not.toBeInTheDocument();
  });

  it('does not show a report entry for created rooms even after settlement', async () => {
    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });

    expect(await screen.findByRole('button', { name: '查看对局' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '举报对方' })).not.toBeInTheDocument();
  });

  it('does not show a report entry before the match is finished', async () => {
    const activeRoom: RoomState = {
      ...room,
      status: 'playing',
      round: 1,
      roundId: 1,
      matchResult: null,
      matchReplay: undefined,
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: activeRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });

    expect(await screen.findByPlaceholderText('输入选手昵称...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '举报对方' })).not.toBeInTheDocument();
  });

  it('lets the matchmaking host ready up instead of showing a host start button', async () => {
    const user = userEvent.setup();
    const readyRoom: RoomState = {
      ...room,
      status: 'waiting',
      matchmaking: true,
      readyCheckEndsAt: Date.now() + 30_000,
      round: 0,
      roundId: 0,
      matchResult: null,
      matchReplay: undefined,
      players: room.players.map((player) => ({ ...player, ready: false, score: 0 })),
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: readyRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
      if (event === 'room:player-stats' && typeof ack === 'function') {
        ack({
          playerKey: 'g:opponent',
          displayId: 'Opponent',
          stats: {
            single: { games: 0, wins: 0, losses: 0, winRate: 0, avgGuesses: null, bestGuesses: null },
            multi: { games: 1, wins: 1, losses: 0, winRate: 1, recentAverageWinningGuesses: 3.4, recentMatches: [] },
          },
        });
      }
      if (event === 'room:ready' && typeof ack === 'function') ack({ ok: true });
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });
    const ready = await screen.findByRole('button', { name: '准备' });
    expect(screen.getByText('对方近 10 场胜局平均猜测')).toBeInTheDocument();
    expect(await screen.findByText('3.4')).toHaveClass('matchmaking-average-low');
    expect(screen.queryByRole('button', { name: '开始对局' })).not.toBeInTheDocument();
    await user.click(ready);
    expect(socket.emit).toHaveBeenCalledWith('room:ready', { ready: true }, expect.any(Function));
  });

  it('warns before leaving a ready check and shows the returned cooldown in the lobby', async () => {
    const user = userEvent.setup();
    const serverNow = Date.now();
    let left = false;
    const readyRoom: RoomState = {
      ...room,
      status: 'waiting',
      matchmaking: true,
      readyCheckEndsAt: serverNow + 30_000,
      round: 0,
      roundId: 0,
      matchResult: null,
      matchReplay: undefined,
      players: room.players.map((player) => ({ ...player, ready: false, score: 0 })),
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack(left
          ? { code: 'NOT_IN_ROOM' }
          : { room: readyRoom, selfKey: 'g:me', serverNow });
      }
      if (event === 'room:leave' && typeof ack === 'function') {
        left = true;
        ack({ ok: true, retryAt: serverNow + 10_000, serverNow });
      }
    });

    renderAtRoute(<MultiRoom />, {
      route: '/multi/room',
      path: '/multi/room',
      extraRoutes: <Route path="/multi" element={<MultiLobby />} />,
    });

    await user.click(await screen.findByRole('button', { name: '离开房间' }));
    expect(await screen.findByRole('alertdialog', { name: '退出匹配准备？' })).toHaveTextContent(
      '退出后可能会受到匹配惩罚。'
    );
    expect(socket.emit).not.toHaveBeenCalledWith('room:leave', {}, expect.any(Function));

    await user.click(screen.getByRole('button', { name: '确认退出' }));

    const cooldownButton = await screen.findByRole('button', { name: /冷却 \d+ 秒/ });
    expect(cooldownButton).toBeDisabled();
    expect(screen.queryByText(/已退出准备/)).not.toBeInTheDocument();
  });

  it('marks the player as skipped and disables further round actions', async () => {
    const user = userEvent.setup();
    const activeRoom: RoomState = {
      ...room,
      status: 'playing',
      round: 1,
      roundId: 1,
      roundEndsAt: Date.now() + 60_000,
      matchResult: null,
      matchReplay: undefined,
      players: room.players.map((player) => ({
        ...player,
        score: 0,
        skipped: false,
        guessCount: 0,
        guesses: [],
      })),
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: activeRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
      if (event === 'game:skip-round' && typeof ack === 'function') {
        ack({
          ok: true,
          room: {
            ...activeRoom,
            stateVersion: activeRoom.stateVersion + 1,
            players: activeRoom.players.map((player) => player.key === 'g:me'
              ? { ...player, skipped: true }
              : player),
          },
        });
      }
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });
    await user.click(await screen.findByRole('button', { name: '跳过本轮' }));
    expect(screen.getByRole('alertdialog', { name: '跳过本轮？' })).toHaveTextContent(
      '对方会看到你的跳过状态'
    );
    await user.click(screen.getByRole('button', { name: '确认跳过本轮' }));

    expect(socket.emit).toHaveBeenCalledWith('game:skip-round', { roundId: 1 }, expect.any(Function));
    expect(await screen.findByRole('button', { name: '已跳过' })).toBeDisabled();
  });
});
