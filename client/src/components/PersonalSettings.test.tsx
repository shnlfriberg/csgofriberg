import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/render';
import PersonalSettings from './PersonalSettings';

describe('PersonalSettings', () => {
  it('stores and immediately applies the animation preference', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PersonalSettings />);

    await user.click(screen.getByRole('button', { name: '个人设置' }));
    const motion = screen.getByRole('switch', { name: '动画效果' });
    expect(motion).toBeChecked();

    await user.click(motion);
    expect(motion).not.toBeChecked();
    expect(localStorage.getItem('ui-motion')).toBe('off');
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduced');

    await user.click(motion);
    expect(localStorage.getItem('ui-motion')).toBe('on');
    expect(document.documentElement).not.toHaveAttribute('data-motion');
  });
});
