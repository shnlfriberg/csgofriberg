import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';

/** null = request failed (shown as unavailable), undefined = still loading. */
export interface AdminCounts {
  reports?: number | null;
  changes?: number | null;
  submissions?: number | null;
  /** The review endpoint pages by 50; 50 means "50 or more". */
  careers?: number | null;
  users?: number | null;
  players?: number | null;
  loadedAt?: number;
}

const REFRESH_MS = 120_000;

type Fetcher = () => Promise<number>;
const fetchers: Record<Exclude<keyof AdminCounts, 'loadedAt'>, Fetcher> = {
  reports: async () => Number((await api.get('/admin/reports', { params: { status: 'pending', reporterFilter: 'all', page: 1, pageSize: 10 } })).data?.total ?? 0),
  changes: async () => Number((await api.get('/admin/player-change-submissions', { params: { status: 'pending', page: 1, pageSize: 10 } })).data?.total ?? 0),
  submissions: async () => Number((await api.get('/admin/location/submissions', { params: { page: 1 } })).data?.total ?? 0),
  careers: async () => {
    const data = (await api.get('/admin/card-link/reviews', { params: { page: 0 } })).data;
    return Array.isArray(data) ? data.length : 0;
  },
  users: async () => Number((await api.get('/admin/users', { params: { page: 1, pageSize: 10 } })).data?.total ?? 0),
  players: async () => Number((await api.get('/admin/players', { params: { page: 1, pageSize: 10 } })).data?.total ?? 0),
};

/**
 * Lightweight totals for the sidebar badges and the dashboard. Reads existing list endpoints with
 * the smallest page size; refreshes on demand and every two minutes while the tab is visible.
 */
export function useAdminCounts() {
  const [counts, setCounts] = useState<AdminCounts>({});
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const keys = Object.keys(fetchers) as Array<keyof typeof fetchers>;
      const settled = await Promise.allSettled(keys.map((key) => fetchers[key]()));
      if (!alive.current) return;
      const next: AdminCounts = { loadedAt: Date.now() };
      keys.forEach((key, index) => {
        const result = settled[index];
        next[key] = result.status === 'fulfilled' && Number.isFinite(result.value) ? result.value : null;
      });
      setCounts(next);
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, REFRESH_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { counts, loading, refresh };
}
