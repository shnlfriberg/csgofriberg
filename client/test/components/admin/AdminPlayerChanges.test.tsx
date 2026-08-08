import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../src/api/client';
import i18n from '../../../src/i18n';
import { renderWithProviders } from '../../render';
import AdminPlayerChanges from '../../../src/components/admin/AdminPlayerChanges';

vi.mock('../../../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  errMsg: vi.fn(() => 'request failed'),
}));

describe('AdminPlayerChanges', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('zh');
    vi.mocked(api.get).mockResolvedValue({
      data: {
        items: [
          { id: 11, submissionId: 3, playerId: 7, playerNickname: 'device', field: 'team', oldValue: 'Astralis', newValue: 'Falcons', status: 'pending', source: 'sync job', createdAt: '2026-08-05T00:00:00.000Z', handledAt: null, handledBy: null },
          { id: 12, submissionId: 3, playerId: 7, playerNickname: 'device', field: 'age', oldValue: 30, newValue: 31, status: 'pending', source: 'sync job', createdAt: '2026-08-05T00:00:00.000Z', handledAt: null, handledBy: null },
        ],
        total: 2, page: 1, pageSize: 50, totalPages: 1,
      },
    } as never);
    vi.mocked(api.post).mockResolvedValue({
      data: { approved: 2, rejected: 0, conflict: 0, updated: 2 },
    } as never);
  });

  it('selects the visible field changes and approves them together', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminPlayerChanges />);

    expect(await screen.findByText('Falcons')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/admin/player-change-submissions', {
      params: { status: 'pending', page: 1, pageSize: 50, search: undefined },
    });
    await user.click(screen.getByRole('checkbox', { name: '全选当前页待审核变更' }));
    await user.click(screen.getByRole('button', { name: '通过选中（2）' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '通过选中（2）' }));

    expect(api.post).toHaveBeenCalledWith('/admin/player-change-submissions/review', {
      itemIds: [11, 12],
      decision: 'approve',
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });
});
