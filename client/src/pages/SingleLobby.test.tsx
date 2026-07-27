import { describe, expect, it, beforeEach } from 'vitest';
import { Route } from 'react-router-dom';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SingleLobby from './SingleLobby';
import { renderAtRoute } from '../test/render';

describe('SingleLobby', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to recommended beginner with distinct card copy', () => {
    renderAtRoute(<SingleLobby />, { route: '/single', path: '/single' });

    const beginner = screen.getByRole('button', { name: /入门版/ });
    const easy = screen.getByRole('button', { name: /简单版/ });
    const normal = screen.getByRole('button', { name: /完整版/ });

    expect(beginner).toHaveClass('active');
    expect(beginner.querySelector('.single-difficulty-badge')).toHaveTextContent('推荐');
    expect(easy.querySelector('.single-difficulty-badge')).toBeNull();
    expect(normal.querySelector('.single-difficulty-badge')).toBeNull();
    expect(beginner).toHaveTextContent('最大众选手池 · 熟悉规则');
    expect(easy).toHaveTextContent('知名选手池 · 快速上手');
    expect(normal).toHaveTextContent('完整数据库 · 终极挑战');
    expect(beginner.style.getPropertyValue('--diff-color')).toBe('var(--primary)');
    expect(easy.style.getPropertyValue('--diff-color')).toBe('var(--success)');
    expect(normal.style.getPropertyValue('--diff-color')).toBe('var(--accent)');
    expect(screen.getByText('选择一个难度开始游戏。你的选择会保存在本地浏览器中。')).toBeInTheDocument();
  });

  it('starts the selected difficulty and remembers the choice', async () => {
    const user = userEvent.setup();
    renderAtRoute(
      <SingleLobby />,
      {
        route: '/single',
        path: '/single',
        extraRoutes: (
          <Route path="/single/:mode" element={<div data-testid="game-route" />} />
        ),
      }
    );

    await user.click(screen.getByRole('button', { name: /完整版/ }));
    expect(screen.getByRole('button', { name: /完整版/ })).toHaveClass('active');
    await user.click(screen.getByRole('button', { name: /开始游戏/ }));

    expect(await screen.findByTestId('game-route')).toBeInTheDocument();
    expect(localStorage.getItem('csgofriberg.single-difficulty')).toBe('normal');
  });

  it('mobile start button remains a full-width primary action class', () => {
    renderAtRoute(<SingleLobby />, { route: '/single', path: '/single' });
    const start = screen.getByRole('button', { name: /开始游戏/ });
    expect(start).toHaveClass('btn', 'btn-lg', 'btn-green');
  });
});
