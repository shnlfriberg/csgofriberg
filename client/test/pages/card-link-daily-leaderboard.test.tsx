import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../render';
import CardDailyLeaderboard, { type DailyRank } from '../../src/card-link/DailyLeaderboard';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/api/client', () => ({ api: mocks, errMsg: () => '榜单加载失败' }));
beforeEach(() => vi.clearAllMocks());
describe('card daily top ten', () => {
  it('uses the daily heading and columns, keeps server rank order and shows millisecond times for the first ten', async () => {
    mocks.get.mockResolvedValue({ data: Array.from({ length: 12 }, (_, i) => ({ username: `Player ${i + 1}`, hops: i + 2, elapsed: 12345 + i })) });
    renderWithProviders(<CardDailyLeaderboard variant="limited" />);
    expect(screen.getByRole('heading', { name: '今日前十' })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map(e => e.textContent)).toEqual(['#', '玩家', '步数', '时间']);
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('1Player 12 跳12.345 秒');
    expect(screen.queryByText('Player 11')).toBeNull();
    expect(screen.getByText('TOP 10')).toBeInTheDocument();
    expect(screen.getByText('限定手牌')).toBeInTheDocument();
  });
  it('clears the previous mode and ignores its late response after a hand-mode switch', async () => {
    let resolveOld!: (value: { data: DailyRank[] }) => void;
    mocks.get.mockImplementation((_path, config) => config.params.variant === 'limited'
      ? Promise.resolve({ data: [] }) : new Promise(resolve => { resolveOld = resolve; }));
    const mounted = renderWithProviders(<CardDailyLeaderboard variant="unlimited" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    mounted.rerender(<CardDailyLeaderboard variant="limited" />);
    expect(await screen.findByText('该手牌模式今天还没有通关记录')).toBeInTheDocument();
    await act(async () => { resolveOld({ data: [{ username: 'Stale', hops: 2, elapsed: 1000 }] }); });
    expect(screen.queryByText('Stale')).toBeNull();
    expect(screen.getByText('限定手牌')).toBeInTheDocument();
  });
  it('distinguishes errors from an empty leaderboard and permits a retry', async () => {
    mocks.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: [{ username: 'Recovered', hops: 3, elapsed: 9000 }] });
    renderWithProviders(<CardDailyLeaderboard variant="limited" />);
    expect(await screen.findByText('榜单加载失败')).toBeInTheDocument();
    expect(screen.queryByText('该手牌模式今天还没有通关记录')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('Recovered')).toBeInTheDocument();
    expect(screen.queryByText('榜单加载失败')).toBeNull();
  });
});
