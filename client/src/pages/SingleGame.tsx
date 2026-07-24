import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Gamepad2, Flame, RotateCcw, Lightbulb, Target, X, Home } from 'lucide-react';
import Page from '../components/Page';
import GuessBoard from '../components/GuessBoard';
import GuessInputBar from '../components/GuessInputBar';
import AnswerOverlay, { AnswerInfo } from '../components/AnswerOverlay';
import { api, errMsg } from '../api/client';
import { GuessFeedback } from '../types';
import { useConfirm } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';
import { useTranslation } from 'react-i18next';
import { difficultyLabel } from '../utils/difficulty';
import { setStoredSingleDifficulty } from '../store/singleDifficulty';

function exitGame(gameId: string): Promise<unknown> {
  return api.post(`/game/${gameId}/exit`);
}

export default function SingleGame() {
  const { t } = useTranslation();
  const { mode = 'easy' } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [gameId, setGameId] = useState<string | null>(null);
  const [guesses, setGuesses] = useState<GuessFeedback[]>([]);
  const [maxGuesses, setMaxGuesses] = useState(8);
  const [status, setStatus] = useState<'playing' | 'won' | 'lost'>('playing');
  const [answer, setAnswer] = useState<AnswerInfo | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const gameIdRef = useRef<string | null>(null);
  const boardEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setStoredSingleDifficulty(mode);
  }, [mode]);

  const setCurrentGameId = (id: string | null) => {
    gameIdRef.current = id;
    setGameId(id);
  };

  const start = useCallback(async (replace = true) => {
    setAnswer(null);
    setShowOverlay(false);
    setStatus('playing');
    try {
      const previous = gameIdRef.current;
      if (replace && previous) {
        setCurrentGameId(null);
        await exitGame(previous);
      }
      const res = await api.post('/game/start', { mode });
      setCurrentGameId(String(res.data.gameId));
      setGuesses(res.data.guesses);
      setMaxGuesses(res.data.maxGuesses);
    } catch (err) {
      toast.error(errMsg(err));
    }
  }, [mode]);

  useEffect(() => {
    void start(false);
  }, [start]);

  useEffect(() => {
    if (!inputFocused || !window.matchMedia('(max-width: 640px)').matches) return;
    let frame = 0;
    const keepLatestVisible = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        boardEndRef.current?.scrollIntoView({ block: 'end' });
      });
    };
    keepLatestVisible();
    window.visualViewport?.addEventListener('resize', keepLatestVisible);
    return () => {
      window.cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener('resize', keepLatestVisible);
    };
  }, [guesses.length, inputFocused]);

  const leave = async () => {
    const isGameActive = Boolean(gameIdRef.current) && status === 'playing';
    if (isGameActive && !await confirm({
      title: t('game.leaveTitle'),
      message: t('game.leaveMessage'),
      confirmLabel: t('game.leaveConfirm'),
      tone: 'danger',
    })) return;
    const id = gameIdRef.current;
    setCurrentGameId(null);
    try {
      if (id && isGameActive) await exitGame(id);
    } catch (err) {
      toast.error(errMsg(err));
    }
    navigate('/');
  };

  const restart = async () => {
    const isGameActive = Boolean(gameIdRef.current) && status === 'playing';
    if (isGameActive && !await confirm({
      title: t('game.restartTitle'),
      message: t('game.restartMessage'),
      confirmLabel: t('game.restart'),
      tone: 'danger',
    })) return;
    await start(true);
  };

  const guess = async (playerId: number) => {
    if (!gameId || status !== 'playing') return;
    try {
      const res = await api.post(`/game/${gameId}/guess`, { playerId });
      setGuesses((g) => [...g, res.data.feedback]);
      setStatus(res.data.status);
      if (res.data.answer) {
        setAnswer(res.data.answer);
        setShowOverlay(true);
      }
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const reveal = async () => {
    if (!gameId || status !== 'playing') return;
    if (!await confirm({
      title: t('game.revealTitle'),
      message: t('game.revealMessage'),
      confirmLabel: t('game.reveal'),
      tone: 'danger',
    })) return;
    try {
      const res = await api.post(`/game/${gameId}/giveup`);
      setStatus('lost');
      if (res.data.answer) {
        setAnswer(res.data.answer);
        setShowOverlay(true);
      }
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const finished = status !== 'playing';
  const isEasy = mode === 'easy';
  const modeLabel = difficultyLabel(t, mode);

  return (
    <Page
      className={`game-page single-game-page${inputFocused ? ' keyboard-active' : ''}`}
      title={t('game.singleMode', { defaultValue: `单人 · ${modeLabel}`, mode: modeLabel })}
      icon={isEasy ? <Gamepad2 size={17} /> : <Flame size={17} />}
      actions={
        <>
          <button className="btn btn-ghost btn-sm" aria-label={t('game.restart')} onClick={() => void restart()}>
            <RotateCcw size={15} />
            <span className="btn-text">{t('game.restart')}</span>
          </button>
          <button className="btn btn-ghost btn-sm" aria-label={t('common.home')} onClick={() => void leave()}>
            <Home size={15} />
            <span className="btn-text">{t('common.home')}</span>
          </button>
          <button
            className="btn btn-warning btn-sm"
            aria-label={t('game.reveal')}
            onClick={() => void reveal()}
            disabled={finished}
          >
            <Lightbulb size={15} />
            <span className="btn-text">{t('game.reveal')}</span>
          </button>
        </>
      }
      showHome={false}
      statusBar={
        <>
          <Target size={14} />
          {t('game.guesses', { current: guesses.length, max: maxGuesses })}
          <span style={{ color: 'var(--border)' }}>|</span>
          {finished
            ? status === 'won'
              ? t('game.congratulations')
              : t('game.ended')
            : t('game.hint')}
        </>
      }
      dock={
        finished ? (
          <div className="input-bar" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={() => void restart()}>
              <RotateCcw size={15} />
              {t('game.again')}
            </button>
            <button className="btn btn-danger" onClick={() => void leave()}>
              <X size={15} />
              {t('game.back')}
            </button>
          </div>
        ) : (
          <GuessInputBar
            onPick={(p) => void guess(p.id)}
            onFocusChange={setInputFocused}
          />
        )
      }
    >
      {guesses.length ? (
        <div className="single-game-board">
          <GuessBoard guesses={guesses} />
          <div ref={boardEndRef} className="guess-board-end" aria-hidden="true" />
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-light)' }}>
          <Target size={32} strokeWidth={1.5} />
          <p>{t('game.startHint')}</p>
          {isEasy ? (
            <p style={{ fontSize: '0.8rem' }}>{t('game.easyHint')}</p>
          ) : (
            <p style={{ fontSize: '0.8rem' }}>{t('game.normalHint')}</p>
          )}
        </div>
      )}
      {showOverlay && (
        <AnswerOverlay
          title={status === 'won' ? t('game.congratulations') : t('game.correctAnswer')}
          answer={answer}
          extra={
            <p className="muted">
              {status === 'won' ? t('game.usedGuesses', { count: guesses.length }) : t('game.missed')}
            </p>
          }
          actions={
            <>
              <button className="btn" onClick={() => void restart()}>
                <RotateCcw size={15} />
                {t('game.again')}
              </button>
              <button className="btn btn-ghost" onClick={() => setShowOverlay(false)}>
                {t('game.viewGame')}
              </button>
            </>
          }
        />
      )}
    </Page>
  );
}
