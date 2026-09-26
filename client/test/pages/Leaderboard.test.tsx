import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import { useAuth } from '../../src/store/auth';
import Leaderboard from '../../src/pages/Leaderboard';

const apiGet = vi.hoisted(() => vi.fn());

vi.mock('../../src/api/client', () => ({
  api: { get: apiGet },
  errMsg: () => 'request failed',
}));

describe('Leaderboard filters', () => {
  it('uses independent soup rankings and labels questions', async () => {
    apiGet.mockResolvedValueOnce({ data: {
      items: [{ id: 7, displayId: 'Player', total: 2, wins: 1, winRate: 0.5, avgGuesses: 4 }],
      currentUser: { displayId: 'Player', rank: 1 },
    } });
    renderAtRoute(<Leaderboard />, { route: '/leaderboard?mode=turtle-soup', path: '/leaderboard' });
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/leaderboard', {
      params: { mode: 'turtle-soup', difficulty: 'beginner' },
    }));
    expect(await screen.findByRole('columnheader', { name: '平均获胜猜测次数' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '海龟汤' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: '海龟汤' }));
    expect(screen.getByRole('columnheader', { name: '平均获胜猜测次数' })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
  it('retries a failed board without changing the selected variant', async () => {
    apiGet.mockRejectedValueOnce(new Error('offline'));
    renderAtRoute(<Leaderboard />, { route: '/leaderboard?mode=turtle-soup', path: '/leaderboard' });
    await userEvent.click(await screen.findByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(apiGet).toHaveBeenLastCalledWith('/leaderboard', { params: { mode: 'turtle-soup', difficulty: 'beginner' } });
  });
  beforeEach(() => {
    useAuth.setState({
      user: { id: 7, username: 'leaderboard-user', role: 'user' },
      initialized: true,
    });
    apiGet.mockReset();
    apiGet.mockResolvedValue({
      data: {
        mode: 'single',
        difficulty: 'beginner',
        items: [],
        currentUser: { displayId: '用户#ABCDE', rank: 1 },
      },
    });
  });

  it('filters solo and multiplayer rankings with the difficulty dropdown', async () => {
    const user = userEvent.setup();
    renderAtRoute(<Leaderboard />);

    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith('/leaderboard', {
      params: { mode: 'single', difficulty: 'beginner' },
    }));

    await user.selectOptions(screen.getByRole('combobox', { name: '难度' }), 'easy');
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith('/leaderboard', {
      params: { mode: 'single', difficulty: 'easy' },
    }));

    await user.click(screen.getByRole('tab', { name: '多人' }));
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith('/leaderboard', {
      params: { mode: 'multi', difficulty: 'easy' },
    }));
    expect(screen.getByRole('tab', { name: '多人' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the current-user summary mounted while a new ranking loads', async () => {
    const user = userEvent.setup();
    apiGet
      .mockResolvedValueOnce({
        data: {
          mode: 'single',
          difficulty: 'beginner',
          items: [],
          currentUser: { displayId: '用户#ABCDE', rank: 3 },
        },
      })
      .mockImplementationOnce(() => new Promise(() => undefined));

    renderAtRoute(<Leaderboard />);
    const summary = await screen.findByLabelText('我的排名');
    await waitFor(() => expect(summary).toHaveTextContent('#3'));

    await user.click(screen.getByRole('tab', { name: '多人' }));

    expect(screen.getByLabelText('我的排名')).toBe(summary);
    expect(summary).toHaveAttribute('aria-busy', 'true');
    expect(summary).not.toHaveTextContent('#3');
  });
});
