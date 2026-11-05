import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stats from '../../src/pages/Stats';
import { Route } from 'react-router-dom';
import LocationHistory from '../../src/pages/LocationHistory';
import { renderAtRoute } from '../render';
import type { LocationStatsSummary, MapDefinition, ReplayRecord, RoundResult } from '../../src/location/types';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../src/api/client', () => ({ api: { get }, errMsg: () => '加载失败' }));
vi.mock('../../src/location/api', () => ({ api: { get }, message: () => '加载失败' }));
const map: MapDefinition = {
  id: 'de_dust2', name: 'Dust2', enabled: true, order: 0, version: 1, width: 1024, height: 1024,
  floors: [{ id: 'main', name: 'Main', radarUrl: '/dust.webp' }],
  bounds: { u: 0, v: 0, width: 1, height: 1 }, calibration: { posX: 0, posY: 1024, scale: 1, points: [] },
};
const round = (number: number, score = 5000): RoundResult => ({
  round: number, imageUrl: `/round-${number}.webp`, questionId: `question-${number}`, questionVersion: 1,
  tier: 'easy', guess: { mapId: map.id, floorId: 'main', u: .2, v: .3 },
  answer: { mapId: map.id, floorId: 'main', u: .3, v: .4 }, map, guessedMap: map,
  score, distanceRatio: .01, mapCorrect: true, floorCorrect: true,
});
const owner = { key: 'g:mine', userId: null, name: '我方' };
const replay: ReplayRecord = {
  gameId: 'game-one', owner, mode: 'random', difficulty: 'normal', date: null,
  totalScore: 10000, scoringVersion: 1, difficultyMix: { easy: 2, medium: 0, hard: 0 }, results: [round(1), round(2)],
};
const summary: LocationStatsSummary = {
  acceptedSubmissions: 3,
  singleGames: 5, randomGames: 3, dailyGames: 2, averageScore: 15000, bestScore: 25000,
  multiGames: 4, multiEntries: 4, multiWins: 2, multiAverageScore: 12345,
};
const item = { gameId: 'game-one', mode: 'random', difficulty: 'normal', totalScore: 10000,
  finishedAt: 1792342427027, rank: null, retired: false };

beforeEach(() => {
  get.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  get.mockImplementation(async (url: string, options?: { params?: { type?: string } }) => {
    if (url === '/location/stats') return { data: { difficulties: ['easy', 'normal', 'hard'], personal: summary,
      global: { ...summary, multiGames: 10, multiEntries: 25 } } };
    if (url === '/location/replays') return { data: { page: 1, pageSize: 15, hasNext: true,
      items: [{ ...item, mode: options?.params?.type === 'multi' ? 'multiplayer' : 'random' }] } };
    if (url.endsWith('/replay')) return { data: replay };
    throw new Error(`Unexpected URL ${url}`);
  });
});

