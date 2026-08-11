import { useCallback, useEffect, useState } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  CircleX,
  Lightbulb,
  Play,
  Target,
  Trophy,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import Page from '../components/Page';
import GuessBoard from '../components/GuessBoard';
import GuessInputBar from '../components/GuessInputBar';
import AnswerOverlay, { type AnswerInfo } from '../components/AnswerOverlay';
import DataTable, { type Column } from '../components/DataTable';
import { api, errMsg } from '../api/client';
import { toast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import type { GuessFeedback } from '../types';
import { AVAILABLE_DIFFICULTIES } from '../config/difficulties';
import { difficultyColor, difficultyIcon, difficultyLabel } from '../utils/difficulty';
import { setStoredDailyDifficulty } from '../store/dailyDifficulty';

type DailyStatus = 'not_started' | 'playing' | 'won' | 'lost';

interface DailyLeaderboardRow {
  rank: number;
  displayId: string;
  guessCount: number;
  isCurrent: boolean;
}

interface DailyChallengeItem {
  difficulty: string;
  status: DailyStatus;
  gameId: string | null;
  maxGuesses: number;
  guessCount: number;
  solveOrder: number | null;
  guesses: GuessFeedback[];
  answer: AnswerInfo | null;
}

interface DailyChallengeResponse {
  date: string;
  timeZone: 'Asia/Shanghai';
  serverNow: number;
  startsAt: number;
  nextRefreshAt: number;
  challenge: DailyChallengeItem;
}

interface DailyLeaderboardResponse {
  difficulty: string;
  leaderboard: DailyLeaderboardRow[];
}

interface ServerClockAnchor {
  serverNow: number;
  clientNow: number;
}

function createClockAnchor(value: unknown): ServerClockAnchor | null {
  const serverNow = Number(value);
  return Number.isFinite(serverNow) && serverNow > 0
    ? { serverNow, clientNow: performance.now() }
    : null;
}

function localDeadline(timestamp: unknown, anchor: ServerClockAnchor | null): number | null {
  const serverDeadline = Number(timestamp);
  if (!anchor || !Number.isFinite(serverDeadline) || serverDeadline <= 0) return null;
  return anchor.clientNow + (serverDeadline - anchor.serverNow);
}

function remainingTime(target: number, now: number): string {
  const totalSeconds = Math.max(0, Math.ceil((target - now) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export default function DailyChallenge() {
  const { t } = useTranslation();
  const { mode = '' } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const isValidMode = AVAILABLE_DIFFICULTIES.some((difficulty) => difficulty.key === mode);
  const [daily, setDaily] = useState<DailyChallengeResponse | null>(null);
  const [leaderboard, setLeaderboard] = useState<DailyLeaderboardRow[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [overlayAnswer, setOverlayAnswer] = useState<AnswerInfo | null>(null);
  const [overlayStatus, setOverlayStatus] = useState<'won' | 'lost'>('won');
  const [overlaySolveOrder, setOverlaySolveOrder] = useState<number | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const [refreshDeadline, setRefreshDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => performance.now());

  const loadLeaderboard = useCallback(async (silent = false) => {
    setLeaderboardLoading(true);
    try {
      const response = await api.get<DailyLeaderboardResponse>(
        `/daily-challenge/${mode}/leaderboard`
      );
      setLeaderboard(response.data.leaderboard);
      setLeaderboardError(null);
    } catch (error) {
      const message = errMsg(error);
      setLeaderboardError(message);
      if (silent) toast.error(message);
    } finally {
      setLeaderboardLoading(false);
    }
  }, [mode]);

  const loadChallenge = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await api.get<DailyChallengeResponse>(`/daily-challenge/${mode}`);
      const anchor = createClockAnchor(response.data.serverNow);
      setDaily(response.data);
      setRefreshDeadline(localDeadline(response.data.nextRefreshAt, anchor));
      if (anchor) setNow(anchor.clientNow);
      setStartError(null);
      const status = response.data.challenge.status;
      if (status === 'won' || status === 'lost') {
        await loadLeaderboard(silent);
      } else {
        setLeaderboard([]);
        setLeaderboardError(null);
      }
    } catch (error) {
      if (!silent) setStartError(errMsg(error));
      else toast.error(errMsg(error));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [loadLeaderboard, mode]);

  useEffect(() => {
    if (!isValidMode) {
      navigate('/daily', { replace: true });
      return;
    }
    setStoredDailyDifficulty(mode);
    void loadChallenge();
  }, [isValidMode, loadChallenge, mode, navigate]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (refreshDeadline == null) return;
    const delay = Math.max(1_000, refreshDeadline - performance.now() + 250);
    const timer = window.setTimeout(() => void loadChallenge(), delay);
    return () => window.clearTimeout(timer);
  }, [loadChallenge, refreshDeadline]);

  const challenge = daily?.challenge ?? null;
  const busy = starting || revealing;
  const challengeFinished = challenge?.status === 'won' || challenge?.status === 'lost';

  const patchChallenge = (update: Partial<DailyChallengeItem>) => {
    setDaily((current) => current ? {
      ...current,
      challenge: { ...current.challenge, ...update },
    } : current);
  };

  const start = async () => {
    if (!challenge || challenge.status !== 'not_started' || busy) return;
    setStarting(true);
    try {
      const response = await api.post('/daily-challenge/start', { difficulty: challenge.difficulty });
      patchChallenge({
        status: 'playing',
        gameId: String(response.data.gameId),
        maxGuesses: Number(response.data.maxGuesses),
        guessCount: response.data.guesses.length,
        guesses: response.data.guesses,
      });
      setLeaderboard([]);
      setLeaderboardError(null);
    } catch (error) {
      toast.error(errMsg(error));
      await loadChallenge(true);
    } finally {
      setStarting(false);
    }
  };

  const guess = async (playerId: number) => {
    if (!challenge?.gameId || challenge.status !== 'playing' || busy) return false;
    try {
      const response = await api.post(`/daily-challenge/${challenge.gameId}/guess`, { playerId });
      const finished = response.data.status === 'won' || response.data.status === 'lost';
      const solveOrder = response.data.solveOrder == null ? null : Number(response.data.solveOrder);
      patchChallenge({
        status: response.data.status,
        guessCount: Number(response.data.guessCount),
        solveOrder,
        guesses: [...challenge.guesses, response.data.feedback],
        answer: response.data.answer ?? null,
        gameId: finished ? null : challenge.gameId,
      });
      if (finished && response.data.answer) {
        setOverlayAnswer(response.data.answer);
        setOverlayStatus(response.data.status);
        setOverlaySolveOrder(solveOrder);
        setShowOverlay(true);
        setLeaderboardLoading(true);
        void loadChallenge(true);
      }
      return true;
    } catch (error) {
      toast.error(errMsg(error));
      return false;
    }
  };

  const reveal = async () => {
    if (!challenge?.gameId || challenge.status !== 'playing' || busy) return;
    if (!await confirm({
      title: t('daily.giveupTitle'),
      message: t('daily.giveupMessage'),
      confirmLabel: t('daily.giveupConfirm'),
      tone: 'danger',
    })) return;
    setRevealing(true);
    try {
      const response = await api.post(`/daily-challenge/${challenge.gameId}/giveup`);
      patchChallenge({
        status: 'lost',
        gameId: null,
        answer: response.data.answer,
        guessCount: Number(response.data.guessCount),
      });
      setOverlayAnswer(response.data.answer);
      setOverlayStatus('lost');
      setOverlaySolveOrder(null);
      setShowOverlay(true);
      setLeaderboardLoading(true);
      void loadChallenge(true);
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setRevealing(false);
    }
  };

  const showStoredAnswer = () => {
    if (!challenge?.answer || (challenge.status !== 'won' && challenge.status !== 'lost')) return;
    setOverlayAnswer(challenge.answer);
    setOverlayStatus(challenge.status);
    setOverlaySolveOrder(challenge.solveOrder);
    setShowOverlay(true);
  };

  const columns: Column<DailyLeaderboardRow>[] = [
    { key: 'rank', title: '#' },
    {
      key: 'displayId',
      title: t('daily.player'),
      render: (row) => (
        <span className="daily-leaderboard-player">
          {row.displayId}
          {row.isCurrent && <span className="leaderboard-self-marker">{t('leaderboard.self')}</span>}
        </span>
      ),
    },
    {
      key: 'guessCount',
      title: t('daily.steps'),
      render: (row) => t('daily.stepCount', { count: row.guessCount }),
    },
  ];

  const statusLabel = challenge ? t(`daily.status.${challenge.status}`) : '';
  const SelectedIcon = difficultyIcon(mode);
  const pageBusy = loading || !daily || !challenge;

  if (!isValidMode) return null;

  return (
    <Page
      className={`daily-page game-page${inputFocused ? ' keyboard-active' : ''}`}
      title={t('daily.title')}
      icon={<CalendarDays size={17} />}
      actions={challenge?.status === 'playing' ? (
        <button
          type="button"
          className="btn btn-warning btn-sm"
          onClick={() => void reveal()}
          disabled={busy}
          aria-label={t('daily.giveup')}
        >
          <Lightbulb size={15} />
          <span className="btn-text">{revealing ? t('multi.processing') : t('daily.giveup')}</span>
        </button>
      ) : undefined}
      statusBar={daily ? (
        <>
          <CalendarDays size={14} />
          <span>{t('daily.date', { date: daily.date })}</span>
          <span className="daily-status-divider">|</span>
          <span>{t('daily.refreshIn', {
            time: remainingTime(refreshDeadline ?? now, now),
          })}</span>
        </>
      ) : undefined}
      dock={challenge?.status === 'playing' ? (
        <GuessInputBar
          onPick={(player) => guess(player.id)}
          onFocusChange={setInputFocused}
          disabled={busy || !challenge.gameId}
        />
      ) : undefined}
    >
      {pageBusy ? (
        <div className="daily-loading" role="status" aria-label={t('common.loading')}>
          <div className="spinner" />
          <p>{startError || t('common.loading')}</p>
          {startError && (
            <button type="button" className="btn" onClick={() => void loadChallenge()}>
              {t('common.retry')}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className={`daily-content-layout${challengeFinished ? ' has-leaderboard' : ''}`}>
            <section className="daily-game-section" aria-labelledby="daily-game-heading">
            <div className="daily-section-heading">
              <div>
                <span className="daily-section-icon" style={{ ['--diff-color' as string]: difficultyColor(mode) }}>
                  <SelectedIcon size={19} />
                </span>
                <div>
                  <h2 id="daily-game-heading">{difficultyLabel(t, mode)}</h2>
                  <p>{statusLabel}</p>
                </div>
              </div>
              <span
                className={`daily-status daily-status-${challenge.status}`}
                aria-label={t('game.guesses', { current: challenge.guessCount, max: challenge.maxGuesses })}
              >
                {challenge.guessCount} / {challenge.maxGuesses}
              </span>
            </div>

            {challenge.guesses.length > 0 && <GuessBoard guesses={challenge.guesses} />}

            {challenge.status === 'not_started' && (
              <div className="daily-game-empty">
                <Target size={34} strokeWidth={1.5} />
                <strong>{t('daily.ready')}</strong>
                <button type="button" className="btn btn-green btn-lg" onClick={() => void start()} disabled={starting}>
                  <Play size={17} />
                  {starting ? t('daily.starting') : t('daily.start')}
                </button>
              </div>
            )}

            {challenge.status === 'playing' && challenge.guesses.length === 0 && (
              <div className="daily-game-empty">
                <Target size={34} strokeWidth={1.5} />
                <strong>{t('daily.playing')}</strong>
                <span>{t('game.startHint')}</span>
              </div>
            )}

            {(challenge.status === 'won' || challenge.status === 'lost') && (
              <div className={`daily-result daily-result-${challenge.status}`}>
                {challenge.status === 'won'
                  ? <CheckCircle2 size={24} />
                  : <CircleX size={24} />}
                <div>
                  <strong>
                    {challenge.status === 'won'
                      ? t('daily.wonIn', { count: challenge.guessCount })
                      : t('daily.lost')}
                  </strong>
                  {challenge.status === 'won' && challenge.solveOrder != null && (
                    <span className="daily-solve-order">
                      {t('daily.solveOrder', { order: challenge.solveOrder })}
                    </span>
                  )}
                  <span>{challenge.answer?.nickname}</span>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={showStoredAnswer}>
                  {t('daily.viewAnswer')}
                </button>
              </div>
            )}
            </section>

            {challengeFinished && (
              <section className="daily-leaderboard-section" aria-labelledby="daily-leaderboard-heading">
                <div className="daily-section-heading">
                  <div>
                    <span className="daily-section-icon daily-trophy-icon"><Trophy size={19} /></span>
                    <div>
                      <h2 id="daily-leaderboard-heading">{t('daily.leaderboard')}</h2>
                      <p>{difficultyLabel(t, mode)}</p>
                    </div>
                  </div>
                  <span className="daily-top-ten">TOP 10</span>
                </div>
                <div className="daily-leaderboard-table">
                  <DataTable
                    columns={columns}
                    rows={leaderboard}
                    rowKey={(row) => `${row.rank}-${row.displayId}`}
                    empty={leaderboardError || t('daily.leaderboardEmpty')}
                    loading={leaderboardLoading}
                  />
                  {leaderboardError && !leaderboardLoading && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void loadLeaderboard()}
                    >
                      {t('common.retry')}
                    </button>
                  )}
                </div>
              </section>
            )}
          </div>
        </>
      )}

      {showOverlay && (
        <AnswerOverlay
          title={overlayStatus === 'won' ? t('daily.won') : t('daily.lostTitle')}
          answer={overlayAnswer}
          tone={overlayStatus === 'won' ? 'win' : 'lose'}
          onClose={() => setShowOverlay(false)}
          extra={
            <div className="daily-overlay-summary">
              <p className="muted">
                {overlayStatus === 'won'
                  ? t('daily.wonIn', { count: challenge?.guessCount ?? 0 })
                  : t('daily.lost')}
              </p>
              {overlayStatus === 'won' && overlaySolveOrder != null && (
                <p className="daily-overlay-order">
                  {t('daily.solveOrder', { order: overlaySolveOrder })}
                </p>
              )}
            </div>
          }
          actions={
            <button type="button" className="btn" onClick={() => setShowOverlay(false)}>
              {t('daily.viewLeaderboard')}
            </button>
          }
        />
      )}
    </Page>
  );
}
