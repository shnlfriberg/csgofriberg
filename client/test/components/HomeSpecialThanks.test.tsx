import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../../src/i18n';
import { SPECIAL_THANKS } from '../../src/config/specialThanks';
import { renderWithProviders } from '../render';
import HomeSpecialThanks from '../../src/components/HomeSpecialThanks';

describe('HomeSpecialThanks', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh');
  });

  it('renders the special thanks configured in client code', async () => {
    const user = userEvent.setup();

    renderWithProviders(<HomeSpecialThanks />);

    await user.click(screen.getByRole('button', { name: '特别感谢' }));
    expect(screen.getByRole('heading', { name: '特别感谢' })).toBeInTheDocument();
    expect(screen.getByText('玩机器丶Machine')).toBeInTheDocument();
    expect(screen.getByText('对网站的冠名赞助')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '玩机器丶Machine' })).toHaveAttribute('src', SPECIAL_THANKS[0].image);
    expect(screen.getByRole('link', { name: /玩机器丶Machine/ })).toHaveAttribute('href', 'https://www.douyu.com/6979222');
    expect(screen.getByText('OuseTonae | AS202355 Ciallo Networks LTD')).toBeInTheDocument();
    expect(screen.getByText('提供了网站的服务器')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'OuseTonae | AS202355 Ciallo Networks LTD' })).toHaveAttribute('src', SPECIAL_THANKS[1].image);
    expect(screen.getByRole('link', { name: /OuseTonae \| AS202355 Ciallo Networks LTD/ })).toHaveAttribute('href', 'https://ciallo.ee/');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
