import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../../src/i18n';
import { renderWithProviders } from '../render';
import GameRules from '../../src/components/GameRules';

describe('GameRules', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh');
  });

  it('explains historical-team yellow feedback and current-team priority', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GameRules />);

    await user.click(screen.getByRole('button', { name: '游戏规则' }));

    expect(screen.getByText('命中历史队伍、赛区相同或数值接近')).toBeInTheDocument();
    expect(screen.getByText(/当前队伍相同显示绿色/)).toHaveTextContent('当前队伍判定优先');
    const soup = screen.getByRole('article', { name: '弗一把海龟汤' });
    expect(within(soup).getByText(/每局共 24 次猜测机会/)).toHaveTextContent('可以直接或连续猜选手');
    expect(soup).toHaveTextContent('↑ 表示目标数值更大，↓ 表示目标数值更小');
  });

  it('opens only soup rules from the soup trigger and restores focus on Escape', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GameRules variant="turtle-soup" />);
    const trigger = screen.getByRole('button', { name: '玩法规则' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '玩法规则' });
    expect(dialog).toHaveClass('soup-rules-dialog');
    expect(within(dialog).getByText('24 次猜测机会')).toBeInTheDocument();
    expect(within(dialog).queryByText('命中历史队伍、赛区相同或数值接近')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
