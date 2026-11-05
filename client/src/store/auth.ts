import { create } from 'zustand';
import { UserInfo } from '../types';

interface AuthState {
  user: UserInfo | null;
  initialized: boolean;
  setUser: (user: UserInfo | null) => void;
  setInitialized: () => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  initialized: false,
  setUser: (user) => {
    // Identity restoration on initial load keeps recoverable operations; an actual
    // account change invalidates the old session's unconfirmed writes.
    if (get().initialized && get().user?.id !== user?.id) {
      try {
        for (let i = sessionStorage.length - 1; i >= 0; i--) {
          const key = sessionStorage.key(i);
          if ((key?.startsWith('csgofriberg_soup_session_') || key?.startsWith('card-pending:'))) sessionStorage.removeItem(key);
        }
      } catch { /* Storage may be disabled. */ }
    }
    set({ user });
  },
  setInitialized: () => set({ initialized: true }),
}));
