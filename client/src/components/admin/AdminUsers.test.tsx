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
    vi.mocked(api.get).mockResolvedValue({
      data: {
        users: [{
          id: 7,
          username: 'ranked-user',
          displayId: '用户#ABCDE',
          role: 'user',
          leaderboardHidden: false,
          createdAt: '2026-07-27T00:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1,
      },
    } as never);
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: 7, leaderboardHidden: true },
    } as never);
  });

  it('hides a user from leaderboards with the row toggle', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminUsers />);

    const toggle = await screen.findByRole('checkbox', { name: '从排行榜隐藏 ranked-user' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('显示中')).toBeInTheDocument();

    await user.click(toggle);

    expect(api.patch).toHaveBeenCalledWith('/admin/users/7/leaderboard-visibility', { hidden: true });
    expect(toggle).toBeChecked();
    expect(screen.getByText('已隐藏')).toBeInTheDocument();
  });
});
