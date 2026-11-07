import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CardLink from '../../src/pages/CardLink';
import { renderAtRoute, renderWithProviders } from '../render';
import { MemoryRouter } from 'react-router-dom';
import type { View } from '../../src/card-link/types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), reload: vi.fn(), game: vi.fn(), setError: vi.fn() }));
vi.mock('../../src/api/client', () => ({ api: mocks, errMsg: () => 'Failed' }));
vi.mock('../../src/card-link/useCardGame', () => ({ useCardGame: mocks.game }));
const socketMock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => void>() }));
vi.mock('../../src/api/socket', () => ({ getSocket: () => ({
  on: (event: string, fn: (...args: any[]) => void) => socketMock.handlers.set(event, fn),
  off: (event: string) => socketMock.handlers.delete(event),
}) }));
vi.mock('../../src/card-link/useCardMotion', () => ({ useCardMotion: () => ({ current: null }) }));
const route = (suffix = '') => renderAtRoute(<CardLink />, { route: `/entertainment/card-link${suffix}`, path: '/entertainment/card-link' });
let game: View;
beforeEach(() => {
  vi.clearAllMocks();
  game = { id: 'new-room', scene: 'friend', variant: 'unlimited', status: 'waiting', round: 0, rounds: 3, dueAt: null, players: [], current: null, evidence: [] } as unknown as View;
  mocks.game.mockImplementation((id: string | null) => ({ view: id ? game : null, directory: [], error: '', busy: false, pending: null, send: vi.fn(), reload: mocks.reload, setError: mocks.setError }));
  mocks.get.mockImplementation(async path => ({ data: path.endsWith('/config') ? { enabled: true } : path.endsWith('/daily-leaderboard') ? [] : { id: null, queued: false } }));
  mocks.post.mockResolvedValue({ data: { id: game.id } });
  mocks.delete.mockResolvedValue({ data: { queued: false } });
  mocks.reload.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());
describe('card page resume and clock isolation', () => {
  it('respects per-scene new-game controls while retaining existing-room join', async () => {
    mocks.get.mockImplementation(async path => ({ data: path.endsWith('/config') ? { enabled: true, scenes: { friend: false } } : { id: null, queued: false } }));
    route('?menu=friend');
    expect(await screen.findByText('此场景暂时停止新开局，已有对局仍可继续。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建好友房' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ABCD1234' } });
    expect(screen.getByRole('button', { name: '加入' })).toBeEnabled();
  });
  it('renews a queue ticket without overlapping requests and cancels only that ticket on unmount', async () => {
    vi.useFakeTimers();
    mocks.get.mockImplementation(async path => ({ data: path.endsWith('/config') ? { enabled: true } : { queued: true, ticket: 'queue-ticket-1', id: null } }));
    let release!: (response: unknown) => void;
    mocks.post.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const page = route('?menu=ranked');
    await act(async () => {});
    // The pairing is pushed; the heartbeat only renews the lease every 5 seconds.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mocks.post).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocks.post).toHaveBeenCalledWith('/card-link/queue/heartbeat', { ticket: 'queue-ticket-1' });
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    page.unmount();
    expect(mocks.delete).toHaveBeenCalledWith('/card-link/queue', { data: { ticket: 'queue-ticket-1' } });
    await act(async () => { release({ data: { queued: true } }); await vi.advanceTimersByTimeAsync(10000); });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('enters a ranked match pushed by the server without polling for it', async () => {
    mocks.get.mockImplementation(async path => ({ data: path.endsWith('/config') ? { enabled: true } : { queued: true, ticket: 'queue-ticket-2', id: null } }));
    route('?menu=ranked');
    await waitFor(() => expect(socketMock.handlers.has('room-kernel:found')).toBe(true));
    act(() => socketMock.handlers.get('room-kernel:found')!({ game: 'card-link', roomId: 'pushed-room' }));
    await waitFor(() => expect(mocks.game).toHaveBeenLastCalledWith('pushed-room', false));
  });
  it('shows ranked ready confirmation without a host start button and displays the offline grace countdown', async () => {
    vi.useFakeTimers();
    game = { ...game, scene: 'ranked', host: true, dueAt: Date.now() + 30000,
      players: [{ id: 'other', name: 'Opponent', connected: false, disconnectAt: Date.now() + 30000, retired: false, ready: false }] } as unknown as View;
    const page = route('?game=new-room');
    expect(screen.getByText(/双方确认后开局/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '准备 / 取消准备' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始' })).toBeNull();
    expect(screen.getByText('（离线，30 秒内可重连）')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('（离线，29 秒内可重连）')).toBeInTheDocument();
    page.unmount();
  });
  it('displays the shared two-credit limit and keeps refresh enabled with two credits', () => {
    game = { ...game, variant: 'limited', status: 'playing', question: { start: 1, end: 2 },
      current: { board: [], hand: [3], discarded: [], links: [false], locked: false, startedAt: Date.now(), deadline: null,
        refreshes: 0, best: null, token: 2, remaining: 7, exhausted: false } } as View;
    route('?game=new-room');
    expect(screen.getByText('换牌机会: 2/2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '整手刷新' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '换这张' })).toBeEnabled();
  });
  it.each(['practice', 'daily'] as const)('restarts a finished %s game using its actual rules and prevents duplicate starts', async scene => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
    game = { ...game, scene, status: 'finished', variant: 'limited', difficulty: 'hard', duration: scene === 'daily' ? 0 : 120,
      current: { board: [], hand: [], discarded: [], links: [false], locked: true, startedAt: 0, stoppedAt: 1000, deadline: null,
        refreshes: 0, best: null, remaining: 0, token: 0, exhausted: false }, question: { start: 1, end: 2 } } as View;
    let finish!: (value: unknown) => void;
    mocks.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    route(scene === 'practice' ? '?solo=new-room' : '?game=new-room');
    const button = screen.getByRole('button', { name: '重新开始游戏' });
    fireEvent.click(button); fireEvent.click(button);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    // 单人 restarts like classic games on the shared game API; daily keeps its endpoint.
    if (scene === 'practice') expect(mocks.post).toHaveBeenCalledWith('/game/start',
      { variant: 'card-link', mode: 'hard', hand: 'limited', duration: 120 });
    else expect(mocks.post).toHaveBeenCalledWith('/card-link/matches', expect.objectContaining({ scene, variant: 'limited', difficulty: 'hard', duration: 0 }));
    expect(button).toBeDisabled();
    game = { ...game, id: 'next-room', status: 'playing', current: { ...game.current!, locked: false, hand: [3], stoppedAt: undefined } };
    await act(async () => { finish({ data: scene === 'practice' ? { gameId: 'next-room' } : { id: 'next-room' } }); });
    expect(mocks.game).toHaveBeenLastCalledWith('next-room', scene === 'practice');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-cl-card="3"]')).toHaveAttribute('data-cl-draggable');
  });
  it('keeps distant card and connection DOM identities when a middle card is removed', () => {
    game = { ...game, status: 'playing', question: { start: 1, end: 5 }, current: { board: [2, 3, 4], hand: [], discarded: [],
      links: [true, true, true, true], locked: false, startedAt: Date.now(), deadline: null, refreshes: 0, best: null,
      token: 0, remaining: 0, exhausted: false } } as View;
    const renderGame = () => <MemoryRouter initialEntries={['/entertainment/card-link?game=new-room']}><CardLink /></MemoryRouter>;
    const mounted = renderWithProviders(renderGame());
    const distant = document.querySelector('[data-cl-card="4"]');
    const endLink = screen.getByRole('button', { name: '插入位置 4' });
    game = { ...game, current: { ...game.current!, board: [2, 4], links: [true, false, true], discarded: [3] } };
    mounted.rerender(renderGame());
    expect(document.querySelector('[data-cl-card="4"]')).toBe(distant);
    expect(screen.getByRole('button', { name: '插入位置 3' })).toBe(endLink);
    expect([...document.querySelectorAll('.cl-board .cl-slot')].map(node => node.textContent)).toEqual(['✓', '＋', '✓']);
  });
  it('opens the daily top-ten panel from the existing leaderboard entry and follows the hand mode', async () => {
    route();
    fireEvent.click(screen.getByRole('button', { name: '每日挑战榜' }));
    expect(await screen.findByRole('heading', { name: '今日前十' })).toBeInTheDocument();
    expect(await screen.findByText('该手牌模式今天还没有通关记录')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('/card-link/daily-leaderboard', { params: { variant: 'unlimited' } });
    fireEvent.click(screen.getByRole('button', { name: '限定手牌' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/card-link/daily-leaderboard', { params: { variant: 'limited' } }));
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('opens the result once per round, permits reopening, and removes it when the next round starts', () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
    game = { ...game, me: 'a', status: 'roundOver', current: { board: [], hand: [], discarded: [], links: [false], locked: true,
      startedAt: 0, stoppedAt: 1000, deadline: null, refreshes: 0, best: null, remaining: 0, token: 0, exhausted: false }, question: { start: 1, end: 2 }, solution: [1, 3, 2] } as View;
    const renderGame = () => <MemoryRouter initialEntries={['/entertainment/card-link?game=new-room']}><CardLink /></MemoryRouter>;
    const mounted = renderWithProviders(renderGame());
    expect(screen.getByRole('dialog', { name: '本轮结算' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看牌桌' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '本轮结算' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    game = { ...game, round: 1, status: 'preparing', current: null, solution: null };
    mounted.rerender(renderGame());
    expect(screen.queryByRole('dialog')).toBeNull();
    game = { ...game, status: 'roundOver', current: { board: [], hand: [], discarded: [], links: [false], locked: true, startedAt: 2000, stoppedAt: 3000, deadline: null, refreshes: 0, best: null, remaining: 0, token: 0, exhausted: false } } as View;
    mounted.rerender(renderGame());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('explains a finished daily attempt and labels the retry as eligible for daily best', async () => {
    game = { ...game, scene: 'daily', status: 'finished', variant: 'limited', dailyPractice: false };
    route('?game=new-room');
    expect(screen.getByText(/本次每日挑战已结束。返回大厅/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回大厅' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '开始' })).toBeEnabled());
    game = { ...game, id: 'daily-practice', status: 'playing', dailyPractice: true };
    mocks.post.mockResolvedValue({ data: { id: game.id } });
    fireEvent.click(screen.getByRole('button', { name: '开始' }));
    expect(await screen.findByText(/本局为每日挑战重做，结算后参与当天最佳成绩比较/)).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/card-link/matches', expect.objectContaining({ scene: 'daily', variant: 'limited', duration: 0 }));
  });
  it('can resume a freshly created room after returning to the lobby', async () => {
    route('?menu=friend');
    const create = screen.getByRole('button', { name: '创建好友房' });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByRole('button', { name: '准备 / 取消准备' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '返回大厅' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复本局' }));
    expect(screen.getByRole('button', { name: '准备 / 取消准备' })).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('starts 单人 through the shared game API and resumes it from the lobby', async () => {
    game = { ...game, id: 'solo-room', scene: 'practice', status: 'playing', variant: 'unlimited', difficulty: 'normal', duration: 0,
      current: { board: [], hand: [3], discarded: [], links: [false], locked: false, startedAt: 0, deadline: null,
        refreshes: 0, best: null, remaining: 0, token: 0, exhausted: false }, question: { start: 1, end: 2 } } as unknown as View;
    mocks.post.mockResolvedValue({ data: { gameId: 'solo-room' } });
    route('?menu=practice');
    const start = await screen.findByRole('button', { name: '开始' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(mocks.game).toHaveBeenLastCalledWith('solo-room', true));
    expect(mocks.post).toHaveBeenCalledWith('/game/start', { variant: 'card-link', mode: 'normal', hand: 'unlimited', duration: 0 });
    fireEvent.click(screen.getByRole('button', { name: '返回大厅' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复本局' }));
    expect(mocks.game).toHaveBeenLastCalledWith('solo-room', true);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('ticks the clock without rendering the whole page or polling the server', async () => {
    vi.useFakeTimers();
    game = { ...game, status: 'playing', scene: 'practice', dueAt: Date.now() + 20000 };
    route('?game=new-room');
    await act(async () => {});
    mocks.game.mockClear();
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(screen.getByText('16 秒')).toBeInTheDocument();
    expect(mocks.game).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
  });
  it('does not overlap overdue recovery requests and cancels recovery on unmount', async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    mocks.reload.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    game = { ...game, status: 'playing', dueAt: Date.now() - 1 };
    const view = route('?game=new-room');
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { resolve(); });
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });
});
