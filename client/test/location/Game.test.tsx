import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LocationGame from '../../src/pages/LocationGame';
import Entertainment from '../../src/pages/Entertainment';
import LocationMenu from '../../src/pages/LocationMenu';
import { useAuth } from '../../src/store/auth';
import { renderAtRoute } from '../render';
import type { GameView, MapDefinition } from '../../src/location/types';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/location/api', () => ({
  api: { get, post },
  message: () => '测试网络中断',
}));
const map: MapDefinition = {
  id: 'de_cache',
  name: 'Cache',
  enabled: true,
  order: 1,
  version: 1,
  width: 1024,
  height: 1024,
  bounds: { u: 0, v: 0, width: 1, height: 1 },
  floors: [{ id: 'main', name: 'main', radarUrl: '/cache.webp' }],
  calibration: { posX: 0, posY: 0, scale: 1, points: [] },
};
const ready: GameView = {
  id: 'private-game',
  mode: 'daily',
  date: '2026-10-05',
  difficulty: 'normal',
  status: 'ready',
  version: 5,
  scoringVersion: 1,
  totalRounds: 5,
  round: 5,
  answered: 5,
  maps: [map],
  question: null,
  guesses: Array(5).fill({ mapId: map.id, floorId: 'main', u: 0.5, v: 0.5 }),
  results: [],
  totalScore: null,
  expiresAt: Date.now() + 3600000,
};
beforeEach(() => {
  get.mockReset();
  post.mockReset();
  useAuth.setState({ user: null, initialized: true });
  HTMLDialogElement.prototype.close = vi.fn();
  get.mockImplementation(async (path: string) => ({
    data:
      path === '/location/maps' ? [map, { ...map, id: 'de_nuke', name: 'Nuke' }, { ...map, id: 'de_mirage', name: 'Mirage' }] : path === '/location/daily'
        ? {
            date: '2026-10-05',
            serverNow: Date.now(),
            nextRefreshAt: Date.now() + 3600000,
            available: true,
            difficulties: [],
          }
        : { items: [] },
  }));
});
describe('location pages', () => {
  it('restores bans from the server after reload and can clear bans on maps no longer in the lobby catalog', async () => {
    const playing = { ...ready, mode: 'random', status: 'playing', round: 1, answered: 0,
      bannedMapIds: ['de_cache', 'removed_map'], question: { imageUrl: '/test.webp', round: 1 } };
    sessionStorage.setItem('tuxun:v2:guest:random:normal:', playing.id);
    get.mockImplementation(async (path: string) => ({ data: path === '/location/maps' ? [map] : playing }));
    post.mockResolvedValue({ data: { ok: true } });
    renderAtRoute(<LocationGame mode="random" />);
    expect(await screen.findByRole('button', { name: '死城之谜 Cache' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '放弃本局' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃本局' }));
    fireEvent.click(await screen.findByText('禁用地图（Ban 图）'));
    fireEvent.click(await screen.findByRole('button', { name: '清空禁图' }));
    expect(screen.getByText('0 / 2')).toBeInTheDocument();
  });
  it('lets solo players ban at most two maps, disables them in play and retains bans on restart', async () => {
    const maps = [map, { ...map, id: 'de_nuke', name: 'Nuke' }, { ...map, id: 'de_mirage', name: 'Mirage' }];
    const bans = ['de_cache', 'de_nuke'];
    const playing = { ...ready, id: 'banned-game', mode: 'random', date: null, status: 'playing',
      version: 0, round: 1, answered: 0, guesses: [], maps, bannedMapIds: bans,
      question: { imageUrl: '/test.webp', round: 1 } };
    post.mockResolvedValueOnce({ data: playing }).mockResolvedValueOnce({ data: { ...playing, status: 'finished', totalScore: 1, question: null } })
      .mockResolvedValueOnce({ data: { ...playing, id: 'banned-next' } });
    renderAtRoute(<LocationGame mode="random" />);
    expect(document.title).toContain('图寻单人模式');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    const toggle = screen.getByText('禁用地图（Ban 图）').closest('summary')!;
    expect(toggle.parentElement).not.toHaveAttribute('open');
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole('button', { name: '死城之谜' }));
    fireEvent.click(screen.getByRole('button', { name: '核子危机' }));
    expect(screen.getByRole('button', { name: '荒漠迷城' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /死城之谜\s*已禁用/ }));
    expect(screen.getByRole('button', { name: '荒漠迷城' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '死城之谜' }));
    fireEvent.click(toggle);
    expect(toggle.parentElement).not.toHaveAttribute('open');
    expect(toggle).toHaveTextContent('2 / 2');
    fireEvent.click(screen.getByRole('button', { name: '开始游戏' }));
    await screen.findByRole('button', { name: '提交本轮答案' });
    expect(post).toHaveBeenCalledWith('/location/games', { mode: 'random', difficulty: 'normal', bannedMapIds: ['de_nuke', 'de_cache'] });
    const blocked = screen.getByRole('button', { name: '死城之谜 Cache' });
    expect(blocked).toBeDisabled(); expect(blocked).toHaveClass('location-map-banned');
    fireEvent.click(screen.getByRole('button', { name: '荒漠迷城 Mirage' }));
    fireEvent.keyDown(screen.getByRole('group', { name: '再找位置' }), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: '提交本轮答案' }));
    fireEvent.click(await screen.findByRole('button', { name: '再玩一局' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/location/games', { mode: 'random', difficulty: 'normal', bannedMapIds: bans }));
  });
  it('restarts random solo directly with the same difficulty and keeps results if the request fails', async () => {
    const finished = { ...ready, mode: 'random', difficulty: 'hard', status: 'finished', totalScore: 1234 };
    post.mockResolvedValueOnce({ data: finished }).mockRejectedValueOnce(new Error('offline'));
    renderAtRoute(<LocationGame mode="random" />);
    fireEvent.click(screen.getByRole('button', { name: '开始游戏' }));
    fireEvent.click(await screen.findByRole('button', { name: '再玩一局' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('测试网络中断');
    expect(screen.getByText('1,234')).toBeInTheDocument();
    post.mockResolvedValueOnce({ data: { ...finished, id: 'next-game', status: 'playing', round: 1, answered: 0, totalScore: 0,
      question: { imageUrl: '/test.webp', round: 1 } } });
    fireEvent.click(screen.getByRole('button', { name: '再玩一局' }));
    expect(await screen.findByRole('button', { name: '提交本轮答案' })).toBeInTheDocument();
    expect(post).toHaveBeenLastCalledWith('/location/games', { mode: 'random', difficulty: 'hard' });
    expect(screen.queryByRole('button', { name: '开始游戏' })).toBeNull();
    expect(screen.queryByRole('button', { name: '再玩一局' })).toBeNull();
  });
  it('groups entertainment entries by game and keeps modes one level deeper', () => {
    const { container } = renderAtRoute(<Entertainment />);
    expect(document.title).toContain('娱乐模式');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByText('3 种小游戏')).not.toBeInTheDocument();
    expect([...container.querySelectorAll('.location-mode-card')].map(link => link.getAttribute('href')))
      .toEqual(['/entertainment/location', '/turtle-soup', '/entertainment/card-link']);
    expect(screen.queryByRole('link', { name: /图寻每日挑战/ })).not.toBeInTheDocument();
  });
  it('offers daily, infinite and multiplayer inside the location menu', () => {
    const { container } = renderAtRoute(<LocationMenu />);
    expect(document.title).toContain('图寻');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect([...container.querySelectorAll('.location-mode-card')].map(link => link.getAttribute('href')))
      .toEqual(['/entertainment/location/daily', '/entertainment/location/random', '/entertainment/location/multi']);
    expect(screen.getByRole('link', { name: /娱乐模式/ })).toHaveAttribute('href', '/entertainment');
    expect(container.querySelector('a[href="/entertainment/location/history"]')).not.toBeInTheDocument();
    expect(container.querySelector('a[href="/entertainment/location/submit"]')).toBeInTheDocument();
  });
  it('keeps the location rules trigger inside each single-player mode page', async () => {
    renderAtRoute(<LocationGame mode="random" />);
    expect(
      await screen.findByRole('button', { name: '图寻游戏规则' })
    ).toBeInTheDocument();
  });
  it('shows only saved guesses before the explicit daily final submission', async () => {
    post.mockResolvedValue({ data: ready });
    renderAtRoute(<LocationGame mode="daily" />);
    expect(screen.queryByText('禁用地图（Ban 图）')).toBeNull();
    expect(get.mock.calls.some(call => call[0] === '/location/maps')).toBe(false);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/location/daily'));
    expect(get).not.toHaveBeenCalledWith(
      '/location/leaderboard',
      expect.anything()
    );
    fireEvent.click(screen.getByRole('button', { name: '开始游戏' }));
    expect(
      await screen.findByText('五轮答案已保存，正式交卷后公布成绩。')
    ).toBeInTheDocument();
    expect(screen.queryByText('地图正确')).not.toBeInTheDocument();
    expect(screen.queryByText('本局结果')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '提交今日成绩' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(post).toHaveBeenCalledTimes(1);
    post.mockResolvedValue({
      data: { ...ready, status: 'finished', results: [], totalScore: 10000 },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: '提交今日成绩' })
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/location/games/private-game/submit')
    );
    expect(await screen.findByText('10,000')).toBeInTheDocument();
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/location/leaderboard', {
        params: { difficulty: 'normal', date: '2026-10-05' },
      })
    );
    expect(
      screen.getByRole('region', { name: '每日排行榜' })
    ).toBeInTheDocument();
  });
  it('retains the exact answer request after an ambiguous network failure', async () => {
    const playing = {
      ...ready,
      mode: 'random',
      status: 'playing',
      version: 0,
      answered: 0,
      round: 1,
      guesses: [],
      question: { imageUrl: '/test.webp', round: 1 },
    };
    post
      .mockResolvedValueOnce({ data: playing })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        data: {
          ...playing,
          status: 'finished',
          answered: 5,
          question: null,
          totalScore: 1,
        },
      });
    renderAtRoute(<LocationGame mode="random" />);
    fireEvent.click(screen.getByRole('button', { name: '开始游戏' }));
    fireEvent.click(await screen.findByRole('button', { name: '死城之谜 Cache' }));
    fireEvent.keyDown(screen.getByRole('group', { name: '再找位置' }), {
      key: 'ArrowRight',
    });
    fireEvent.click(screen.getByRole('button', { name: '提交本轮答案' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('测试网络中断');
    const payload = post.mock.calls[1][1];
    expect(payload.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(screen.getByRole('button', { name: '提交本轮答案' })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: '重试' }).at(-1)!);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2][1]).toEqual(payload);
  });
});
