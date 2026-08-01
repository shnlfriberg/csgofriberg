import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import i18n from '../../i18n';
import { renderWithProviders } from '../../test/render';
import AdminReports from './AdminReports';

vi.mock('../../api/client', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
  },
  errMsg: vi.fn(() => 'request failed'),
}));

describe('AdminReports', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('zh');
    vi.mocked(api.get).mockResolvedValue({
      data: {
        reports: [{
          id: 4,
          matchId: 9,
          roomId: 'ROOM1',
          mode: 'easy',
          boType: 3,
          reporter: '用户#AAAAA',
          reported: '访客#BBBBB',
          description: '疑似自动化操作',
          status: 'pending',
          adminNote: '',
          createdAt: '2026-08-02T00:00:00.000Z',
          handledAt: null,
          matchCreatedAt: '2026-08-02T00:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1,
      },
    } as never);
    vi.mocked(api.patch).mockResolvedValue({ data: { ok: true } } as never);
  });

  it('lists pending reports and saves the processing result', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminReports />);

    const reportRow = (await screen.findByText('疑似自动化操作')).closest('tr')!;
    expect(api.get).toHaveBeenCalledWith('/admin/reports', {
      params: { status: 'pending', page: 1, pageSize: 50 },
    });
    await user.click(screen.getByRole('button', { name: '处理举报' }));
    const dialog = screen.getByRole('dialog', { name: '处理举报' });
    await user.selectOptions(within(dialog).getByLabelText('处理状态', { selector: 'select' }), 'resolved');
    await user.type(screen.getByPlaceholderText('填写处理记录，最多 500 字'), '已核查并处理');
    await user.click(screen.getByRole('button', { name: '保存处理结果' }));

    expect(api.patch).toHaveBeenCalledWith('/admin/reports/4', {
      status: 'resolved',
      adminNote: '已核查并处理',
    });
    expect(dialog).not.toBeInTheDocument();
    expect(within(reportRow).getByText('已处理')).toBeInTheDocument();
  });
});
