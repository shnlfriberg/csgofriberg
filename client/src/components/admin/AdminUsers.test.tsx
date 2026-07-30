import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import i18n from '../../i18n';
import { renderWithProviders } from '../../test/render';
import AdminUsers from './AdminUsers';

vi.mock('../../api/client', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
  },
  errMsg: vi.fn(() => 'request failed'),
}));

describe('AdminUsers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('zh');
    vi.mocked(api.get).mockImplementation(async (url) => {
      if (url === '/admin/users') return { data: { users: [{ id: 7, username: 'ranked-user', displayId: '用户#ABCDE', role: 'user', leaderboardHidden: false, createdAt: '2026-07-27T00:00:00.000Z' }], total: 1, page: 1, pageSize: 50, totalPages: 1 } } as never;
      if (url === '/admin/users/7/stats') return { data: { user: { id: 7 }, stats: { single: { games: 2, wins: 1, losses: 1, winRate: 0.5, avgGuesses: 2, bestGuesses: 2 }, multi: { games: 3, wins: 2, losses: 1, winRate: 0.667, recentAverageWinningGuesses: 1.5 } } } } as never;
      if (url === '/admin/users/7/leaderboards') return { data: { leaderboardHidden: false, entries: Array.from({ length: 6 }, (_, index) => ({ mode: index % 2 ? 'multi' : 'single', difficulty: ['beginner', 'easy', 'normal'][Math.floor(index / 2)], rank: index + 1, totalRanked: 10, total: 2, wins: 1, winRate: 0.5, avgGuesses: 2 })) } } as never;
      if (url === '/admin/users/7/analysis') return { data: { summary: { similarityIndex: 42, level: 'common', sampleSize: 1, confidence: 50, averageEntropyPercentile: 45, topDecileRate: 0, lowRegretRate: 0, analyzedRounds: 1, truncated: false }, limitations: { hasGuessTiming: false, usesCurrentPlayerData: true, statement: 'test' } } } as never;
      return { data: { items: [], hasNext: false, page: 1, pageSize: 10 } } as never;
    });
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: 7, leaderboardHidden: true },
    } as never);
  });

  it('opens one details action with four lazy-loaded tabs', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminUsers />);

    expect(await screen.findByRole('button', { name: /详情/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /详情/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '查看战绩' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '对局记录' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '排行榜' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '对局分析' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/admin/users/7/stats');

    await user.click(screen.getByRole('tab', { name: '排行榜' }));
    expect(await screen.findByText('#1')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/admin/users/7/leaderboards');

    await user.click(screen.getByRole('tab', { name: '对局分析' }));
    expect(await screen.findByText('算法相似指数')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/admin/users/7/analysis');
  });

  it('updates leaderboard visibility from the details tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminUsers />);
    await user.click(await screen.findByRole('button', { name: /详情/ }));
    await user.click(screen.getByRole('tab', { name: '排行榜' }));
    const toggle = await screen.findByRole('checkbox');
    expect(toggle).toBeChecked();

    await user.click(toggle);

    expect(api.patch).toHaveBeenCalledWith('/admin/users/7/leaderboard-visibility', { hidden: true });
    expect(screen.getAllByText('已隐藏').length).toBeGreaterThanOrEqual(1);
  });
});
