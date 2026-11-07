import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../components/ConfirmDialog';
import { useAuth } from '../store/auth';
import { api, message } from './api';
import type { AnswerInput, Difficulty, GameView, Guess } from './types';
import type { DailyLeaderboardEntry } from './DailyLeaderboard';
import type { LocationSoloView } from '@friberg/location-core';
import { MapsUnknownError, receiveAnswer, receiveGame, soloRequest, type SoloResponse } from './soloProtocol';

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
type ViewResponse = { data: GameView | LocationSoloView };
/** A full view in protocol v2; resent once with maps if they were unknown. */
async function viewRequest(gameId: string | null, request: (config: ReturnType<typeof soloRequest>) => Promise<ViewResponse>): Promise<GameView> {
  try {
    return receiveGame((await request(soloRequest(gameId))).data);
  } catch (error) {
    if (!(error instanceof MapsUnknownError)) throw error;
    return receiveGame((await request(soloRequest(gameId, true))).data);
  }
}
/**
 * 单人 runs on the shared single-player API like classic games: `POST
 * /game/start` creates or resumes the identity's game for the difficulty (any
 * device or tab) and the game is played through `/game/:id/...`. Daily keeps
 * its own endpoints and full views.
 */
const endpoints = {
  random: {
    start: (difficulty: Difficulty, bannedMapIds: string[] = []) => viewRequest(null, (config) => api.post('/game/start', {
      variant: 'location',
      mode: difficulty,
      ...(bannedMapIds.length ? { bannedMapIds } : {}),
    }, config)),
    read: (id: string) => viewRequest(id, (config) => api.get(`/game/${id}/state`, config)),
    answer: (id: string, input: AnswerInput) => api.post<SoloResponse>(`/game/${id}/guess`, input, soloRequest(id)),
    abandon: (id: string) => api.post(`/game/${id}/exit`),
  },
  daily: {
    start: async (difficulty: Difficulty) => (await api.post<GameView>('/location/games', { mode: 'daily', difficulty })).data,
    read: async (id: string) => (await api.get<GameView>(`/location/games/${id}`)).data,
    answer: (id: string, input: AnswerInput) => api.post<SoloResponse>(`/location/games/${id}/answers`, input),
    abandon: (id: string) => api.post(`/location/games/${id}/abandon`),
  },
};
const gone = (error: unknown) => [404, 410].includes((error as { response?: { status?: number } })?.response?.status ?? 0);

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
  // The first read of the current game: the page shows loading, not the lobby.
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');
  const [date, setDate] = useState('');
  const [pending, setPending] = useState<AnswerInput | null>(null);
  const generation = useRef(0);
  const [daily, setDaily] = useState<{
    available: boolean;
    difficulties: Array<{ difficulty: Difficulty; status: string }>;
  } | null>(null);
  const [board, setBoard] = useState<DailyLeaderboardEntry[]>([]);
  const apiFor = endpoints[mode];
  // 单人: the server resumes the game on start, so this tab only remembers the
  // game it showed (to show it, finished or not, again after a refresh). Daily
  // keeps one entry per difficulty and day.
  const key = mode === 'random'
    ? `tuxun:v3:${user?.id || 'guest'}:random`
    : `tuxun:v2:${user?.id || 'guest'}:${mode}:${difficulty}:${date}`;
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
    setRestoring(false);
    operation.current = false;
    if (!initialized) return;
    const alive = () => current === generation.current;
    // A saved answer is only retried on the exact version it was made for.
    const restorePending = (view: GameView) => {
      const saved = stored(`${key}:pending`);
      if (!saved) return;
      try {
        const input = JSON.parse(saved) as AnswerInput;
        if (view.status === 'playing' && input.version === view.version && input.round === view.round) {
          setPending(input);
          return;
        }
      } catch {
        /* Malformed entries are dropped below. */
      }
      store(`${key}:pending`, null);
    };
    const id = stored(key);
    if (id) {
      setBusy(true);
      setRestoring(true);
      void apiFor.read(id)
        .then((view) => {
          if (!alive()) return;
          accept(view);
          restorePending(view);
        })
        .catch((e) => {
          if (!alive()) return;
          store(key, null);
          // An expired 单人 game simply opens the lobby: starting resumes or
          // creates the current game on the server.
          if (!(mode === 'random' && gone(e))) setError(message(e));
        })
        .finally(() => {
          if (!alive()) return;
          setBusy(false);
          setRestoring(false);
        });
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
    if (mode === 'random') {
      // A game resumed from another device brings its settings back to the lobby.
      setBannedMapIds(view.bannedMapIds ?? []);
      setDifficulty(view.difficulty);
    }
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
      accept(await apiFor.start(difficulty, bannedMapIds));
      setReview(null);
    });
  const send = async (input: AnswerInput) => {
    if (!game) return;
    const current = generation.current;
    setPending(input);
    store(`${key}:pending`, JSON.stringify(input));
    await run(async () => {
      try {
        const response = await apiFor.answer(game.id, input);
        if (current !== generation.current) return;
        // A delta that does not follow this version means the game moved on in
        // another tab or device: read the authoritative game instead.
        const next = receiveAnswer(game, response.data) ?? (await apiFor.read(game.id));
        if (current !== generation.current) return;
        accept(next);
        setPending(null);
        store(`${key}:pending`, null);
        if (mode === 'random' && next.status !== 'finished')
          setReview(next.results.length - 1);
      } catch (e) {
        if (current !== generation.current) return;
        const status = (e as any)?.response?.status;
        if (status && status < 500) {
          setPending(null);
          store(`${key}:pending`, null);
          if (status === 409) accept(await apiFor.read(game.id));
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
      await apiFor.abandon(game.id);
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
      const view = await endpoints.random.start(game.difficulty, game.bannedMapIds ?? []);
      if (current !== generation.current) return;
      accept(view);
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
        accept((await api.post<GameView>(`/location/games/${game.id}/submit`)).data)
      );
    }
  };
  // Retrying after an error only re-reads an existing game; it never starts a
  // new one (an error in the lobby used to create a game by accident).
  const synchronize = () =>
    game
      ? run(async () => accept(await apiFor.read(game.id)))
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
    restoring,
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
