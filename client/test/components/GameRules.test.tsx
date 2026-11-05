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
    expect(screen.getByRole('article', { name: '图寻游戏规则' })).toHaveTextContent('地图错误得 0 分');
    const cards = screen.getByRole('article', { name: '卡牌连接' });
    expect(within(cards).getByText('无限手牌模式')).toBeInTheDocument();
    expect(within(cards).getByText('限定手牌模式')).toBeInTheDocument();
    expect(cards).toHaveTextContent('起手 7 张');
    expect(cards).toHaveTextContent('成功出牌或撤下弃牌各增加 1 次，最多积累 2 次');
    expect(cards).toHaveTextContent('下放、教练、助理教练及管理任期不算');
    expect(cards).toHaveTextContent('不消耗机会、不复活弃牌');
    expect(cards).toHaveTextContent('只取当天最佳成绩上榜');
  });

  it('opens the location rules from the entertainment mode page trigger', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GameRules variant="location" />);

    await user.click(screen.getByRole('button', { name: '图寻游戏规则' }));

    const dialog = screen.getByRole('dialog', { name: '图寻游戏规则' });
    expect(within(dialog).getByText('查看截图，选择地图和楼层，在雷达上标记位置并提交。')).toBeInTheDocument();
    expect(within(dialog).getByText(/每日挑战每天每种难度只能提交一次/)).toBeInTheDocument();
    expect(within(dialog).queryByText('命中历史队伍、赛区相同或数值接近')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('article', { name: '卡牌连接' })).not.toBeInTheDocument();
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
