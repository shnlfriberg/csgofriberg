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
