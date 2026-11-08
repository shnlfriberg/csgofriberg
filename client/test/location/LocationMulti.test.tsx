import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LocationMulti from '../../src/pages/LocationMulti';
import { useAuth } from '../../src/store/auth';
import { renderAtRoute } from '../render';
import type { RoomView } from '../../src/location/types';

const { roomAction, socket, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => void>();
  return {
    handlers,
    roomAction: vi.fn(),
    socket: {
      connected: true,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler)),
      off: vi.fn((event: string) => handlers.delete(event)),
      emit: vi.fn(),
    },
  };
});
vi.mock('../../src/api/socket', () => ({ getSocket: () => socket }));
vi.mock('../../src/location/api', () => ({ roomAction, message: (e: any) => e.code }));
const verifiedUser = { id: 42, username: 'player', role: 'user' as const, email: 'player@example.com', emailVerified: true };
const finishedRoom = (): RoomView => ({
  id: 'VOTE1', gameId: '12345678-1234-4234-8234-123456789abc', me: 'p:a', host: 'p:a', viewerUserId: null,
  difficulty: 'normal', duration: 120, status: 'finished', revision: 10, round: 5, maps: [], question: null,
  serverNow: Date.now(), startsAt: null, endsAt: null, nextAt: null, myGuess: null,
  results: ['a', 'b', 'c'].map(key => ({ key: `p:${key}`, name: key, rounds: [] })),
  players: ['a', 'b', 'c'].map(key => ({ key: `p:${key}`, name: key, ready: true, connected: true, retired: false, submitted: false, score: 0, rank: 1 })),
});

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  sessionStorage.clear();
  roomAction.mockReset().mockResolvedValue({ queued: true });
  useAuth.setState({ user: null, initialized: true });
});

