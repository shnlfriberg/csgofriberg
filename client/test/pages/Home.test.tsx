import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/api/client';
import { useAuth } from '../../src/store/auth';
import { renderAtRoute } from '../render';
import Home from '../../src/pages/Home';

const apiGet = vi.hoisted(() => vi.fn());

vi.mock('../../src/api/client', () => ({
  api: { get: apiGet, post: vi.fn() },
  errMsg: vi.fn(() => '请求失败'),
}));

describe('Home email verification reminder', () => {
  beforeEach(() => {
    const user = {
      id: 7,
      username: 'tester',
      role: 'user' as const,
      email: 'tester@example.com',
      emailVerified: false,
    };
    useAuth.setState({ user, initialized: true });
    apiGet.mockReset();
    apiGet.mockResolvedValue({ data: { user } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ features: { leaderboard: true } }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the reminder and opens personal settings when clicked', async () => {
    const user = userEvent.setup();
    renderAtRoute(<Home />);

    const reminder = screen.getByRole('button', { name: '邮箱尚未验证，点击设置完成验证' });
    expect(reminder).toBeInTheDocument();

    await user.click(reminder);

    expect(await screen.findByRole('dialog', { name: '个人设置' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/auth/me');
  });

  it('places the daily challenge as the first home menu entry', () => {
    renderAtRoute(<Home />);

    const daily = screen.getByRole('link', { name: /每日挑战/ });
    expect(daily.parentElement?.firstElementChild).toBe(daily);
  });

  it.each([
    ['verified email', { email: 'tester@example.com', emailVerified: true }],
    ['no email', { email: null, emailVerified: false }],
    ['guest', null],
  ])('does not show the reminder for %s', (_label, emailState) => {
    if (emailState) {
      useAuth.setState({
        user: {
          id: 7,
          username: 'tester',
          role: 'user',
          ...emailState,
        },
        initialized: true,
      });
    } else {
      useAuth.setState({ user: null, initialized: true });
    }

    renderAtRoute(<Home />);

    expect(screen.queryByRole('button', { name: /邮箱尚未验证/ })).not.toBeInTheDocument();
  });
});
