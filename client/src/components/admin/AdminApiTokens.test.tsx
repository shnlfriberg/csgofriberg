import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../../api/client';
import i18n from '../../i18n';
import { renderWithProviders } from '../../test/render';
import AdminApiTokens from './AdminApiTokens';

vi.mock('../../api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  errMsg: vi.fn(() => 'request failed'),
}));

describe('AdminApiTokens', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('zh');
    vi.mocked(api.get).mockResolvedValue({ data: { tokens: [] } } as never);
  });

  it('creates a token, shows its secret once, and copies it', async () => {
    const user = userEvent.setup();
    const secret = `csgf_${'a'.repeat(43)}`;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(api.post).mockResolvedValue({
      data: {
        id: 1,
        name: '选手同步',
        prefix: 'csgf_aaaaaaaa...',
        token: secret,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
      },
    } as never);

    renderWithProviders(<AdminApiTokens />);
    expect(await screen.findByText('暂无有效 API Token')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('例如：选手数据同步'), '选手同步');
    await user.click(screen.getByRole('button', { name: '生成 Token' }));

    expect(api.post).toHaveBeenCalledWith('/admin/api-tokens', {
      name: '选手同步',
      expiresInDays: 90,
    });
    expect(await screen.findByDisplayValue(secret)).toBeInTheDocument();
    expect(screen.getByText('明文仅显示这一次，请妥善保管。')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '复制 Token' }));
    expect(writeText).toHaveBeenCalledWith(secret);
  });
});
