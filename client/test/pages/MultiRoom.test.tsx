import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuessFeedback, PlayerInfo, RoomState } from '../../src/types';
import { renderAtRoute } from '../render';
import MultiLobby from '../../src/pages/MultiLobby';
import MultiRoom, { relayStateProbeNeedsSync, resolveGuessCooldownMs } from '../../src/pages/MultiRoom';

const socket = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
const playerList = vi.hoisted(() => [{ id: 99, nickname: 's1mple' }]);

vi.mock('../../src/api/socket', () => ({ getSocket: () => socket }));
vi.mock('../../src/api/playerList', () => ({
  getPlayerList: vi.fn(async () => playerList),
  subscribePlayerList: vi.fn(() => () => undefined),
  searchPlayerList: (list: typeof playerList, query: string) => list.filter(
    (item) => item.nickname.toLowerCase().includes(query.trim().toLowerCase())
  ),
}));

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
  maxPlayers: 2,
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
  guessIntervalMs: 1_500,
  roundDurationMs: 120_000,
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

  it('keeps my board full-size and renders other players as compact expandable rows', async () => {
    const user = userEvent.setup();
    const multiRoom: RoomState = {
      ...room,
      status: 'playing',
      maxPlayers: 3,
      roundEndsAt: Date.now() + 60_000,
      matchResult: null,
      matchReplay: undefined,
      players: [
        { ...room.players[0], score: 1, guesses: [guess(10, 'My guess')], guessCount: 1 },
        { ...room.players[1], guesses: [guess(11, 'Opponent guess')], guessCount: 1 },
        { key: 'g:third', name: 'Third Player', ready: true, connected: true, score: 0, skipped: false, guessCount: 0, guesses: [] },
      ],
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: multiRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });
    expect(await screen.findByText('我的猜测')).toBeInTheDocument();
    expect(screen.getByRole('main').querySelector('.multi-classic-layout-crowded')).not.toBeNull();
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('1 分')).toBeInTheDocument();
    const otherPlayers = screen.getByRole('region', { name: '其他玩家' });
    expect(within(otherPlayers).getByRole('button', { name: /Opponent/ })).toHaveAttribute('aria-expanded', 'false');
    expect(within(otherPlayers).getByRole('button', { name: /Third Player/ })).toBeInTheDocument();
    await user.click(within(otherPlayers).getByRole('button', { name: /Opponent/ }));
    expect(within(otherPlayers).getByText('Opponent guess')).toBeInTheDocument();
  });

  it('uses the room guess interval without enforcing a fixed client minimum', () => {
    expect(resolveGuessCooldownMs(0, 1_500)).toBe(0);
    expect(resolveGuessCooldownMs(2_500, 1_500)).toBe(2_500);
    expect(resolveGuessCooldownMs(undefined, 3_000)).toBe(3_000);
  });

  it('tracks rematch wishes and lets the player withdraw after matchmaking settlement', async () => {
    const user = userEvent.setup();
    const matchmakingFinishedRoom = { ...room, matchmaking: true, rematchAllowed: true };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: matchmakingFinishedRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
      if (event === 'match:rematch-want' && typeof ack === 'function') {
        ack({ ok: true, stateVersion: matchmakingFinishedRoom.stateVersion + 1 });
      }
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });

    expect(await screen.findByText('0 / 2 人想要再来一局')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '再来一局' }));
    expect(socket.emit).toHaveBeenCalledWith(
      'match:rematch-want',
      { wanted: true },
      expect.any(Function)
    );

    const handler = socket.on.mock.calls.find(([event]) => event === 'match:rematch:update')?.[1];
    expect(handler).toEqual(expect.any(Function));
    act(() => handler({
      roomId: matchmakingFinishedRoom.id,
      stateVersion: matchmakingFinishedRoom.stateVersion + 1,
      outcome: 'wanted',
      actorKey: 'g:me',
      acceptedKeys: ['g:me'],
      requiredKeys: ['g:me', 'g:opponent'],
    }));

    expect(screen.getByText('1 / 2 人想要再来一局')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消再来一局' }));
    expect(socket.emit).toHaveBeenLastCalledWith(
      'match:rematch-want',
      { wanted: false },
      expect.any(Function)
    );
  });

  it('keeps large-room settlement compact without listing every player score', async () => {
    const largeFinishedRoom: RoomState = {
      ...room,
      maxPlayers: 4,
      matchResult: { ...room.matchResult!, winnerKey: 'g:opponent' },
      players: [
        { ...room.players[0], score: 1 },
        { ...room.players[1], score: 2 },
        { key: 'g:third', name: 'Third Player', ready: true, connected: true, score: 0, skipped: false, guessCount: 0, guesses: [] },
        { key: 'g:fourth', name: 'Fourth Player', ready: true, connected: true, score: 0, skipped: false, guessCount: 0, guesses: [] },
      ],
    };
    const largePlayingRoom: RoomState = {
      ...largeFinishedRoom,
      status: 'playing',
      matchResult: null,
      matchReplay: undefined,
      stateVersion: largeFinishedRoom.stateVersion - 1,
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: largePlayingRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });

    expect(await screen.findByText('我的猜测')).toBeInTheDocument();
    const handler = socket.on.mock.calls.find(([event]) => event === 'match:over')?.[1];
    expect(handler).toEqual(expect.any(Function));
    act(() => handler({ room: largeFinishedRoom, serverNow: Date.now() }));

    const settlement = await screen.findByRole('dialog');
    expect(within(settlement).getByRole('heading', { name: 'Opponent 获胜' })).toBeInTheDocument();
    expect(within(settlement).queryByText(/Third Player/)).not.toBeInTheDocument();
    expect(within(settlement).queryByText(/Me 2.*Opponent 0/)).not.toBeInTheDocument();
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
    fireEvent.change(description, { target: { value: '疑似使用自动化脚本' } });
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

  it('renders relay guesses from both players in one compact table', async () => {
    const relayRoom: RoomState = {
      ...room,
      status: 'playing',
      gameMode: 'relay',
      totalRounds: 3,
      currentTurnKey: 'g:me',
      relaySolvedRounds: 1,
      relayGuesses: [
        { actorKey: 'g:me', guessedAt: Date.now() - 1_000, feedback: guess(10, 'My relay guess') },
        { actorKey: 'g:opponent', guessedAt: Date.now(), feedback: guess(11, 'Opponent relay guess') },
      ],
      round: 2,
      roundId: 2,
      roundEndsAt: Date.now() + 60_000,
      matchResult: null,
      matchReplay: undefined,
      players: room.players.map((player) => ({ ...player, score: 0, guessCount: 1 })),
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: relayRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });

    const heading = await screen.findByRole('heading', { name: /共享猜测/ });
    const relayBoard = heading.closest('.relay-board');
    expect(relayBoard).not.toBeNull();
    const table = within(relayBoard as HTMLElement).getByRole('table');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(8);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('Me')).toHaveClass('guess-row-actor-self');
    expect(within(table).getByText('Opponent')).toHaveClass('guess-row-actor-other');
    expect(within(table).getByText('My relay guess')).toBeInTheDocument();
    expect(within(table).getByText('Opponent relay guess')).toBeInTheDocument();
  });

  it.each([
    ['guessed', '本局共同猜中'],
    ['exhausted', '本局未猜中'],
  ] as const)('shows the cooperative relay round result for %s', async (reason, title) => {
    const relayRoom: RoomState = {
      ...room,
      status: 'playing',
      gameMode: 'relay',
      totalRounds: 3,
      currentTurnKey: 'g:me',
      relaySolvedRounds: 0,
      relayGuesses: [],
      round: 1,
      roundId: 1,
      roundEndsAt: Date.now() + 60_000,
      matchResult: null,
      matchReplay: undefined,
      players: room.players.map((player) => ({ ...player, score: 0, guessCount: 0 })),
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: relayRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });
    expect(await screen.findByPlaceholderText('输入选手昵称...')).toBeEnabled();

    const handler = socket.on.mock.calls.find(([event]) => event === 'round:over')?.[1];
    expect(handler).toEqual(expect.any(Function));
    act(() => handler({
      room: {
        ...relayRoom,
        status: 'round_over',
        stateVersion: relayRoom.stateVersion + 1,
        roundEndsAt: null,
        currentTurnKey: null,
        roundResult: {
          round: 1,
          winnerKey: null,
          reason,
          answer,
          nextRoundAt: Date.now() + 6_000,
        },
      },
      serverNow: Date.now(),
    }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: title })).toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: '本局平局' })).not.toBeInTheDocument();
  });

  it('shows a match-ended modal when a player leaves an active relay room', async () => {
    const relayRoom: RoomState = {
      ...room,
      status: 'playing',
      gameMode: 'relay',
      totalRounds: 3,
      currentTurnKey: 'g:me',
      relaySolvedRounds: 1,
      relayGuesses: [],
      round: 2,
      roundId: 2,
      roundEndsAt: Date.now() + 60_000,
      matchResult: null,
      matchReplay: undefined,
      players: room.players.map((player) => ({ ...player, score: 0, guessCount: 0 })),
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: relayRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });
    expect(await screen.findByPlaceholderText('输入选手昵称...')).toBeEnabled();
    const handler = socket.on.mock.calls.find(([event]) => event === 'relay:aborted')?.[1];
    expect(handler).toEqual(expect.any(Function));

    act(() => handler({
      roomId: relayRoom.id,
      reason: 'player_left',
      playerKey: 'g:opponent',
      serverNow: Date.now(),
    }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('接力对局已结束');
    expect(dialog).toHaveTextContent('有玩家退出了房间，本次接力对局已中止且不会保存记录。');
    expect(within(dialog).getByRole('button', { name: '返回大厅' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('输入选手昵称...')).toBeDisabled();
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
    expect(screen.queryByRole('heading', { name: '房间设置' })).not.toBeInTheDocument();
    expect(screen.getByText('对方近 10 场胜局平均猜测')).toBeInTheDocument();
    expect(await screen.findByText('3.4')).toHaveClass('matchmaking-average-low');
    expect(screen.queryByRole('button', { name: '开始对局' })).not.toBeInTheDocument();
    await user.click(ready);
    expect(socket.emit).toHaveBeenCalledWith('room:ready', { ready: true }, expect.any(Function));
  });

  it('shows invited players the current room settings before they ready up', async () => {
    const invitedRoom: RoomState = {
      ...room,
      status: 'waiting',
      matchmaking: false,
      dbType: 'easy',
      boType: 5,
      maxGuesses: 12,
      guessIntervalMs: 2_500,
      roundDurationMs: 300_000,
      verifiedOnly: true,
      anonymous: true,
      round: 0,
      roundId: 0,
      matchResult: null,
      matchReplay: undefined,
      players: room.players.map((player) => ({
        ...player,
        ready: player.key === room.hostKey,
        score: 0,
      })),
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: invitedRoom, selfKey: 'g:opponent', serverNow: Date.now() });
      }
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });

    const attributes = await screen.findByRole('region', { name: '房间设置' });
    expect(within(attributes).getByText('数据库：简单版')).toBeInTheDocument();
    expect(within(attributes).getByText('赛制：BO5')).toBeInTheDocument();
    expect(within(attributes).getByText('每局最多 12 次 · 最大猜测时间 300 秒 · 猜测间隔 2.5 秒'))
      .toBeInTheDocument();
    expect(within(attributes).getByText('允许观战')).toBeInTheDocument();
    expect(within(attributes).getByText('仅允许已验证邮箱用户加入')).toBeInTheDocument();
    expect(within(attributes).getByText('匿名房间')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '准备' })).toBeInTheDocument();
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
      '其他玩家会看到你的跳过状态'
    );
    await user.click(screen.getByRole('button', { name: '确认跳过本轮' }));

    expect(socket.emit).toHaveBeenCalledWith('game:skip-round', { roundId: 1 }, expect.any(Function));
    expect(await screen.findByRole('button', { name: '已跳过' })).toBeDisabled();
  });

  it('allows another guess immediately when the room interval is zero', async () => {
    const user = userEvent.setup();
    const activeRoom: RoomState = {
      ...room,
      status: 'playing',
      guessIntervalMs: 0,
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
      if (event === 'game:guess' && typeof ack === 'function') ack({ cooldownMs: 0 });
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });

    const input = await screen.findByPlaceholderText('输入选手昵称...');
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await user.type(input, 's1');
      await screen.findByRole('option', { name: 's1mple' });
      await user.click(screen.getByRole('button', { name: '提交猜测' }));
      await waitFor(() => {
        expect(socket.emit.mock.calls.filter(([event]) => event === 'game:guess'))
          .toHaveLength(attempt);
      });
    }
  });

  it('detects a relay turn mismatch from a lightweight state probe', () => {
    const relayRoom: RoomState = {
      ...room,
      status: 'playing',
      gameMode: 'relay',
      roundId: 1,
      round: 1,
      currentTurnKey: 'g:me',
    };
    expect(relayStateProbeNeedsSync(relayRoom, {
      roomId: relayRoom.id,
      roundId: relayRoom.roundId,
      stateVersion: relayRoom.stateVersion,
      status: 'playing',
      gameMode: 'relay',
      currentTurnKey: 'g:opponent',
    })).toBe(true);
    expect(relayStateProbeNeedsSync(relayRoom, {
      roomId: relayRoom.id,
      roundId: relayRoom.roundId,
      stateVersion: relayRoom.stateVersion,
      status: 'playing',
      gameMode: 'relay',
      currentTurnKey: 'g:me',
    })).toBe(false);
  });

  it('syncs when a relay guess acknowledgement says the turn changed at the same revision', async () => {
    const relayRoom: RoomState = {
      ...room,
      status: 'playing',
      gameMode: 'relay',
      round: 1,
      roundId: 1,
      currentTurnKey: 'g:me',
      relayGuesses: [],
      matchResult: null,
      matchReplay: undefined,
      players: room.players.map((player) => ({ ...player, score: 0, guessCount: 0, guesses: [] })),
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: relayRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
    });
    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });
    await screen.findByPlaceholderText('输入选手昵称...');
    const syncCallsBefore = socket.emit.mock.calls.filter(([event]) => event === 'room:sync').length;
    const handler = socket.on.mock.calls.find(([event]) => event === 'game:guess:applied')?.[1];
    expect(handler).toEqual(expect.any(Function));
    act(() => handler({
      roomId: relayRoom.id,
      roundId: relayRoom.roundId,
      key: 'g:opponent',
      stateVersion: relayRoom.stateVersion,
      feedback: { hidden: true },
      currentTurnKey: 'g:opponent',
    }));
    await waitFor(() => {
      expect(socket.emit.mock.calls.filter(([event]) => event === 'room:sync').length)
        .toBeGreaterThan(syncCallsBefore);
    });
  });

  it('probes an active relay room, syncs only after a missed handoff, and cleans up its timer', async () => {
    vi.useFakeTimers();
    try {
      const relayRoom: RoomState = {
        ...room,
        status: 'playing',
        gameMode: 'relay',
        round: 1,
        roundId: 1,
        currentTurnKey: 'g:me',
        relayGuesses: [],
        roundEndsAt: Date.now() + 60_000,
        matchResult: null,
        matchReplay: undefined,
        players: room.players.map((player) => ({ ...player, score: 0, guessCount: 0, guesses: [] })),
      };
      let probes = 0;
      socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
        const ack = args.at(-1);
        if (event === 'room:sync' && typeof ack === 'function') {
          ack({ room: relayRoom, selfKey: 'g:me', serverNow: Date.now() });
        }
        if (event === 'room:state-probe' && typeof ack === 'function') {
          probes += 1;
          ack({
            roomId: relayRoom.id,
            roundId: relayRoom.roundId,
            stateVersion: probes === 1 ? relayRoom.stateVersion : relayRoom.stateVersion + 1,
            status: relayRoom.status,
            gameMode: 'relay',
            currentTurnKey: probes === 1 ? 'g:me' : 'g:opponent',
          });
        }
      });

      const view = renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });
      expect(screen.getByPlaceholderText('输入选手昵称...')).toBeEnabled();
      const initialSyncCalls = socket.emit.mock.calls.filter(([event]) => event === 'room:sync').length;

      await act(async () => vi.advanceTimersByTime(3_000));
      expect(socket.emit.mock.calls.filter(([event]) => event === 'room:state-probe')).toHaveLength(1);
      expect(socket.emit.mock.calls.filter(([event]) => event === 'room:sync')).toHaveLength(initialSyncCalls);

      await act(async () => vi.advanceTimersByTime(3_000));
      expect(socket.emit.mock.calls.filter(([event]) => event === 'room:state-probe')).toHaveLength(2);
      expect(socket.emit.mock.calls.filter(([event]) => event === 'room:sync').length)
        .toBeGreaterThan(initialSyncCalls);

      const probeCallsBeforeUnmount = socket.emit.mock.calls
        .filter(([event]) => event === 'room:state-probe').length;
      view.unmount();
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(socket.emit.mock.calls.filter(([event]) => event === 'room:state-probe'))
        .toHaveLength(probeCallsBeforeUnmount);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('synchronizes immediately when the server rejects a stale relay turn', async () => {
    const user = userEvent.setup();
    const relayRoom: RoomState = {
      ...room,
      status: 'playing',
      gameMode: 'relay',
      round: 1,
      roundId: 1,
      currentTurnKey: 'g:me',
      relayGuesses: [],
      guessIntervalMs: 0,
      roundEndsAt: Date.now() + 60_000,
      matchResult: null,
      matchReplay: undefined,
      players: room.players.map((player) => ({ ...player, score: 0, guessCount: 0, guesses: [] })),
    };
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') {
        ack({ room: relayRoom, selfKey: 'g:me', serverNow: Date.now() });
      }
      if (event === 'game:guess' && typeof ack === 'function') ack({ code: 'NOT_YOUR_TURN' });
    });

    renderAtRoute(<MultiRoom />, { route: '/multi/room', path: '/multi/room' });
    const input = await screen.findByPlaceholderText('输入选手昵称...');
    const initialSyncCalls = socket.emit.mock.calls.filter(([event]) => event === 'room:sync').length;
    await user.type(input, 's1');
    await screen.findByRole('option', { name: 's1mple' });
    await user.click(screen.getByRole('button', { name: '提交猜测' }));

    await waitFor(() => {
      expect(socket.emit.mock.calls.filter(([event]) => event === 'room:sync').length)
        .toBeGreaterThan(initialSyncCalls);
    });
  });
});
