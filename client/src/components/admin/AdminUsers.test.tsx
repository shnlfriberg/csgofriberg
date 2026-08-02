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
    post: vi.fn(),
  },
  errMsg: vi.fn(() => 'request failed'),
}));

describe('AdminUsers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('zh');
    vi.mocked(api.get).mockImplementation(async (url) => {
      if (url === '/admin/users') return { data: { users: [{ id: 7, username: 'ranked-user', displayId: '用户#ABCDE', role: 'user', leaderboardHidden: false, matchmakingRestricted: false, createdAt: '2026-07-27T00:00:00.000Z' }], total: 1, page: 1, pageSize: 50, totalPages: 1 } } as never;
      if (url === '/admin/users/7/stats') return { data: { user: { id: 7 }, stats: { single: { games: 2, wins: 1, losses: 1, winRate: 0.5, avgGuesses: 2, bestGuesses: 2 }, multi: { games: 3, wins: 2, losses: 1, winRate: 0.667, recentAverageWinningGuesses: 1.5 } } } } as never;
      if (url === '/admin/users/7/leaderboards') return { data: { leaderboardHidden: false, entries: Array.from({ length: 6 }, (_, index) => ({ mode: index % 2 ? 'multi' : 'single', difficulty: ['beginner', 'easy', 'normal'][Math.floor(index / 2)], rank: index + 1, totalRanked: 10, total: 2, wins: 1, winRate: 0.5, avgGuesses: 2 })) } } as never;
      return { data: { items: [], hasNext: false, page: 1, pageSize: 10 } } as never;
    });
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: 7, leaderboardHidden: true },
    } as never);
    vi.mocked(api.post).mockResolvedValue({
      data: {
        schemaVersion: 1,
        requestId: '11111111-1111-4111-8111-111111111111',
        analysisId: 'analysis-7',
        modelVersion: '2026.08.1',
        generatedAt: '2026-08-02T12:00:00.000Z',
        decision: { level: 'high', score: 92, label: '高风险', summary: '行为与自动化求解器高度吻合' },
        sections: [{ title: '行为特征', items: [{ type: 'text', label: '时间模式', displayValue: '存在固定间隔', severity: 'warning' }] }],
      },
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
    expect(screen.getByText('尚未请求外部分析。')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '开始分析' }));
    expect(api.post).toHaveBeenCalledWith('/admin/users/7/analysis', { locale: 'zh-CN' });
    expect(await screen.findByText('高风险')).toBeInTheDocument();
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

  it('restricts multiplayer matchmaking from the analysis tab', async () => {
    const user = userEvent.setup();
    vi.mocked(api.patch).mockResolvedValueOnce({
      data: { id: 7, matchmakingRestricted: true },
    } as never);
    renderWithProviders(<AdminUsers />);
    await user.click(await screen.findByRole('button', { name: /详情/ }));
    await user.click(screen.getByRole('tab', { name: '对局分析' }));
    const toggle = await screen.findByRole('checkbox', { name: '正常匹配' });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    expect(api.patch).toHaveBeenCalledWith('/admin/users/7/matchmaking-restriction', { restricted: true });
    expect(screen.getByRole('checkbox', { name: '已限制' })).toBeChecked();
    expect(screen.queryByText(/隔离匹配池/)).not.toBeInTheDocument();
  });
});
