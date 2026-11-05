import { useState } from 'react';
import { useAuth } from '../../store/auth';

// Per-tab, per-account navigation only. Never persist credentials or review payloads.
export function useAdminTab<T extends string>(section: string, tabs: readonly T[], fallback: T) {
  const userId = useAuth(state => state.user?.id);
  const key = `admin-tab:${userId ?? 'local'}:${section}`;
  const [tab, update] = useState<T>(() => {
    try {
      const saved = sessionStorage.getItem(key) as T;
      if (tabs.includes(saved)) return saved;
    } catch { /* Restricted storage must not block administration. */ }
    return fallback;
  });
  const setTab = (next: T) => {
    if (!tabs.includes(next)) return;
    try { sessionStorage.setItem(key, next); } catch { /* Keep in-memory navigation. */ }
    update(next);
  };
  return [tab, setTab] as const;
}
