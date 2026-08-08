import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../../src/i18n';
import { renderWithProviders } from '../render';
import HomeFriendLinks from '../../src/components/HomeFriendLinks';

describe('HomeFriendLinks', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh');
  });

  it('renders code-configured links with only name, href, and description', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HomeFriendLinks links={[{
      name: '示例网站',
      href: 'https://example.com/',
      description: '示例描述',
    }]} />);

    await user.click(screen.getByRole('button', { name: '友情链接' }));
    expect(screen.getByRole('heading', { name: '友情链接' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /示例网站/ })).toHaveAttribute('href', 'https://example.com/');
    expect(screen.getByText('示例描述')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
