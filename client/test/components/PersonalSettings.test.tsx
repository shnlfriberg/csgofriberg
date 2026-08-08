import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/api/client';
import { requestGeeTest } from '../../src/api/geetest';
import { useAuth } from '../../src/store/auth';
import { renderWithProviders } from '../render';
import PersonalSettings from '../../src/components/PersonalSettings';

vi.mock('../../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  errMsg: vi.fn(() => '请求失败'),
}));

vi.mock('../../src/api/geetest', () => ({
  requestGeeTest: vi.fn().mockResolvedValue({ enabled: false, proof: null }),
}));

describe('PersonalSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requestGeeTest).mockResolvedValue({ enabled: false, proof: null });
    useAuth.setState({ user: null, initialized: true });
  });

  it('stores and immediately applies the animation preference', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PersonalSettings />);

    await user.click(screen.getByRole('button', { name: '个人设置' }));
    const motion = screen.getByRole('switch', { name: '动画效果' });
    expect(motion).toBeChecked();

    await user.click(motion);
    expect(motion).not.toBeChecked();
    expect(localStorage.getItem('ui-motion')).toBe('off');
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduced');

    await user.click(motion);
    expect(localStorage.getItem('ui-motion')).toBe('on');
    expect(document.documentElement).not.toHaveAttribute('data-motion');
  });

  it('disables verification email resends during the server cooldown', async () => {
    const user = {
      id: 7,
      username: 'tester',
      role: 'user' as const,
      email: null,
      emailVerified: false,
    };
    useAuth.setState({ user, initialized: true });
    vi.mocked(api.get).mockResolvedValue({ data: { user } } as never);
    const serverNow = Date.now();
    vi.mocked(api.post).mockResolvedValue({
      data: { ok: true, serverNow, retryAt: serverNow + 30_000 },
    } as never);
    renderWithProviders(<PersonalSettings />);

    fireEvent.click(screen.getByRole('button', { name: '个人设置' }));
    fireEvent.change(screen.getByPlaceholderText('可选，输入邮箱地址'), {
      target: { value: 'tester@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /30 秒后可重新发送/ })).toBeDisabled();
    });
    expect(api.post).toHaveBeenCalledWith('/auth/email/request', { email: 'tester@example.com' });
  });

  it('uses a registered email without requiring an input change', async () => {
    const user = {
      id: 9,
      username: 'registered-user',
      role: 'user' as const,
      email: 'registered@example.com',
      emailVerified: false,
    };
    useAuth.setState({ user, initialized: true });
    vi.mocked(api.get).mockResolvedValue({ data: { user } } as never);
    vi.mocked(api.post).mockResolvedValue({ data: { ok: true } } as never);
    renderWithProviders(<PersonalSettings />);

    fireEvent.click(screen.getByRole('button', { name: '个人设置' }));
    const send = screen.getByRole('button', { name: '发送验证码' });
    expect(send).toBeEnabled();
    fireEvent.click(send);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/auth/email/request', { email: 'registered@example.com' });
    });
  });

  it('verifies an unverified email with a six-digit code', async () => {
    const user = {
      id: 10,
      username: 'code-user',
      role: 'user' as const,
      email: 'code@example.com',
      emailVerified: false,
    };
    const verifiedUser = { ...user, emailVerified: true };
    useAuth.setState({ user, initialized: true });
    vi.mocked(api.get)
      .mockResolvedValueOnce({ data: { user } } as never)
      .mockResolvedValueOnce({ data: { user: verifiedUser } } as never);
    vi.mocked(api.post).mockResolvedValue({ data: { ok: true } } as never);
    renderWithProviders(<PersonalSettings />);

    fireEvent.click(screen.getByRole('button', { name: '个人设置' }));
    fireEvent.change(await screen.findByPlaceholderText('输入 6 位验证码'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: '验证邮箱' }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/auth/email/verify-code', { code: '123456' });
    });
    await waitFor(() => expect(screen.queryByPlaceholderText('输入 6 位验证码')).not.toBeInTheDocument());
  });

  it('masks the local part of a verified email address', async () => {
    const user = {
      id: 8,
      username: 'tester',
      role: 'user' as const,
      email: 'alice@example.com',
      emailVerified: true,
    };
    useAuth.setState({ user, initialized: true });
    vi.mocked(api.get).mockResolvedValue({ data: { user } } as never);
    renderWithProviders(<PersonalSettings />);

    fireEvent.click(screen.getByRole('button', { name: '个人设置' }));

    const emailInput = await screen.findByDisplayValue('a**@example.com');
    expect(emailInput).toBeDisabled();
    expect(screen.queryByDisplayValue('alice@example.com')).not.toBeInTheDocument();
  });
});
