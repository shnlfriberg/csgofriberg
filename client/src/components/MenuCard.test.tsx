import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MenuCard from './MenuCard';

describe('MenuCard', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete window.umami;
  });

  it('navigates before sending the analytics event', () => {
    vi.useFakeTimers();
    const track = vi.fn();
    window.umami = { track };

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={(
              <MenuCard
                to="/single"
                icon={<span />}
                label="单人模式"
                description="选择难度"
                color="#74e38f"
                analyticsEvent="home-mode-single"
              />
            )}
          />
          <Route path="/single" element={<p>难度选择</p>} />
        </Routes>
      </MemoryRouter>
    );

    const link = screen.getByRole('link', { name: /单人模式/ });
    expect(link).not.toHaveAttribute('data-umami-event');
    fireEvent.click(link);

    expect(screen.getByText('难度选择')).toBeInTheDocument();
    expect(track).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(track).toHaveBeenCalledWith('home-mode-single', undefined);
  });
});
