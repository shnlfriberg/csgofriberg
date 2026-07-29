import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../test/render';
import Stats from './Stats';

const apiGet = vi.hoisted(() => vi.fn());

vi.mock('../api/client', () => ({
  api: { get: apiGet },
  errMsg: () => 'request failed',
}));

function statsSummary(difficulties: string[]) {
  const includesBeginner = difficulties.includes('beginner');
  return {
    difficulties,
    personal: {
      totalGames: includesBeginner ? 6 : 5,
      wins: 1,
      winRate: includesBeginner ? 1 / 6 : 0.2,
      avgGuesses: 2,
      bestGuesses: 1,
      firstGuess: null,
      multiGames: includesBeginner ? 4 : 3,
      multiWins: 2,
      multiAvgWinningGuesses: 1.5,
    },
    global: {
      totalGames: includesBeginner ? 60 : 50,
      wins: 10,
      winRate: includesBeginner ? 1 / 6 : 0.2,
      avgGuesses: 3,
      bestGuesses: 1,
      firstGuess: null,
      multiGames: includesBeginner ? 40 : 35,
      multiAvgWinningGuesses: 2.25,
      registeredUsers: 12,
    },
  };
}

describe('Stats difficulty filter', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockImplementation((url: string, config?: { params?: { difficulties?: string } }) => {
      if (url === '/stats/me') {
        const difficulties = config?.params?.difficulties?.split(',') ?? [];
        return Promise.resolve({
          data: statsSummary(difficulties),
        });
      }
      if (url === '/stats/replays') {
        return Promise.resolve({
          data: { type: 'single', page: 1, pageSize: 15, hasNext: false, items: [] },
        });
      }
      return Promise.reject(new Error(`unexpected request: ${url}`));
    });
  });

  it('merges selected difficulties into one personal and global summary', async () => {
    const user = userEvent.setup();
    renderAtRoute(<Stats />);

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/stats/me', {
      params: { difficulties: 'beginner,easy,normal' },
    }));
    expect(await screen.findByText('全部分级', { selector: '.difficulty-multi-select-summary' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: '个人统计', level: 3 })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: '全站统计', level: 3 })).toHaveLength(1);
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText('60')).toBeInTheDocument();
    const personalCard = screen.getByRole('heading', { name: '个人统计', level: 3 }).closest('.card') as HTMLElement;
    const globalCard = screen.getByRole('heading', { name: '全站统计', level: 3 }).closest('.card') as HTMLElement;
    expect(within(personalCard).getByText('多人胜场平均猜测次数')).toBeInTheDocument();
    expect(within(personalCard).getByText('1.50')).toBeInTheDocument();
    expect(within(globalCard).getByText('多人胜场平均猜测次数')).toBeInTheDocument();
    expect(within(globalCard).getByText('2.25')).toBeInTheDocument();

    await user.click(screen.getByText('全部分级', { selector: '.difficulty-multi-select-summary' }));
    const difficultyGroup = screen.getByRole('group', { name: '统计难度' });
    await user.click(within(difficultyGroup).getByRole('checkbox', { name: '入门版' }));

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/stats/me', {
      params: { difficulties: 'easy,normal' },
    }));
    expect(screen.getByText('简单版, 完整版', { selector: '.difficulty-multi-select-summary' })).toBeInTheDocument();
    expect(await screen.findByText('5')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(apiGet.mock.calls.filter(([url]) => url === '/stats/me')).toHaveLength(2);

    await user.click(within(difficultyGroup).getByRole('checkbox', { name: '全部分级' }));
    await waitFor(() => expect(apiGet.mock.calls.filter(([url]) => url === '/stats/me')).toHaveLength(3));
    expect(apiGet).toHaveBeenLastCalledWith('/stats/me', {
      params: { difficulties: 'beginner,easy,normal' },
    });
  });
});
