import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { api, errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { ensureGuestSession } from '../api/session';
import { mergeSoup, type SoupGame, type SoupOptions, type SoupResponse } from '../turtleSoup';

type Pending = { gameId: string; action: 'question' | 'guess' | 'giveup'; body: Record<string, unknown> };
type Session = { gameId?: string; pending?: Pending };
const uncertain = (err: unknown) => !axios.isAxiosError(err) || !err.response || err.response.status >= 500;
const missing = (err: unknown) => axios.isAxiosError(err) && err.response?.status === 404;

// One operation owns its UUID, version and payload until the server confirms it.
// Never recreate an operation from the current form when retrying.
export function useTurtleSoup(mode: string) {
  const identity = useAuth((s) => s.user?.id ?? 'guest');
  const key = `csgofriberg_soup_session_${identity}_${mode}`;
  const [game, setGame] = useState<SoupGame | null>(null);
  const [options, setOptions] = useState<SoupOptions | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const session = useRef<Session>({});
  const inFlight = useRef(false);
  const epoch = useRef(0);
  const currentGame = useRef<SoupGame | null>(null);
  const choicesFor = useRef<string | null>(null);

  const save = useCallback((next: Session) => {
    session.current = next;
    setPending(next.pending ?? null);
    try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* In-memory retries still work. */ }
  }, [key]);

  const accept = useCallback((next: SoupGame, keepPending = false) => {
    currentGame.current = next;
    setGame(next);
    setExpired(false);
    save({ gameId: next.gameId, pending: keepPending ? session.current.pending : undefined });
  }, [save]);

  const fail = useCallback((err: unknown) => {
    setError(errMsg(err));
    if (missing(err)) {
      setExpired(true);
      setOptions(null);
      save({});
    }
  }, [save]);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    const generation = epoch.current;
    const alive = () => epoch.current === generation && (useAuth.getState().user?.id ?? 'guest') === identity;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (identity === 'guest') await ensureGuestSession();
      if (!alive()) return;
      const stored = session.current;
      // Read known games first, including terminal receipts. GET does not extend expiry.
      let next = stored.gameId
        ? (await api.get<SoupGame>(`/game/${stored.gameId}/state`)).data
        : (await api.post<SoupGame>('/game/start', { mode, variant: 'turtle-soup' })).data;
      if (!alive()) return;
      if (stored.pending) {
        if (!next.events.some((event) => event.requestId === stored.pending!.body.requestId)) {
          try {
            const res = await api.post<SoupResponse>(`/game/${stored.pending.gameId}/${stored.pending.action}`, stored.pending.body);
            next = mergeSoup(next, res.data) ?? (await api.get<SoupGame>(`/game/${stored.gameId}/state`)).data;
          } catch (err) {
            if (!alive()) return;
            if (uncertain(err)) { accept(next, true); throw err; }
            save({ gameId: stored.gameId });
            // Stale operations are discarded, never replayed at a newer version.
            next = (await api.get<SoupGame>(`/game/${stored.gameId}/state`)).data;
            if (alive()) setError(errMsg(err));
          }
        }
      }
      if (!alive()) return;
      accept(next);
      if (next.status === 'playing' && choicesFor.current !== next.gameId) {
        const res = await api.get<SoupOptions>(`/game/${next.gameId}/question-options`);
        if (!alive()) return;
        choicesFor.current = next.gameId;
        setOptions(res.data);
      }
    } catch (err) { if (alive()) fail(err); }
    finally { if (alive()) { inFlight.current = false; setBusy(false); } }
  }, [accept, fail, identity, mode, save]);

  useEffect(() => {
    epoch.current++;
    inFlight.current = false;
    currentGame.current = null;
    choicesFor.current = null;
    setGame(null); setOptions(null); setExpired(false);
    try { session.current = JSON.parse(sessionStorage.getItem(key) || '{}'); }
    catch { session.current = {}; }
    setPending(session.current.pending ?? null);
    void load();
    return () => { epoch.current++; };
  }, [key, load]);

  const submit = async (action: Pending['action'], body: Record<string, unknown>): Promise<boolean> => {
    const current = currentGame.current;
    if (!current || current.status !== 'playing' || inFlight.current || session.current.pending || expired || error) return false;
    const generation = epoch.current;
    const alive = () => epoch.current === generation && (useAuth.getState().user?.id ?? 'guest') === identity;
    inFlight.current = true;
    setBusy(true);
    const operation: Pending = { gameId: current.gameId, action, body: { ...body, requestId: crypto.randomUUID(), version: current.version } };
    save({ gameId: current.gameId, pending: operation });
    try {
      const res = await api.post<SoupResponse>(`/game/${current.gameId}/${action}`, operation.body);
      if (!alive()) return false;
      // A delta that does not follow the held version (another tab or device
      // moved the game on) is replaced by the authoritative state.
      const next = mergeSoup(current, res.data) ?? (await api.get<SoupGame>(`/game/${current.gameId}/state`)).data;
      if (!alive()) return false;
      accept(next);
      setError(null);
      return true;
    } catch (err) {
      if (!alive()) return false;
      if (!uncertain(err)) {
        save({ gameId: current.gameId });
        try {
          const res = await api.get<SoupGame>(`/game/${current.gameId}/state`);
          if (alive()) accept(res.data);
        } catch (syncError) { if (alive()) fail(syncError); return false; }
      }
      if (alive()) fail(err);
      return false;
    } finally { if (alive()) { inFlight.current = false; setBusy(false); } }
  };

  const exit = async () => {
    if (inFlight.current || session.current.pending) return false;
    inFlight.current = true;
    setBusy(true);
    const generation = epoch.current;
    try {
      if (session.current.gameId) await api.post(`/game/${session.current.gameId}/exit`, {});
      if (generation !== epoch.current) return false;
      save({}); setGame(null); currentGame.current = null;
      setOptions(null); choicesFor.current = null; setExpired(false); setError(null);
      return true;
    } catch (err) { if (generation === epoch.current) fail(err); return false; }
    finally { if (generation === epoch.current) { inFlight.current = false; setBusy(false); } }
  };

  return { game, options, busy, error, expired, pending, load, submit, exit };
}
