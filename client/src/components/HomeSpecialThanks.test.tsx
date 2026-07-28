import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import i18n from '../i18n';
import { renderWithProviders } from '../test/render';
import HomeSpecialThanks from './HomeSpecialThanks';

vi.mock('../api/client', () => ({
  api: { get: vi.fn() },
}));

describe('HomeSpecialThanks', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('zh');
  });

  it('renders the public thanks list only after entries load', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get).mockResolvedValue({
      data: {
        items: [
          { id: 1, name: 'Major Contributor', note: 'Verified historical data' },
          { id: 2, name: '社区玩家', note: '持续反馈游戏体验' },
        ],
      },
    } as never);

    renderWithProviders(<HomeSpecialThanks />);

    expect(screen.queryByRole('button', { name: '特别感谢' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '特别感谢' }));
    expect(await screen.findByRole('heading', { name: '特别感谢' })).toBeInTheDocument();
    expect(screen.getByText('Major Contributor')).toBeInTheDocument();
    expect(screen.getByText('Verified historical data')).toBeInTheDocument();
    expect(screen.getByText('社区玩家')).toBeInTheDocument();
    expect(screen.getByText('持续反馈游戏体验')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
