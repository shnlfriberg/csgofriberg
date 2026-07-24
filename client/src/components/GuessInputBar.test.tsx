import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GuessInputBar from './GuessInputBar';
import { renderWithProviders } from '../test/render';

const players = [
  { id: 1, nickname: 's1mple' },
  { id: 2, nickname: 'ZywOo' },
];

vi.mock('../api/playerList', () => ({
  getPlayerList: vi.fn(async () => players),
  searchPlayerList: (list: typeof players, query: string) =>
    list.filter((item) => item.nickname.toLowerCase().includes(query.trim().toLowerCase())),
}));

describe('GuessInputBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows submitting on the button only, never a secondary status line', async () => {
    const user = userEvent.setup();
    let resolvePick: ((value: void) => void) | undefined;
    const onPick = vi.fn(() => new Promise<void>((resolve) => {
      resolvePick = resolve;
    }));

    renderWithProviders(<GuessInputBar onPick={onPick} />);

    await user.type(screen.getByPlaceholderText('输入选手昵称...'), 's1');
    await screen.findByText('s1mple');
    await user.click(screen.getByRole('button', { name: '提交猜测' }));

    expect(await screen.findByRole('button', { name: '提交中...' })).toBeDisabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('正在提交...')).not.toBeInTheDocument();

    resolvePick?.();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '提交猜测' })).toBeInTheDocument();
    });
  });

  it('keeps input text when onPick rejects the guess (network/busy guard)', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn(async () => false);
    renderWithProviders(<GuessInputBar onPick={onPick} />);

    const input = screen.getByPlaceholderText('输入选手昵称...');
    await user.type(input, 's1');
    await screen.findByText('s1mple');
    await user.click(screen.getByRole('button', { name: '提交猜测' }));

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(input).toHaveValue('s1');
  });

  it('disables input while parent marks the dock busy (desktop and mobile)', () => {
    renderWithProviders(<GuessInputBar onPick={vi.fn()} disabled />);
    expect(screen.getByPlaceholderText('输入选手昵称...')).toBeDisabled();
    expect(screen.getByRole('button', { name: '提交猜测' })).toBeDisabled();
  });

  it('renders external status only when explicitly provided (e.g. multi cooldown)', () => {
    renderWithProviders(<GuessInputBar onPick={vi.fn()} statusText="冷却 2s" />);
    expect(screen.getByRole('status')).toHaveTextContent('冷却 2s');
  });
});
