import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../render';
import CardLobby, { type LobbyScene } from '../../src/card-link/Lobby';

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
  it('only queues after confirmation and shows the enforced ranked rules', () => {
    const options = props('ranked'); renderWithProviders(<CardLobby {...options} />);
    expect(options.queue).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(/统一普通难度/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '开始匹配' }));
    expect(options.queue).toHaveBeenCalledTimes(1);
  });
});
