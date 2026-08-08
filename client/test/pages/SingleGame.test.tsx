import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Route } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SingleGame from '../../src/pages/SingleGame';
import { renderAtRoute } from '../render';
import { api } from '../../src/api/client';
import { installViewportMocks } from '../setup';

vi.mock('../../src/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/client')>('../../src/api/client');
  return {
    ...actual,
    api: {
      post: vi.fn(),
      get: vi.fn(),
    },
  };
});

vi.mock('../../src/api/playerList', () => ({
  getPlayerList: vi.fn(async () => [{ id: 1, nickname: 's1mple' }]),
  subscribePlayerList: vi.fn(() => () => undefined),
  searchPlayerList: (list: Array<{ id: number; nickname: string }>, query: string) =>
    list.filter((item) => item.nickname.toLowerCase().includes(query.trim().toLowerCase())),
}));

const post = vi.mocked(api.post);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderGame(mode = 'easy') {
  return renderAtRoute(
    <SingleGame />,
    {
      route: `/single/${mode}`,
      path: '/single/:mode',
      extraRoutes: (
        <>
          <Route path="/single" element={<div data-testid="lobby" />} />
          <Route path="/" element={<div data-testid="home" />} />
        </>
      ),
    }
  );
}

async function waitForReadyInput() {
  const input = await screen.findByPlaceholderText('输入选手昵称...');
  await waitFor(() => expect(input).not.toBeDisabled());
  return input;
}

describe('SingleGame UX', () => {
  beforeEach(() => {
    post.mockReset();
    localStorage.clear();
    installViewportMocks(false);
  });

  it('redirects invalid difficulty URLs without writing localStorage', async () => {
    renderGame('hard');
    expect(await screen.findByTestId('lobby')).toBeInTheDocument();
    expect(localStorage.getItem('csgofriberg.single-difficulty')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('shows starting feedback and keeps dock input disabled while start is pending', async () => {
    const start = deferred<{ data: { gameId: string; guesses: []; maxGuesses: number } }>();
    post.mockReturnValueOnce(start.promise as never);

    renderGame('easy');

    expect(await screen.findByText('正在开始新对局…', { selector: 'p' })).toBeInTheDocument();
    expect(document.querySelector('.spinner')).toBeTruthy();
    expect(screen.getByPlaceholderText('输入选手昵称...')).toBeDisabled();
    expect(document.querySelector('.guess-input-feedback')).toBeNull();

    start.resolve({ data: { gameId: 'g1', guesses: [], maxGuesses: 8 } });
    await waitForReadyInput();
    expect(screen.getByText('在下方输入选手昵称开始猜测')).toBeInTheDocument();
    expect(localStorage.getItem('csgofriberg.single-difficulty')).toBe('easy');
  });

  it('shows start failure recovery actions when network fails', async () => {
    post.mockRejectedValueOnce(new Error('offline'));

    renderGame('easy');

    expect(await screen.findByText('开局失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回难度选择' })).toBeInTheDocument();
  });

  it('disables dock and shows starting copy while restart is in flight', async () => {
    post.mockResolvedValueOnce({ data: { gameId: 'g1', guesses: [], maxGuesses: 8 } } as never);
    renderGame('easy');
    await waitForReadyInput();

    const restart = deferred<unknown>();
    post
      .mockReturnValueOnce(restart.promise as never)
      .mockReturnValueOnce(restart.promise as never);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '重新开始' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '重新开始' }));

    expect(await screen.findByText('正在开始新对局…', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('输入选手昵称...')).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新开始' })).toBeDisabled();
  });

  it('marks page keyboard-active on focus for mobile chrome collapse CSS', async () => {
    installViewportMocks(true);
    post.mockResolvedValueOnce({ data: { gameId: 'g1', guesses: [], maxGuesses: 8 } } as never);
    renderGame('easy');

    const input = await waitForReadyInput();
    await userEvent.click(input);
    expect(document.querySelector('.single-game-page')).toHaveClass('keyboard-active');
    expect(window.matchMedia('(max-width: 640px)').matches).toBe(true);
  });

  it('shows reveal busy state on the action button and top status bar', async () => {
    post.mockResolvedValueOnce({ data: { gameId: 'g1', guesses: [], maxGuesses: 8 } } as never);
    renderGame('easy');
    await waitForReadyInput();

    const giveup = deferred<{ data: { answer: { nickname: string; team: string; nationality: string } } }>();
    post.mockReturnValueOnce(giveup.promise as never);

    const user = userEvent.setup();
    const revealButton = screen.getByRole('button', { name: '查看答案' });
    await user.click(revealButton);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '查看答案' }));

    await waitFor(() => {
      expect(revealButton).toBeDisabled();
      expect(revealButton).toHaveTextContent('处理中');
    });
    expect(document.querySelector('.status-bar')).toHaveTextContent('处理中');
    expect(screen.getByPlaceholderText('输入选手昵称...')).toBeDisabled();

    giveup.resolve({
      data: {
        answer: { nickname: 'friberg', team: 'NIP', nationality: '瑞典' },
      },
    });
    expect(await screen.findByRole('dialog')).toHaveTextContent('friberg');
  });

  it('keeps an unrecorded settlement warning visible in the answer dialog', async () => {
    post
      .mockResolvedValueOnce({ data: { gameId: 'g1', guesses: [], maxGuesses: 8 } } as never)
      .mockResolvedValueOnce({
        data: {
          status: 'lost',
          recorded: false,
          answer: { nickname: 'friberg', team: 'NIP', nationality: '瑞典' },
        },
      } as never);
    renderGame('easy');
    await waitForReadyInput();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '查看答案' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '查看答案' }));

    const result = await screen.findByRole('dialog');
    expect(result).toHaveTextContent('friberg');
    expect(result).toHaveTextContent('结算频率超过限制，本局不会计入个人战绩和排行榜。');
  });

  it('shows leaving busy state before navigating home', async () => {
    post.mockResolvedValueOnce({ data: { gameId: 'g1', guesses: [], maxGuesses: 8 } } as never);
    renderGame('easy');
    await waitForReadyInput();

    const exit = deferred<unknown>();
    post.mockReturnValueOnce(exit.promise as never);

    const user = userEvent.setup();
    const homeButton = screen.getByRole('button', { name: '主菜单' });
    await user.click(homeButton);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '返回主菜单' }));

    await waitFor(() => {
      expect(homeButton).toBeDisabled();
      expect(homeButton).toHaveTextContent('退出中');
    });
    expect(document.querySelector('.status-bar')).toHaveTextContent('退出中');

    exit.resolve({});
    expect(await screen.findByTestId('home')).toBeInTheDocument();
  });
});
