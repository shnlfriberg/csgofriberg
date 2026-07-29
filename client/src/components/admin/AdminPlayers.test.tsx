import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import i18n from '../../i18n';
import { renderWithProviders } from '../../test/render';
import { toast } from '../Toast';
import AdminPlayers from './AdminPlayers';

vi.mock('../../api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  errMsg: vi.fn(() => 'request failed'),
}));

vi.mock('../Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('AdminPlayers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('zh');
  });

  it('downloads the complete import-compatible player JSON', async () => {
    const exportedPlayers = [{
      nickname: 'export-player',
      nationality: '中国',
      region: '亚洲',
      team: 'Test',
      age: 24,
      role: 'Rifler',
      major_championships: 0,
      major_appearances: 1,
      difficulties: ['easy', 'normal'],
      is_active: true,
      is_enabled: true,
    }];
    vi.mocked(api.get).mockImplementation(async (url) => {
      if (url === '/admin/players/export') return { data: exportedPlayers } as never;
      return {
        data: { players: [], total: 0, page: 1, pageSize: 50, totalPages: 1 },
      } as never;
    });
    const createObjectURL = vi.fn(() => 'blob:players');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const user = userEvent.setup();
    renderWithProviders(<AdminPlayers />);
    await screen.findByText('0 条');
    await user.click(screen.getByRole('button', { name: '导出 JSON' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/players/export'));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:players');
    expect(toast.success).toHaveBeenCalledWith('已导出 1 名选手');
  });
});
