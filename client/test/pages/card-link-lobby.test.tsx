import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../render';
import CardLobby, { lobbySceneFrom, type LobbyScene } from '../../src/card-link/Lobby';

function props(scene: LobbyScene | null) {
  return { scene, navigate: vi.fn(), variant: 'unlimited' as const, setVariant: vi.fn(), disabled: false, loading: false, start: vi.fn(), join: vi.fn(), queue: vi.fn() };
}
describe('card lobby flow', () => {
  it('starts daily play without a timer and explains the midnight cutoff and ranking', () => {
    const options = props('daily'); renderWithProviders(<CardLobby {...options} />);
    expect(screen.getByText(/北京时间次日 00:00/)).toBeInTheDocument();
    expect(screen.getByText(/相同步数/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '开始' }));
    expect(options.start).toHaveBeenCalledWith('daily', 'normal', 0);
  });
  it('opens settings without creating a game or entering a queue', () => {
    const options = props(null); renderWithProviders(<CardLobby {...options} />);
    fireEvent.click(screen.getByRole('button', { name: '多人模式' }));
    expect(options.navigate).toHaveBeenCalledWith('friend');
    expect(options.start).not.toHaveBeenCalled(); expect(options.queue).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
  it('offers untimed solo play and isolates its duration from friend rooms', () => {
    const options = props('practice'); const view = renderWithProviders(<CardLobby {...options} />);
    expect(screen.getByRole('button', { name: '单人模式-无限手牌' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '单人模式-限定手牌' }));
    expect(options.setVariant).toHaveBeenCalledWith('limited');
    fireEvent.click(screen.getByRole('button', { name: '开始' }));
    expect(options.start).toHaveBeenLastCalledWith('practice', 'normal', 0);
    fireEvent.click(within(screen.getByRole('group', { name: '时间' })).getByRole('button', { name: '120 秒' }));
    fireEvent.click(screen.getByRole('button', { name: '开始' }));
    expect(options.start).toHaveBeenLastCalledWith('practice', 'normal', 120);
    view.rerender(<CardLobby {...options} scene="friend" />);
    expect(within(screen.getByRole('group', { name: '时间' })).queryByRole('button', { name: '不限时' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '创建好友房' }));
    expect(options.start).toHaveBeenLastCalledWith('friend', 'normal', 180);
    fireEvent.change(screen.getByLabelText('房间码'), { target: { value: 'abc123ef' } });
    fireEvent.click(screen.getByRole('button', { name: '加入' }));
    expect(options.join).toHaveBeenCalledWith('ABC123EF');
  });
  it('offers random matchmaking inside the multiplayer page with its own hand mode', () => {
    const options = props('friend'); renderWithProviders(<CardLobby {...options} />);
    // Three cards like 图寻 multiplayer: create, random match and join by code.
    expect(screen.getByRole('heading', { name: '创建好友房' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '随机匹配' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '进入已有房间' })).toBeInTheDocument();
    expect(screen.getByText(/统一普通难度/)).toBeInTheDocument();
    expect(options.queue).not.toHaveBeenCalled();
    const groups = screen.getAllByRole('group', { name: '手牌模式' });
    expect(groups).toHaveLength(2);
    fireEvent.click(within(groups[1]).getByRole('button', { name: '限定手牌' }));
    // Choosing the match hand mode does not change the friend-room setting.
    expect(options.setVariant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '开始匹配' }));
    expect(options.queue).toHaveBeenCalledWith('limited');
  });
  it('shows the queue inside the match card and keeps friend rooms independent of a ranked pause', () => {
    const options = { ...props('friend'), queued: true, cancelQueue: vi.fn(), sceneAccess: { ranked: false } };
    const view = renderWithProviders(<CardLobby {...options} />);
    expect(screen.getByText('匹配中，离开页面不自动取消')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消匹配' }));
    expect(options.cancelQueue).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '创建好友房' })).toBeDisabled();
    view.rerender(<CardLobby {...options} queued={false} />);
    expect(screen.getByRole('button', { name: '开始匹配' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '创建好友房' })).toBeEnabled();
    expect(screen.getAllByText('此场景暂时停止新开局，已有对局仍可继续。')).toHaveLength(1);
  });
  it('requires a verified email for random matchmaking only', () => {
    const options = { ...props('friend'), matchAllowed: false }; renderWithProviders(<CardLobby {...options} />);
    expect(screen.getByText('随机匹配仅对已登录且完成邮箱验证的用户开放。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始匹配' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '创建好友房' })).toBeEnabled();
  });
  it('lists three entries and opens old ranked links on the multiplayer page', () => {
    renderWithProviders(<CardLobby {...props(null)} />);
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['单人模式', '每日挑战', '多人模式']);
    expect(lobbySceneFrom('ranked')).toBe('friend');
    expect(lobbySceneFrom('daily')).toBe('daily');
    expect(lobbySceneFrom('unknown')).toBeNull();
  });
});
