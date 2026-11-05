import { acceptState, acceptPatch, type Patch } from "./state";
import { useAuth } from "../store/auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Command } from "@friberg/card-link-core";
import { api, errMsg } from "../api/client";
import { getSocket } from "../api/socket";
import { ensurePow } from '../api/pow';
import { refreshAuthenticatedSession } from '../api/authSession';
import type { Directory, View } from "./types";
type Pending = {
  requestId: string;
  revision: number;
  phaseRevision: number;
  command: Command;
};
export function useCardGame(id: string | null) {
  const [view, setView] = useState<View | null>(null),
    [directory, setDirectory] = useState<Directory>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Pending | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [realtimeReady, setRealtimeReady] = useState(false);
  const retrySubscription = useRef<() => void>(() => {});
  const identity = useAuth((s) => s.user?.id ?? null);
  const context = `${identity}:${id}`,
    storageKey = `card-pending:${context}`;
  const contextToken = useMemo(() => ({ context }), [context]);
  const activeContext = useRef(contextToken);
  activeContext.current = contextToken;
  const latest = useRef<View | null>(null);
  const active = useRef(id),
    inFlight = useRef<typeof contextToken | null>(null);
  active.current = id;
  const apply = useCallback(
    (next: View) => {
      if (next.id !== active.current || activeContext.current !== contextToken)
        return;
      const accepted = acceptState(latest.current, next);
      latest.current = accepted;
      setView(accepted);
    },
    [contextToken],
  );
  const reload = useCallback(async () => {
    if (!id) return;
    const response = await api.get<View>(`/card-link/matches/${id}`);
    apply(response.data);
  }, [id, apply]);
  useEffect(() => {
    latest.current = null;
    setView(null);
    setDirectory([]);
    setError("");
    setPending(null);
    setBusy(false);
    setConnectionError('');
    setRealtimeReady(false);
    if (!id) return;
    let alive = true;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) setPending(JSON.parse(raw));
    } catch {
      /* Memory fallback. */
    }
    void reload().catch((e) => {
      if (alive) setError(errMsg(e));
    });
    void api
      .get(`/card-link/matches/${id}/directory`)
      .then((r) => {
        if (alive) setDirectory(r.data.players);
      })
      .catch((e) => {
        if (alive) setError(errMsg(e));
      });
    const socket = getSocket();
    let sequence = 0, attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const current = () => alive && activeContext.current === contextToken;
    const watch = () => {
      const request = ++sequence;
      clearTimeout(retryTimer);
      setRealtimeReady(false);
      void (async () => {
        await ensurePow();
        if (!current() || request !== sequence) return;
        const response = await new Promise<{ ok: boolean; data?: View; code?: string }>((resolve, reject) => {
          socket.timeout(10000).emit('card-link:watch', { id },
            (error: unknown, result: { ok: boolean; data?: View; code?: string }) => error ? reject(error) : resolve(result));
        });
        if (!current() || request !== sequence) return;
        if (response?.ok && response.data) {
          apply(response.data);
          attempts = 0;
          setConnectionError('');
          setRealtimeReady(true);
          return;
        }
        throw { isAxiosError: true, response: { data: { code: response?.code || 'NETWORK_ERROR' } } };
      })().catch(async error => {
        if (!current() || request !== sequence) return;
        setConnectionError(errMsg(error));
        attempts++;
        if (attempts > 3) return;
        const code = error?.response?.data?.code;
        try {
          if (code === 'POW_REQUIRED') await ensurePow(true);
          else if (code === 'AUTH_EXPIRED') await refreshAuthenticatedSession();
          if (!current() || request !== sequence) return;
          if (code === 'POW_REQUIRED' || code === 'AUTH_EXPIRED') {
            socket.disconnect().connect();
          } else retryTimer = setTimeout(watch, 1000 * attempts);
        } catch {
          if (current() && request === sequence) retryTimer = setTimeout(watch, 1000 * attempts);
        }
      });
    };
    const disconnected = () => {
      sequence++;
      clearTimeout(retryTimer);
      setRealtimeReady(false);
    };
    retrySubscription.current = () => { attempts = 0; watch(); };
    const state = (v: View) => {
      if (alive) apply(v);
    };
    const patch = (p: Patch) => {
      if (!alive || p.id !== id) return;
      const result = acceptPatch(latest.current, p);
      latest.current = result.view;
      setView(result.view);
      if (result.reload) void reload().catch(() => undefined);
    };
    socket.on("connect", watch);
    socket.on('disconnect', disconnected);
    socket.on("card-link:state", state);
    socket.on("card-link:patch", patch);
    if (socket.connected) watch();
    return () => {
      alive = false;
      sequence++;
      clearTimeout(retryTimer);
      retrySubscription.current = () => {};
      socket.emit("card-link:unwatch");
      socket.off("connect", watch);
      socket.off('disconnect', disconnected);
      socket.off("card-link:state", state);
      socket.off("card-link:patch", patch);
    };
  }, [id, identity, storageKey, reload, apply]);
  const send = async (command?: Command) => {
    if (!id || !view || inFlight.current === contextToken) return;
    const input =
      pending ??
      (command
        ? {
            requestId: crypto.randomUUID(),
            revision: view.revision,
            phaseRevision: view.phaseRevision,
            command,
          }
        : null);
    if (!input) return;
    inFlight.current = contextToken;
    setBusy(true);
    setPending(input);
    setError("");
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(input));
    } catch {}
    const clear = () => {
      if (activeContext.current !== contextToken) return;
      setPending(null);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
    };
    try {
      const r = await api.post<View>(
        `/card-link/matches/${id}/commands`,
        input,
      );
      apply(r.data);
      clear();
    } catch (e) {
      if (activeContext.current !== contextToken) return;
      setError(errMsg(e));
      const status = (e as { response?: { status: number } }).response?.status;
      if (status && status < 500) {
        clear();
        await reload().catch(() => undefined);
        if (activeContext.current === contextToken &&
            ((latest.current?.current?.refreshes ?? 0) > (view.current?.refreshes ?? 0) ||
            (!view.current?.exhausted && latest.current?.current?.exhausted))) setError('');
      }
    } finally {
      if (inFlight.current === contextToken) inFlight.current = null;
      if (activeContext.current === contextToken) setBusy(false);
    }
  };
  return { view, directory, error, connectionError, realtimeReady,
    retryConnection: () => retrySubscription.current(), busy, pending, send, reload, setError };
}
