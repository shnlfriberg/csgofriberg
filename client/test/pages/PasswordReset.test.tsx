import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import PasswordReset from '../../src/pages/PasswordReset';
import Login from '../../src/pages/Login';

const mocks = vi.hoisted(() => ({ post: vi.fn(), captcha: vi.fn(), clear: vi.fn(), close: vi.fn() }));
vi.mock('../../src/api/client', () => ({ api: { post: mocks.post }, errMsg: () => '验证码无效或已过期' }));
vi.mock('../../src/api/geetest', () => ({ requestGeeTest: mocks.captcha }));
vi.mock('../../src/api/authSession', () => ({ clearAuthenticated: mocks.clear }));
vi.mock('../../src/api/socket', () => ({ closeSocket: mocks.close, getSocket: vi.fn() }));
vi.mock('../../src/api/session', () => ({ markAuthenticated: vi.fn() }));

describe('password recovery form', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.post.mockResolvedValue({ data: { ok: true, retryAfterSeconds: 30 } });
    mocks.captcha.mockResolvedValue({ enabled: true, proof: { lot_number: 'proof' } });
  });
  it('offers recovery from login', () => {
    renderAtRoute(<Login />, { path: '/login', route: '/login' });
    expect(screen.getByRole('link', { name: '忘记密码' })).toHaveAttribute('href', '/password-reset');
  });
  it('requires the username before requesting a code', async () => {
    const user = userEvent.setup(); renderAtRoute(<PasswordReset />);
    await user.type(screen.getByLabelText('绑定邮箱'), 'bound@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请输入用户名');
    expect(mocks.captcha).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
  it('requires human verification, displays a generic send message and blocks repeated sends', async () => {
    const user = userEvent.setup(); renderAtRoute(<PasswordReset />);
    await user.type(screen.getByLabelText('用户名'), 'test-user');
    await user.type(screen.getByLabelText('绑定邮箱'), 'bound@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    expect(mocks.captcha).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledWith('/auth/password/request', { username: 'test-user', email: 'bound@example.com', lot_number: 'proof' });
    expect(screen.getByRole('status')).toHaveTextContent('验证码已发送');
    expect(screen.getByRole('button', { name: /秒后可重新发送/ })).toBeDisabled();
  });
  it('does not send if human verification is cancelled', async () => {
    mocks.captcha.mockResolvedValue({ enabled: true, proof: null });
    const user = userEvent.setup(); renderAtRoute(<PasswordReset />);
    await user.type(screen.getByLabelText('用户名'), 'test-user');
    await user.type(screen.getByLabelText('绑定邮箱'), 'bound@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    expect(mocks.post).not.toHaveBeenCalled(); expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: '发送验证码' })).toBeEnabled();
  });
  it('validates matching passwords then resets and returns to login', async () => {
    const user = userEvent.setup(); renderAtRoute(<PasswordReset />);
    await user.type(screen.getByLabelText('用户名'), 'test-user');
    await user.type(screen.getByLabelText('绑定邮箱'), 'bound@example.com');
    await user.type(screen.getByLabelText('邮箱验证码'), '012345');
    await user.type(screen.getByLabelText('新密码（10–128 位）'), 'New-strong-password');
    await user.type(screen.getByLabelText('确认密码'), 'wrong');
    await user.click(screen.getByRole('button', { name: '重置密码' }));
    expect(screen.getByRole('alert')).toHaveTextContent('两次输入的密码不一致'); expect(mocks.post).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('确认密码')); await user.type(screen.getByLabelText('确认密码'), 'New-strong-password');
    await user.click(screen.getByRole('button', { name: '重置密码' }));
    expect(mocks.post).toHaveBeenCalledWith('/auth/password/reset', { username: 'test-user', email: 'bound@example.com', code: '012345', password: 'New-strong-password' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('账号 test-user 的密码重置成功'));
    expect(mocks.clear).toHaveBeenCalledOnce(); expect(mocks.close).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: '返回登录' })).toHaveAttribute('href', '/login');
    expect(screen.queryByLabelText('新密码（10–128 位）')).toBeNull();
  });
  it('retains input and allows retry on failure', async () => {
    mocks.post.mockRejectedValue(new Error('failed'));
    const user = userEvent.setup(); renderAtRoute(<PasswordReset />);
    await user.type(screen.getByLabelText('用户名'), 'test-user');
    await user.type(screen.getByLabelText('绑定邮箱'), 'bound@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    expect(screen.getByRole('alert')).toHaveTextContent('验证码无效或已过期');
    expect(screen.getByLabelText('绑定邮箱')).toHaveValue('bound@example.com');
    expect(screen.getByRole('button', { name: '发送验证码' })).toBeEnabled();
  });
});
