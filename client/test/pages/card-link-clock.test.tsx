import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../render';
import MatchClock from '../../src/card-link/MatchClock';
import type { View } from '../../src/card-link/types';

afterEach(() => vi.useRealTimers());
describe('card clock separates gameplay time from room expiry', () => {
  it.each(['practice', 'daily'])('shows elapsed time for untimed %s even with a room cutoff', async scene => {
    vi.useFakeTimers();
    const now = Date.now();
    const view = { scene, status: 'playing', dueAt: now + 1800000, expiresAt: now + 1800000,
      current: { startedAt: now - 60000, deadline: null } } as View;
    renderWithProviders(<MatchClock view={view} />);
    expect(screen.getByText('不限时 · 60 秒')).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText('不限时 · 62 秒')).toBeInTheDocument();
  });
  it.each(['playing', 'roundOver', 'finished'])('freezes a locked seat in %s and after remount', async status => {
    vi.useFakeTimers();
    const view = { id: 'game', round: 0, status, current: { startedAt: 1000, stoppedAt: 12500, deadline: null, locked: true } } as View;
    const mounted = renderWithProviders(<MatchClock view={view} />);
    expect(screen.getByText('本轮用时 · 11.5 秒')).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(screen.getByText('本轮用时 · 11.5 秒')).toBeInTheDocument();
    mounted.unmount(); renderWithProviders(<MatchClock view={view} />);
    expect(screen.getByText('本轮用时 · 11.5 秒')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses a stable recorded score for old rounds and starts ticking for the next round', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const view = { id: 'game', round: 0, status: 'finished', current: { startedAt: 1000, locked: true, deadline: null, best: { elapsed: 12500 } } } as View;
    const mounted = renderWithProviders(<MatchClock view={view} />);
    expect(screen.getByText('成绩用时 · 12.5 秒')).toBeInTheDocument();
    mounted.rerender(<MatchClock view={{ ...view, round: 1, status: 'playing', current: { ...view.current!, locked: false, best: null, startedAt: 100000 } }} />);
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText('不限时 · 3 秒')).toBeInTheDocument();
  });
});
