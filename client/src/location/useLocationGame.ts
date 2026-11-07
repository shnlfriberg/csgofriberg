import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../components/ConfirmDialog';
import { useAuth } from '../store/auth';
import { api, message } from './api';
import type { AnswerInput, Difficulty, GameView, Guess } from './types';
import type { DailyLeaderboardEntry } from './DailyLeaderboard';

function stored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* The game can still run without browser storage. */
  }
}

export function useLocationGame(mode: 'random' | 'daily') {
  const { t } = useTranslation();
  const { user, initialized } = useAuth();
  const confirm = useConfirm();
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [bannedMapIds, setBannedMapIds] = useState<string[]>([]);
  const [game, setGame] = useState<GameView | null>(null);
  const [review, setReview] = useState<number | null>(null);
  const operation = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [date, setDate] = useState('');
  const [pending, setPending] = useState<AnswerInput | null>(null);
  const generation = useRef(0);
  const [daily, setDaily] = useState<{
    available: boolean;
    difficulties: Array<{ difficulty: Difficulty; status: string }>;
  } | null>(null);
  const [board, setBoard] = useState<DailyLeaderboardEntry[]>([]);
  const key = `tuxun:v2:${user?.id || 'guest'}:${mode}:${difficulty}:${date}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    if (mode !== 'daily' || !initialized) return;
    let alive = true;
    let midnight: ReturnType<typeof setTimeout>;
    const refresh = () =>
      void api
        .get('/location/daily')
        .then((response) => {
          if (!alive) return;
          setDaily(response.data);
          setDate(response.data.date);
          clearTimeout(midnight);
          midnight = setTimeout(
            refresh,
            Math.max(
              100,
              response.data.nextRefreshAt - response.data.serverNow + 50
            )
          );
        })
        .catch((e) => alive && setError(message(e)));
    // Returning to the tab re-reads the daily state at most once a minute
    // (the midnight timer already handles the rollover).
    let lastRefresh = Date.now();
    const visible = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastRefresh < 60_000) return;
      lastRefresh = Date.now();
      refresh();
    };
    refresh();
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive = false;
      clearTimeout(midnight);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [mode, initialized, user?.id]);
  useEffect(() => {
    const current = ++generation.current;
    setGame(null);
    setPending(null);
    setReview(null);
    setError('');
    setBusy(false);
    operation.current = false;
    if (!initialized) return;
    const id = stored(key);
    if (id) {
      setBusy(true);
      void api
        .get<GameView>(`/location/games/${id}`)
        .then((response) => {
          if (current !== generation.current) return;
          setGame(response.data);
          if (mode === 'random') setBannedMapIds(response.data.bannedMapIds ?? []);
          const saved = stored(`${key}:pending`);
          if (saved)
            try {
              setPending(JSON.parse(saved));
            } catch {
              store(`${key}:pending`, null);
            }
        })
        .catch((e) => {
          if (current !== generation.current) return;
          store(key, null);
          setError(message(e));
        })
        .finally(() => current === generation.current && setBusy(false));
    }
    return () => {
      generation.current++;
    };
  }, [initialized, key, mode]);
  useEffect(() => {
    let alive = true;
    if (mode !== 'daily' || !initialized || game?.status !== 'finished') {
      setBoard([]);
      return () => {
        alive = false;
      };
    }
    const resultDate = game.date || date;
    void api
      .get('/location/leaderboard', {
        params: { difficulty, ...(resultDate ? { date: resultDate } : {}) },
      })
      .then((r) => alive && setBoard(r.data.items))
      .catch(() => alive && setBoard([]));
    return () => {
      alive = false;
    };
  }, [mode, initialized, difficulty, game?.status, game?.date, date, user?.id]);
  const accept = (view: GameView) => {
    if (key !== keyRef.current) return;
    setGame(view);
    if (mode === 'random') setBannedMapIds(view.bannedMapIds ?? []);
    store(key, view.id);
  };
  const run = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      if (current === generation.current) {
        operation.current = false;
        setBusy(false);
      }
    }
  };
  const start = () =>
    run(async () => {
      const response = await api.post<GameView>('/location/games', {
        mode,
        difficulty,
        ...(mode === 'random' && bannedMapIds.length ? { bannedMapIds } : {}),
      });
      accept(response.data);
      setReview(null);
    });
  const send = async (input: AnswerInput) => {
    if (!game) return;
    const current = generation.current;
    setPending(input);
    store(`${key}:pending`, JSON.stringify(input));
    await run(async () => {
      try {
        const response = await api.post<GameView>(
          `/location/games/${game.id}/answers`,
          input
        );
        if (current !== generation.current) return;
        accept(response.data);
        setPending(null);
        store(`${key}:pending`, null);
        if (mode === 'random' && response.data.status !== 'finished')
          setReview(response.data.results.length - 1);
      } catch (e) {
        if (current !== generation.current) return;
        const status = (e as any)?.response?.status;
        if (status && status < 500) {
          setPending(null);
          store(`${key}:pending`, null);
          if (status === 409)
            accept(
              (await api.get<GameView>(`/location/games/${game.id}`)).data
            );
        }
        throw e;
      }
    });
  };
  const answer = (guess: Guess) =>
    game &&
    void send({
      ...guess,
      round: game.round,
      version: game.version,
      requestId: crypto.randomUUID(),
    });
  const abandon = async () => {
    if (
      !game ||
      !(await confirm({
        title: t('location.abandon'),
        message: t('location.abandonPrompt'),
        confirmLabel: t('location.abandon'),
        tone: 'warning',
      }))
    )
      return;
    await run(async () => {
      await api.post(`/location/games/${game.id}/abandon`);
      setGame(null);
      setPending(null);
      setReview(null);
      store(key, null);
      store(`${key}:pending`, null);
    });
  };
  const playAgain = () => {
    if (mode !== 'random' || game?.status !== 'finished') return;
    return run(async () => {
      const current = generation.current;
      const response = await api.post<GameView>('/location/games', {
        mode: game.mode,
        difficulty: game.difficulty,
        ...(game.bannedMapIds?.length ? { bannedMapIds: game.bannedMapIds } : {}),
      });
      if (current !== generation.current) return;
      accept(response.data);
      setReview(null);
      setPending(null);
      store(`${key}:pending`, null);
    });
  };
  const submitDaily = async () => {
    if (
      game &&
      (await confirm({
        title: t('location.submitDaily'),
        message: t('location.submitPrompt'),
        confirmLabel: t('location.submitDaily'),
        tone: 'warning',
      }))
    ) {
      await run(async () =>
        accept(
          (await api.post<GameView>(`/location/games/${game.id}/submit`)).data
        )
      );
    }
  };
  // Retrying after an error only re-reads an existing game; it never starts a
  // new one (an error in the lobby used to create a game by accident).
  const synchronize = () =>
    game
      ? run(async () =>
          accept((await api.get<GameView>(`/location/games/${game.id}`)).data)
        )
      : Promise.resolve(setError(''));
  return {
    difficulty,
    setDifficulty,
    bannedMapIds,
    setBannedMapIds,
    game,
    review,
    setReview,
    busy,
    error,
    date,
    pending,
    daily,
    board,
    initialized,
    start,
    send,
    answer,
    abandon,
    playAgain,
    submitDaily,
    synchronize,
  };
}