describe('location random matchmaking email restriction', () => {
  it('votes and withdraws over WS after settlement and shows the shared progress', async () => {
    renderAtRoute(<LocationMulti />);
    let view = finishedRoom();
    roomAction.mockImplementation(async (event, payload) => {
      if (event === 'location:room:rematch') {
        view = { ...view, revision: view.revision + 1, rematch: { acceptedKeys: payload.wanted ? ['p:a'] : [], requiredKeys: ['p:a', 'p:b', 'p:c'] } };
        return view;
      }
      return {};
    });
    act(() => handlers.get('location:room')?.(view));
    const restart = screen.getByRole('button', { name: '重新开始' });
    expect(restart.closest('.location-summary')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: '重新开始' })).toHaveLength(1);
    expect(screen.getByText(/至少两名在线玩家全部同意后/)).toBeInTheDocument();
    fireEvent.click(restart);
    await waitFor(() => expect(screen.getByText('1 / 3 人想要再来一局')).toBeInTheDocument());
    expect(roomAction).toHaveBeenCalledWith('location:room:rematch', { roomId: 'VOTE1', gameId: view.gameId, wanted: true });
    fireEvent.click(screen.getByRole('button', { name: '取消重新开始' }));
    await waitFor(() => expect(screen.getByText('0 / 3 人想要再来一局')).toBeInTheDocument());
  });
  it('keeps restart available without result details and counts only online non-retired players', () => {
    renderAtRoute(<LocationMulti />);
    const view = finishedRoom();
    view.results = [];
    view.players[2].connected = false;
    act(() => handlers.get('location:room')?.(view));
    expect(screen.getByRole('button', { name: '重新开始' })).toBeEnabled();
    expect(screen.getByText('0 / 2 人想要再来一局')).toBeInTheDocument();
    act(() => handlers.get('location:room')?.({ ...view, revision: 11, players: view.players.map(p => ({ ...p, connected: p.key === view.me })) }));
    expect(screen.getByRole('button', { name: '重新开始' })).toBeDisabled();
    act(() => handlers.get('location:room')?.({ ...view, revision: 12, players: view.players.map(p => ({ ...p, retired: p.key === view.me })) }));
    expect(screen.queryByRole('button', { name: '重新开始' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回多人大厅' })).toBeEnabled();
  });
  it('disables duplicate votes while sending and permits retry after an error', async () => {
    renderAtRoute(<LocationMulti />);
    const view = finishedRoom();
    act(() => handlers.get('location:room')?.(view));
    let reject!: (error: unknown) => void;
    roomAction.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const restart = screen.getByRole('button', { name: '重新开始' });
    fireEvent.click(restart); fireEvent.click(restart);
    expect(restart).toBeDisabled();
    expect(screen.getByRole('button', { name: '返回多人大厅' })).toBeDisabled();
    expect(roomAction).toHaveBeenCalledTimes(1);
    await act(async () => reject({ code: 'NETWORK_ERROR' }));
    expect(screen.getByRole('alert')).toHaveTextContent('NETWORK_ERROR');
    expect(restart).toBeEnabled();
    roomAction.mockResolvedValueOnce({ ...view, revision: 11, rematch: { acceptedKeys: ['p:a'], requiredKeys: ['p:a', 'p:b', 'p:c'] } });
    fireEvent.click(restart);
    expect(await screen.findByRole('button', { name: '取消重新开始' })).toBeEnabled();
    expect(roomAction).toHaveBeenLastCalledWith('location:room:rematch', { roomId: view.id, gameId: view.gameId, wanted: true });
  });
  it('shows peer votes from WS and leaves settlement automatically when the next game arrives', async () => {
    renderAtRoute(<LocationMulti />);
    const view = finishedRoom();
    act(() => handlers.get('location:room')?.(view));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p:b' } });
    act(() => handlers.get('room-kernel:patch')?.({ game: 'location', roomId: view.id, base: 10, rev: 11, serverNow: Date.now(),
      sections: { rematch: { acceptedKeys: ['p:b', 'p:c'], requiredKeys: ['p:a', 'p:b', 'p:c'] } } }));
    expect(screen.getByText('2 / 3 人想要再来一局')).toBeInTheDocument();
    roomAction.mockResolvedValueOnce({ revision: 12 });
    fireEvent.click(screen.getByRole('button', { name: '重新开始' }));
    const next = { ...view, gameId: '87654321-1234-4234-8234-123456789abc', status: 'preparing' as const,
      revision: 12, round: 1, results: [], players: view.players.map(p => ({ ...p, score: 0, rank: null })) };
    act(() => handlers.get('location:room')?.({ ...next, protocol: 2, mapsHash: null }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '重新开始' })).not.toBeInTheDocument());
    expect(screen.queryByText(/人想要再来一局/)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('location:room:guest')).toBe(view.id);
    // The next settlement still offers a restart in the summary, bound to the new game.
    act(() => handlers.get('location:room')?.({ ...view, gameId: next.gameId, revision: 13 }));
    expect(screen.getByRole('combobox')).toHaveValue('p:a');
    roomAction.mockResolvedValueOnce({ revision: 14 });
    fireEvent.click(screen.getByRole('button', { name: '重新开始' }));
    await waitFor(() => expect(roomAction).toHaveBeenLastCalledWith('location:room:rematch', { roomId: view.id, gameId: next.gameId, wanted: true }));
  });
  it('accepts opaque seat keys and rejects packets from the previous account on full and delta updates', async () => {
    useAuth.setState({ user: verifiedUser });
    renderAtRoute(<LocationMulti />);
    const view: RoomView = { id: 'SAFE1', gameId: 'game', me: 'p:self', host: 'p:self', viewerUserId: 42,
      difficulty: 'normal', duration: 120, status: 'waiting', revision: 1, round: 0, maps: [], question: null,
      serverNow: Date.now(), startsAt: null, endsAt: null, nextAt: null, myGuess: null,
      results: [], players: [{ key: 'p:self', name: 'Current player', ready: false, connected: true, retired: false, submitted: false, score: 0, rank: null }] };
    act(() => handlers.get('location:room')?.(view));
    expect(await screen.findByText('SAFE1')).toBeInTheDocument();
    const oldReceive = handlers.get('location:room')!;
    act(() => useAuth.setState({ user: null }));
    act(() => oldReceive(view));
    act(() => handlers.get('location:room')?.(view));
    expect(screen.queryByText('SAFE1')).not.toBeInTheDocument();
    const guest = { ...view, id: 'GUEST', me: 'p:guest', host: 'p:guest', viewerUserId: null,
      players: [{ ...view.players[0], key: 'p:guest' }] };
    act(() => handlers.get('location:room')?.(guest));
    expect(await screen.findByText('GUEST')).toBeInTheDocument();
    act(() => handlers.get('location:room:patch')?.({ id: 'GUEST', baseRevision: 1, revision: 2,
      changes: { viewerUserId: 42, revision: 2, players: [{ ...view.players[0], name: 'Wrong account' }] } }));
    expect(screen.queryByText('Wrong account')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('location:room:guest')).toBe('GUEST');
  });
  it.each([
    ['guest', null, true],
    ['unbound account', { ...verifiedUser, email: null, emailVerified: false }, true],
    ['unverified account', { ...verifiedUser, emailVerified: false }, true],
    ['initializing account', verifiedUser, false],
  ] as const)('prevents %s from searching while keeping friend rooms available', (_, user, initialized) => {
    useAuth.setState({ user, initialized });
    renderAtRoute(<LocationMulti />);
    const match = screen.getByRole('button', { name: '双人随机匹配' });
    expect(match).toBeDisabled();
    fireEvent.click(match);
    expect(roomAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '创建好友房' })).toBeEnabled();
    if (initialized) expect(screen.getByText('随机匹配仅对已登录且完成邮箱验证的用户开放。')).toBeInTheDocument();
  });

  it('allows verified accounts to search and to cancel after losing eligibility', async () => {
    useAuth.setState({ user: verifiedUser });
    renderAtRoute(<LocationMulti />);
    fireEvent.click(screen.getByRole('button', { name: '双人随机匹配' }));
    await waitFor(() => expect(roomAction).toHaveBeenCalledWith('location:match:join', { difficulty: 'normal' }));
    await screen.findByRole('button', { name: '取消匹配' });
    act(() => useAuth.setState({ user: { ...verifiedUser, emailVerified: false } }));
    expect(screen.getByRole('button', { name: '取消匹配' })).toBeEnabled();
    // Reconnection must not automatically rejoin without a verified email.
    roomAction.mockClear();
    act(() => handlers.get('connect')?.());
    expect(roomAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消匹配' }));
    await waitFor(() => expect(roomAction).toHaveBeenCalledWith('location:match:cancel', { difficulty: 'normal' }));
    expect(await screen.findByRole('button', { name: '双人随机匹配' })).toBeDisabled();
  });

  it('enables matchmaking when email verification completes without changing accounts', () => {
    useAuth.setState({ user: { ...verifiedUser, emailVerified: false } });
    renderAtRoute(<LocationMulti />);
    expect(screen.getByRole('button', { name: '双人随机匹配' })).toBeDisabled();
    act(() => useAuth.setState({ user: verifiedUser }));
    expect(screen.getByRole('button', { name: '双人随机匹配' })).toBeEnabled();
  });

  it('clears queued state when reconnecting is rejected by the server', async () => {
    useAuth.setState({ user: verifiedUser });
    renderAtRoute(<LocationMulti />);
    fireEvent.click(screen.getByRole('button', { name: '双人随机匹配' }));
    await screen.findByRole('button', { name: '取消匹配' });
    roomAction.mockRejectedValueOnce({ code: 'EMAIL_VERIFICATION_REQUIRED' });
    act(() => handlers.get('connect')?.());
    expect(await screen.findByRole('alert')).toHaveTextContent('EMAIL_VERIFICATION_REQUIRED');
    expect(screen.getByRole('button', { name: '双人随机匹配' })).toBeInTheDocument();
  });
});
