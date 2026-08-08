import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../src/api/client';
import i18n from '../../../src/i18n';
import { renderWithProviders } from '../../render';
import AdminReports from '../../../src/components/admin/AdminReports';

vi.mock('../../../src/api/client', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
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
          reporterKey: 'u:1',
          reportedKey: 'g:BBBBB',
          reporter: '用户#AAAAA',
          reported: '访客#BBBBB',
          description: '疑似自动化操作',
          status: 'pending',
          adminNote: '',
          createdAt: '2026-08-02T00:00:00.000Z',
          handledAt: null,
          matchCreatedAt: '2026-08-02T00:00:00.000Z',
          pendingForReported: 2,
          pendingReporterCount: 2,
          whitelisted: false,
        }],
        total: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1,
      },
    } as never);
    vi.mocked(api.patch).mockResolvedValue({ data: { ok: true } } as never);
    vi.mocked(api.post).mockResolvedValue({ data: { ok: true, dismissed: 2 } } as never);
  });

  it('lists pending reports and saves the processing result', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminReports />);

    const reportRow = (await screen.findByText('疑似自动化操作')).closest('tr')!;
    expect(api.get).toHaveBeenCalledWith('/admin/reports', {
      params: { status: 'pending', reporterFilter: 'all', page: 1, pageSize: 50, search: undefined },
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

  it('searches reports by either participant', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminReports />);

    await screen.findByText('疑似自动化操作');
    await user.type(screen.getByPlaceholderText('搜索举报方或被举报方'), '访客#BBBBB');
    await waitFor(() => {
      expect(api.get).toHaveBeenLastCalledWith('/admin/reports', {
        params: { status: 'pending', reporterFilter: 'all', page: 1, pageSize: 50, search: '访客#BBBBB' },
      });
    });
  });

  it('filters reports to targets with at least two distinct reporters', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminReports />);

    await screen.findByText('疑似自动化操作');
    await user.selectOptions(screen.getByLabelText('举报人数', { selector: 'select' }), 'multiple');

    await waitFor(() => {
      expect(api.get).toHaveBeenLastCalledWith('/admin/reports', {
        params: { status: 'pending', reporterFilter: 'multiple', page: 1, pageSize: 50, search: undefined },
      });
    });
  });

  it('keeps quick actions available when the current page has no reports', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValueOnce({
      data: { reports: [], total: 0, page: 1, pageSize: 50, totalPages: 1 },
    } as never);
    renderWithProviders(<AdminReports />);

    await screen.findByText('暂无符合条件的举报');
    const quickAction = screen.getByLabelText('快速操作', { selector: 'select' });
    expect(quickAction).not.toBeDisabled();
    await user.selectOptions(quickAction, 'single');

    expect(api.post).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('quick dismisses pending targets reported by one identity', async () => {
    const user = userEvent.setup();
    vi.mocked(api.post).mockResolvedValueOnce({
      data: { ok: true, targetCount: 2, updated: 3, hasMore: false },
    } as never);
    renderWithProviders(<AdminReports />);

    await screen.findByText('疑似自动化操作');
    await user.selectOptions(screen.getByLabelText('快速操作', { selector: 'select' }), 'single');
    const dialog = screen.getByRole('alertdialog', { name: '快速驳回当前页单人举报？' });
    await user.click(within(dialog).getByRole('button', { name: '驳回当前页单人举报' }));

    expect(api.post).toHaveBeenCalledWith('/admin/reports/quick-dismiss/single-reporter', {
      adminNote: '快速驳回：仅有一个独立举报人',
      reportedKeys: ['g:BBBBB'],
    });
  });

  it('runs external analysis only after the admin requests it', async () => {
    const user = userEvent.setup();
    vi.mocked(api.post).mockResolvedValueOnce({
      data: {
        schemaVersion: 1,
        requestId: '11111111-1111-4111-8111-111111111111',
        analysisId: 'analysis-4',
        modelVersion: '2026.08.1',
        generatedAt: '2026-08-02T12:00:00.000Z',
        decision: { level: 'high', score: 92, label: '高风险', summary: '行为与自动化求解器高度吻合' },
        sections: [{ title: '行为特征', items: [{ type: 'metric', label: '异常回合', value: 12, displayValue: '12 次', severity: 'danger' }] }],
      },
    } as never);
    renderWithProviders(<AdminReports />);

    await screen.findByText('疑似自动化操作');
    await user.click(screen.getByRole('button', { name: '处理举报' }));
    expect(screen.getByText('尚未请求外部分析。')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith('/admin/reports/4/analysis', expect.anything());

    await user.click(screen.getByRole('button', { name: '开始分析' }));

    expect(api.post).toHaveBeenCalledWith('/admin/reports/4/analysis', { locale: 'zh-CN' });
    expect(await screen.findByText('高风险')).toBeInTheDocument();
    expect(screen.getByText('92')).toBeInTheDocument();
    expect(screen.getByText('12 次')).toBeInTheDocument();
  });

  it('selects reports and processes the selected rows in one batch', async () => {
    const user = userEvent.setup();
    vi.mocked(api.patch).mockResolvedValueOnce({ data: { ok: true, updated: 1 } } as never);
    renderWithProviders(<AdminReports />);

    await screen.findByText('疑似自动化操作');
    await user.click(screen.getByRole('checkbox', { name: '选择对 访客#BBBBB 的举报' }));
    await user.click(screen.getByRole('button', { name: '批量处理选中（1）' }));
    const dialog = screen.getByRole('dialog', { name: '批量处理选中（1）' });
    await user.selectOptions(within(dialog).getByLabelText('处理状态', { selector: 'select' }), 'dismissed');
    await user.type(within(dialog).getByPlaceholderText('填写处理记录，最多 500 字'), '批量核查');
    await user.click(within(dialog).getByRole('button', { name: '批量保存' }));

    expect(api.patch).toHaveBeenCalledWith('/admin/reports/batch-selected', {
      reportIds: [4],
      status: 'dismissed',
      adminNote: '批量核查',
    });
  });

  it('opens the existing user detail dialog for the reported identity', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminReports />);

    await screen.findByText('疑似自动化操作');
    vi.mocked(api.get)
      .mockResolvedValueOnce({
        data: {
          type: 'user',
          user: {
            id: 9,
            username: 'reported-user',
            displayId: '用户#ZZZZZ',
            role: 'user',
            leaderboardHidden: false,
            matchmakingRestricted: false,
            email: null,
            emailVerified: false,
            banned: false,
            createdAt: '2026-08-02T00:00:00.000Z',
          },
        },
      } as never)
      .mockResolvedValueOnce({
        data: {
          user: { id: 9 },
          stats: {
            single: { games: 2, wins: 1, losses: 1, winRate: 0.5, avgGuesses: 2, bestGuesses: 2 },
            multi: { games: 3, wins: 2, losses: 1, winRate: 0.667, recentAverageWinningGuesses: 1.5 },
          },
        },
      } as never);

    await user.click(screen.getByRole('button', { name: '查看被举报人详情' }));

    expect(api.get).toHaveBeenCalledWith('/admin/reports/4/reported-identity');
    expect(await screen.findByRole('dialog', { name: '用户详情' })).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/users/9/stats'));
    expect(screen.getByRole('tab', { name: '对局记录' })).toBeInTheDocument();
  });

  it('batch processes pending reports for the same reported identity', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminReports />);

    await screen.findByText('疑似自动化操作');
    await user.click(screen.getByRole('button', { name: '处理举报' }));
    const dialog = screen.getByRole('dialog', { name: '处理举报' });
    await user.selectOptions(within(dialog).getByLabelText('处理状态', { selector: 'select' }), 'resolved');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '批量保存' }));

    expect(api.patch).toHaveBeenCalledWith('/admin/reports/batch', {
      reportedKey: 'g:BBBBB',
      status: 'resolved',
      adminNote: '',
    });
  });

  it('adds the reported identity to the whitelist', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminReports />);

    await screen.findByText('疑似自动化操作');
    await user.click(screen.getByRole('button', { name: '处理举报' }));
    await user.click(screen.getByRole('button', { name: '加入举报白名单' }));

    expect(api.post).toHaveBeenCalledWith('/admin/reports/whitelist', {
      reportedKey: 'g:BBBBB',
      adminNote: '',
    });
  });

  it('keeps the admin note focused when the report list rerenders', async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(<AdminReports />);

    await screen.findByText('疑似自动化操作');
    await user.click(screen.getByRole('button', { name: '处理举报' }));
    const note = screen.getByPlaceholderText('填写处理记录，最多 500 字');
    await user.type(note, '已');
    expect(note).toHaveFocus();

    rerender(<AdminReports />);
    expect(note).toHaveFocus();
    await user.type(note, '核查');
    expect(note).toHaveValue('已核查');
  });
});
