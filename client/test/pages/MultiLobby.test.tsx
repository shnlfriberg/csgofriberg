import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import { useAuth } from '../../src/store/auth';
import MultiLobby from '../../src/pages/MultiLobby';

const socket = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => void>(),
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('../../src/api/socket', () => ({ getSocket: () => socket }));

describe('MultiLobby matchmaking', () => {
  beforeEach(() => {
    useAuth.setState({
      user: { id: 7, username: 'verified-user', role: 'user', email: 'verified@example.com', emailVerified: true },
      initialized: true,
    });
    socket.handlers.clear();
    socket.on.mockReset();
    socket.off.mockReset();
    socket.emit.mockReset();
    socket.on.mockImplementation((event: string, handler: (...args: any[]) => void) => {
      socket.handlers.set(event, handler);
    });
    socket.emit.mockImplementation((event: string, ...args: any[]) => {
      const ack = args.at(-1);
      if (event === 'room:sync' && typeof ack === 'function') ack({ code: 'NOT_IN_ROOM' });
      if (event === 'match:start' && typeof ack === 'function') ack({ queued: true });
    });
  });

  it('navigates to the ready room immediately when a match is found', async () => {
    const user = userEvent.setup();
    renderAtRoute(<MultiLobby />, {
      route: '/multi',
      path: '/multi',
      extraRoutes: <Route path="/multi/room" element={<div>ready room</div>} />,
    });

    await user.click(await screen.findByRole('button', { name: '开始匹配' }));
    await waitFor(() => expect(socket.handlers.get('match:found')).toBeTypeOf('function'));
    act(() => socket.handlers.get('match:found')?.({}));

    expect(await screen.findByText('ready room')).toBeInTheDocument();
  });

  it('remembers create-room and matchmaking options on this browser', async () => {
    const user = userEvent.setup();
    const first = renderAtRoute(<MultiLobby />, { route: '/multi', path: '/multi' });

    const easyButtons = await screen.findAllByRole('button', { name: '简单版' });
    await user.click(easyButtons[0]);
    await user.click(screen.getByRole('button', { name: 'BO5' }));
    await user.click(screen.getByRole('checkbox', { name: '允许观战' }));
    await user.click(screen.getByRole('checkbox', { name: '仅允许已验证邮箱用户加入' }));
    expect(screen.getByRole('group')).not.toHaveAttribute('open');
    await user.click(screen.getByText('更多设置'));
    const maxGuesses = screen.getByRole('spinbutton', { name: '最大猜测次数' });
    const guessInterval = screen.getByRole('spinbutton', { name: '猜测间隔' });
    fireEvent.change(maxGuesses, { target: { value: '12' } });
    fireEvent.change(guessInterval, { target: { value: '2.5' } });
    await user.click(easyButtons[1]);

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('csgofriberg.multi-lobby-preferences') ?? '{}'))
        .toEqual({
        createDifficulty: 'easy',
        boType: 5,
        allowSpectators: true,
        verifiedEmailOnly: true,
        maxGuesses: 12,
        guessIntervalSeconds: 2.5,
        matchmakingDifficulty: 'easy',
        });
    });

    first.unmount();
    renderAtRoute(<MultiLobby />, { route: '/multi', path: '/multi' });
    const restoredEasyButtons = await screen.findAllByRole('button', { name: '简单版' });
    expect(restoredEasyButtons[0]).toHaveClass('active');
    expect(restoredEasyButtons[1]).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'BO5' })).toHaveClass('active');
    expect(screen.getByRole('checkbox', { name: '允许观战' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '仅允许已验证邮箱用户加入' })).toBeChecked();
    await user.click(screen.getByText('更多设置'));
    expect(screen.getByRole('spinbutton', { name: '最大猜测次数' })).toHaveValue(12);
    expect(screen.getByRole('spinbutton', { name: '猜测间隔' })).toHaveValue(2.5);
  });

  it('requires a verified email before starting quick match', () => {
    useAuth.setState({
      user: { id: 8, username: 'unverified-user', role: 'user', email: 'unverified@example.com', emailVerified: false },
      initialized: true,
    });
    renderAtRoute(<MultiLobby />, { route: '/multi', path: '/multi' });

    expect(screen.getByText('随机匹配仅对已登录且完成邮箱验证的用户开放。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始匹配' })).toBeDisabled();
  });

  it('sends the verified-email restriction when creating a room', async () => {
    const user = userEvent.setup();
    renderAtRoute(<MultiLobby />, { route: '/multi', path: '/multi' });

    await user.click(screen.getByRole('checkbox', { name: '仅允许已验证邮箱用户加入' }));
    await user.click(screen.getByText('更多设置'));
    const maxGuesses = screen.getByRole('spinbutton', { name: '最大猜测次数' });
    const guessInterval = screen.getByRole('spinbutton', { name: '猜测间隔' });
    fireEvent.change(maxGuesses, { target: { value: '15' } });
    fireEvent.change(guessInterval, { target: { value: '0' } });
    await user.click(screen.getByRole('button', { name: '创建房间' }));

    expect(socket.emit).toHaveBeenCalledWith('room:create', expect.objectContaining({
      verifiedOnly: true,
      maxGuesses: 15,
      guessIntervalMs: 0,
    }), expect.any(Function));
  });
});