describe('integrated location statistics', () => {
  it('uses the existing personal/global cards and filters history by difficulty, mode and replay type', async () => {
    renderAtRoute(<Stats />, { route: '/stats?variant=location', path: '/stats' });
    expect(screen.getByRole('tab', { name: '图寻' })).toHaveAttribute('aria-selected', 'true');
    await screen.findAllByText('15,000');
    expect(get).toHaveBeenCalledWith('/location/stats', { params: { difficulties: 'easy,normal,hard' } });
    expect(get.mock.calls.some(([url]) => url.startsWith('/stats/'))).toBe(false);
    const personal = screen.getByRole('heading', { name: '个人统计' }).closest('.card')!;
    expect(within(personal as HTMLElement).getByText('题目被采纳数（累计）').closest('tr')).toHaveTextContent('3');
    expect(within(personal as HTMLElement).getByText('4 / 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/location/replays', { params: {
      difficulties: 'easy,normal,hard', type: 'single', mode: 'all', page: 2, pageSize: 15,
    } }));
    fireEvent.click(screen.getByText('全部分级', { selector: '.difficulty-multi-select-summary' }));
    fireEvent.click(within(screen.getByRole('group', { name: '统计难度' })).getByRole('checkbox', { name: /^简单$/ }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/location/replays', { params: {
      difficulties: 'normal,hard', type: 'single', mode: 'all', page: 1, pageSize: 15,
    } }));
    fireEvent.change(screen.getByRole('combobox', { name: '模式' }), { target: { value: 'daily' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/location/replays', { params: {
      difficulties: 'normal,hard', type: 'single', mode: 'daily', page: 1, pageSize: 15,
    } }));
    fireEvent.click(screen.getByRole('tab', { name: /^多人$/ }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/location/replays', { params: {
      difficulties: 'normal,hard', type: 'multi', mode: 'daily', page: 1, pageSize: 15,
    } }));
  });
  it('opens a screenshot replay with answer/guess overlays, round thumbnails and image enlargement', async () => {
    renderAtRoute(<Stats />, { route: '/stats?variant=location', path: '/stats' });
    fireEvent.click((await screen.findAllByRole('button', { name: '回放对局 game-one' }))[0]);
    const dialog = await screen.findByRole('dialog', { name: '图寻对局回放' });
    expect(dialog.querySelector('.location-photo > img')).toHaveAttribute('src', '/round-1.webp');
    expect(within(dialog).getByLabelText('正确位置')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('你的落点')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '下一轮' }));
    expect(dialog.querySelector('.location-photo > img')).toHaveAttribute('src', '/round-2.webp');
    expect(within(dialog).getByRole('button', { name: '第 2 轮' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: '放大截图' }));
    expect(dialog.querySelector('.location-photo-dialog')).toHaveAttribute('open');
    fireEvent.click(within(dialog).getByRole('button', { name: /^关闭$/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭回放' }));
    expect(screen.queryByRole('dialog', { name: '图寻对局回放' })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });
  it('switches multiplayer player pins and does not mix their individual rounds or scores', async () => {
    const original = get.getMockImplementation()!;
    get.mockImplementation(async (url, options) => url.endsWith('/replay') ? { data: { ...replay,
      mode: 'multiplayer', myKey: owner.key, roomResults: [
        { key: owner.key, name: '我方', rounds: [round(1), round(2)] },
        { key: 'g:other', name: '对手', rounds: [round(1, 1200), round(2, 1200)] },
      ] } } : original(url, options));
    renderAtRoute(<Stats />, { route: '/stats?variant=location', path: '/stats' });
    fireEvent.click((await screen.findAllByRole('button', { name: '回放对局 game-one' }))[0]);
    const dialog = await screen.findByRole('dialog', { name: '图寻对局回放' });
    fireEvent.change(within(dialog).getByLabelText('查看玩家落点'), { target: { value: 'g:other' } });
    expect(within(dialog).getByText(/2,400 \/ 25,000/)).toBeInTheDocument();
    expect(dialog.querySelector('.location-round-score')).toHaveTextContent('1,200');
    expect(within(dialog).getByLabelText('对手')).toBeInTheDocument();
  });
  it('retries a failed summary request and routes the former history entry to unified statistics', async () => {
    const original = get.getMockImplementation()!;
    let fail = true;
    get.mockImplementation((url, options) => {
      if (url === '/location/stats' && fail) { fail = false; return Promise.reject(new Error('offline')); }
      return original(url, options);
    });
    renderAtRoute(<LocationHistory />, { route: '/entertainment/location/history', path: '/entertainment/location/history',
      extraRoutes: <Route path="/stats" element={<Stats />} /> });
    expect(await screen.findByRole('alert')).toHaveTextContent('加载失败');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findAllByText('15,000');
    expect(screen.getByRole('tab', { name: '图寻' })).toHaveAttribute('aria-selected', 'true');
    expect(get.mock.calls.filter(([url]) => url === '/location/stats')).toHaveLength(2);
  });
  it('discards a late replay response after the selected mode changes', async () => {
    const original = get.getMockImplementation()!;
    let finish!: (data: unknown) => void;
    get.mockImplementation((url, options) => url.endsWith('/replay')
      ? new Promise((resolve) => { finish = resolve; }) : original(url, options));
    renderAtRoute(<Stats />, { route: '/stats?variant=location', path: '/stats' });
    fireEvent.click((await screen.findAllByRole('button', { name: '回放对局 game-one' }))[0]);
    fireEvent.change(screen.getByRole('combobox', { name: '模式' }), { target: { value: 'daily' } });
    await act(async () => { finish({ data: replay }); });
    expect(screen.queryByRole('dialog', { name: '图寻对局回放' })).not.toBeInTheDocument();
  });
});
