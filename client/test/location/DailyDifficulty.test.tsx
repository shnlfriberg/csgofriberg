import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LocationGame from '../../src/pages/LocationGame';
import { useAuth } from '../../src/store/auth';
import { renderAtRoute } from '../render';
import type { Difficulty, GameView } from '../../src/location/types';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/location/api', () => ({ api: { get, post }, message: () => '测试网络中断' }));
const date = '2026-11-09';
const daily = () => ({ date, serverNow: Date.now(), nextRefreshAt: Date.now() + 3600000, available: true, difficulties: [] });
const key = (difficulty: Difficulty) => `tuxun:v2:guest:daily:${difficulty}:${date}`;
const view = (difficulty: Difficulty, status: GameView['status'] = 'finished'): GameView => ({
  id: `daily-${difficulty}`, mode: 'daily', date, difficulty, status, version: 5, scoringVersion: 1,
  totalRounds: 5, round: status === 'playing' ? 1 : 5, answered: status === 'playing' ? 0 : 5,
  maps: [], question: status === 'playing' ? { imageUrl: '/question.webp', round: 1 } : null,
  guesses: [], results: [], totalScore: status === 'finished' ? { easy: 11111, normal: 22222, hard: 12345 }[difficulty] : null,
  expiresAt: Date.now() + 3600000,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const choose = (name: string) => fireEvent.click(within(screen.getByRole('group', { name: '难度' })).getByRole('button', { name }));
beforeEach(() => {
  sessionStorage.clear(); get.mockReset(); post.mockReset();
  useAuth.setState({ user: null, initialized: true });
  HTMLDialogElement.prototype.close = vi.fn();
  get.mockImplementation(async (path: string) => ({ data: path === '/location/daily' ? daily() : { items: [] } }));
  post.mockImplementation(async (_path, body) => ({ data: view(body.difficulty, 'playing') }));
});

describe('daily location difficulty navigation', () => {
  it('can leave two restored settlements to play the remaining difficulty and revisit each result', async () => {
    for (const difficulty of ['normal', 'easy'] as const) sessionStorage.setItem(key(difficulty), view(difficulty).id);
    get.mockImplementation(async (path: string) => ({ data: path === '/location/daily' ? daily()
      : path === '/location/games/daily-normal' ? view('normal')
      : path === '/location/games/daily-easy' ? view('easy') : { items: [] } }));
    renderAtRoute(<LocationGame mode="daily" />);
    await screen.findByText('22,222');
    choose('简单'); await screen.findByText('11,111');
    choose('困难');
    fireEvent.click(await screen.findByRole('button', { name: '开始游戏' }));
    await screen.findByRole('button', { name: '提交本轮答案' });
    expect(post).toHaveBeenCalledExactlyOnceWith('/location/games', { mode: 'daily', difficulty: 'hard' });
    expect(sessionStorage.getItem(key('normal'))).toBe('daily-normal');
    expect(sessionStorage.getItem(key('easy'))).toBe('daily-easy');
    expect(sessionStorage.getItem(key('hard'))).toBe('daily-hard');
    choose('普通'); await screen.findByText('22,222');
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('ignores a slow previous-difficulty restore after switching to another difficulty', async () => {
    const old = deferred<{ data: GameView }>();
    sessionStorage.setItem(key('normal'), 'daily-normal');
    get.mockImplementation((path: string) => path === '/location/games/daily-normal' ? old.promise
      : Promise.resolve({ data: path === '/location/daily' ? daily() : { items: [] } }));
    renderAtRoute(<LocationGame mode="daily" />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/location/games/daily-normal'));
    choose('困难');
    fireEvent.click(await screen.findByRole('button', { name: '开始游戏' }));
    await screen.findByRole('button', { name: '提交本轮答案' });
    await act(async () => old.resolve({ data: view('normal') }));
    expect(screen.queryByText('22,222')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交本轮答案' })).toBeInTheDocument();
    expect(get.mock.calls.some(([path]) => path === '/location/leaderboard')).toBe(false);
  });
  it('does not request the next leaderboard using the previous settlement or display its delayed entries', async () => {
    const oldBoard = deferred<{ data: { items: Array<{ name: string; score: number; rank: number; me: boolean }> } }>();
    sessionStorage.setItem(key('normal'), 'daily-normal');
    get.mockImplementation((path: string) => path === '/location/leaderboard' ? oldBoard.promise
      : Promise.resolve({ data: path === '/location/daily' ? daily() : view('normal') }));
    renderAtRoute(<LocationGame mode="daily" />);
    await screen.findByText('22,222');
    await waitFor(() => expect(get).toHaveBeenCalledWith('/location/leaderboard', { params: { difficulty: 'normal', date } }));
    choose('困难'); await screen.findByRole('button', { name: '开始游戏' });
    await act(async () => oldBoard.resolve({ data: { items: [{ name: '旧难度玩家', score: 123, rank: 1, me: false }] } }));
    expect(screen.queryByText('旧难度玩家')).not.toBeInTheDocument();
    expect(get.mock.calls.filter(([path]) => path === '/location/leaderboard')).toHaveLength(1);
  });
  it('waits for the authoritative daily date before starting or restoring a game', async () => {
    const info = deferred<{ data: ReturnType<typeof daily> }>();
    sessionStorage.setItem('tuxun:v2:guest:daily:normal:', 'old-undated');
    get.mockReturnValue(info.promise);
    renderAtRoute(<LocationGame mode="daily" />);
    expect(screen.getByRole('button', { name: '开始游戏' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '开始游戏' }));
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalledWith('/location/games/old-undated');
    await act(async () => info.resolve({ data: daily() }));
    expect(await screen.findByRole('button', { name: '开始游戏' })).toBeEnabled();
  });
  it.each(['difficulty', 'date', 'mode'] as const)('discards a cached pointer to a game with the wrong %s', async field => {
    sessionStorage.setItem(key('normal'), 'stale-pointer');
    const wrong = { ...view('normal'), [field]: field === 'difficulty' ? 'easy' : field === 'date' ? '2026-11-08' : 'random' };
    get.mockImplementation(async (path: string) => ({ data: path === '/location/daily' ? daily()
      : path === '/location/leaderboard' ? { items: [] } : wrong }));
    renderAtRoute(<LocationGame mode="daily" />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/location/games/stale-pointer'));
    expect(await screen.findByRole('button', { name: '开始游戏' })).toBeEnabled();
    expect(sessionStorage.getItem(key('normal'))).toBeNull();
    expect(screen.queryByText('22,222')).not.toBeInTheDocument();
  });
  it('can retry a failed daily calendar request without accidentally starting a game', async () => {
    get.mockRejectedValueOnce(new Error('offline'));
    renderAtRoute(<LocationGame mode="daily" />);
    const alert = await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: '开始游戏' })).toBeDisabled();
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '开始游戏' })).toBeEnabled());
    expect(get.mock.calls.filter(([path]) => path === '/location/daily')).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
  });
  it('keeps unsubmitted daily progress when browsing a different difficulty and coming back', async () => {
    sessionStorage.setItem(key('normal'), 'daily-normal');
    sessionStorage.setItem(key('easy'), 'daily-easy');
    const ready = { ...view('normal', 'ready'), guesses: Array(5).fill({ mapId: 'map', floorId: 'f', u: .5, v: .5 }) };
    get.mockImplementation(async (path: string) => ({ data: path === '/location/daily' ? daily()
      : path === '/location/games/daily-normal' ? ready
      : path === '/location/games/daily-easy' ? view('easy') : { items: [] } }));
    renderAtRoute(<LocationGame mode="daily" />);
    await screen.findByRole('button', { name: '提交今日成绩' });
    choose('简单'); await screen.findByText('11,111');
    choose('普通'); await screen.findByRole('button', { name: '提交今日成绩' });
    expect(screen.getByText('五轮答案已保存，正式交卷后公布成绩。')).toBeInTheDocument();
    expect(sessionStorage.getItem(key('normal'))).toBe('daily-normal');
    expect(post).not.toHaveBeenCalled();
  });
});
