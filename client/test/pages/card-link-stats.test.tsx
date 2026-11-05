import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import Stats from '../../src/pages/Stats';
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/api/client', () => ({ api: { get }, errMsg: () => 'Failed' }));
const summary = { games: 2, entries: 2, rounds: 2, solved: 1, modes: { practice: 2 }, solveRate: .5, averageHops: 3, averageElapsed: 2500 };
beforeEach(() => {
  get.mockReset();
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
  get.mockImplementation(async (path: string) => ({ data: path === '/card-link/stats'
    ? { personal: summary, global: summary, rating: 1200 }
    : path.startsWith('/card-link/history/') ? { playersDirectory: [{ id: 1, nickname: 'A' }, { id: 2, nickname: 'B' }], players: [{ id: 'me', name: 'Player', retired: false, results: [{ path: [1, 2], elapsed: 1000 }] }], evidence: [] }
    : { hasNext: true, items: [{ id: 'game-1', scene: 'practice', variant: 'unlimited', solved: 1, rounds: 1, hops: 3, elapsed: 2500, finishedAt: 1700000000000, retired: false, rank: null }] } }));
});
describe('card career page', () => {
  it('uses the common career tabs, summaries, mode filters and pagination', async () => {
    renderAtRoute(<Stats />, { route: '/stats?variant=card-link', path: '/stats' });
    expect(screen.getByRole('tab', { name: '卡牌连接' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('1200')).toBeInTheDocument();
    expect(screen.getAllByText('50.0%')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('手牌模式'), { target: { value: 'limited' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/card-link/stats', { params: { variant: 'limited' } }));
    fireEvent.change(screen.getByRole('combobox', { name: '模式' }), { target: { value: 'friend' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/card-link/replays', { params: { variant: 'limited', scene: 'friend', page: 1 } }));
    await waitFor(() => expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/card-link/replays', { params: { variant: 'limited', scene: 'friend', page: 2 } }));
  });
  it('opens an authorized historical replay in the common dialog layout', async () => {
    renderAtRoute(<Stats />, { route: '/stats?variant=card-link', path: '/stats' });
    const buttons = await screen.findAllByRole('button', { name: '回放' });
    fireEvent.click(buttons[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('article', { name: 'A' })).toBeInTheDocument();
    expect(within(dialog).getByRole('article', { name: 'B' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/card-link/history/game-1');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭回放' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
