import RoomCountdown from '../location/RoomCountdown';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, ArrowLeft, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import GameRules from '../components/GameRules';
import { useConfirm } from '../components/ConfirmDialog';
import { useAuth } from '../store/auth';
import { getSocket } from '../api/socket';
import {
  DifficultySelect,
  QuestionPanel,
  Results,
  RoundReview,
} from '../location/Components';
import { message, roomAction } from '../location/api';
import type {
  AnswerInput,
  Difficulty,
  Guess,
  RoomView,
} from '../location/types';
import '../styles/location.css';

export default function LocationMulti() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { user, initialized: authInitialized } = useAuth();
  const canUseMatchmaking = Boolean(user?.id && user.email && user.emailVerified);
  const matchmakingAllowed = useRef(false);
  matchmakingAllowed.current = authInitialized && canUseMatchmaking;
  const [room, setRoom] = useState<RoomView | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [duration, setDuration] = useState(120);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState(false);
  const [pending, setPending] = useState<AnswerInput | null>(null);
  const [selectedPlayer, setSelectedPlayer] = useState('');
  const generation = useRef(0);
  const offset = useRef(0);
  const searching = useRef(false);
  const searchDifficulty = useRef(difficulty);
  const roomRef = useRef(room);
  const key = `location:room:${user?.id || 'guest'}`;
  const identityRef = useRef(user?.id);
  identityRef.current = user?.id;
  const accept = (next: RoomView) => {
    if (next.viewerUserId !== (identityRef.current ?? null))
      return;
    if (
      roomRef.current &&
      roomRef.current.id === next.id &&
      next.revision < roomRef.current.revision
    )
      return;
    offset.current = next.serverNow - Date.now();
    roomRef.current = next;
    setRoom(next);
    setQueued(false);
    searching.current = false;
    setError('');
    try {
      sessionStorage.setItem(key, next.id);
    } catch {
      /* optional */
    }
  };
  useEffect(() => {
    const current = ++generation.current;
    roomRef.current = null;
    setRoom(null);
    setPending(null);
    setSelectedPlayer('');
    setBusy(false);
    setQueued(false);
    searching.current = false;
    const socket = getSocket();
    const receive = (next: RoomView) => {
      if (current === generation.current) accept(next);
    };
    const restore = () => {
      socket.emit('location:room:delta', true);
      let id: string | null = null;
      try {
        id = sessionStorage.getItem(key);
        const saved = JSON.parse(
          sessionStorage.getItem(`${key}:pending`) || 'null'
        );
        if (saved?.roomId === id) setPending(saved.input);
      } catch {
        /* optional */
      }
      if (id)
        void roomAction<RoomView>('location:room:state', { roomId: id })
          .then((next) => current === generation.current && accept(next))
          .catch(() => undefined);
      if (searching.current && matchmakingAllowed.current)
        void roomAction<any>('location:match:join', {
          difficulty: searchDifficulty.current,
        })
          .then(
            (data) =>
              current === generation.current && data.room && accept(data.room)
          )
          .catch((e) => {
            if (current !== generation.current) return;
            if (e?.code === 'EMAIL_VERIFICATION_REQUIRED') {
              setQueued(false);
              searching.current = false;
            }
            setError(message(e));
          });
    };
    const patch = (event: { id: string; baseRevision: number; revision: number; changes: Partial<RoomView> }) => {
      if (current !== generation.current) return;
      const base = roomRef.current;
      if (base?.id === event.id && event.revision <= base.revision) return;
      if (base?.id === event.id && base.revision === event.baseRevision) accept({ ...base, ...event.changes });
      else void roomAction<RoomView>('location:room:state', { roomId: event.id })
        .then(next => current === generation.current && accept(next)).catch(() => undefined);
    };
    socket.on('location:room', receive);
    socket.on('location:room:patch', patch);
    socket.on('connect', restore);
    if (socket.connected) restore();
    return () => {
      generation.current++;
      socket.off('location:room', receive);
      socket.off('location:room:patch', patch);
      socket.emit('location:room:delta', false);
      socket.off('connect', restore);
      if (searching.current)
        socket.emit('location:match:cancel', {
          difficulty: searchDifficulty.current,
        });
    };
  }, [key]);
  useEffect(() => {
    if (!queued) return;
    const timeout = setTimeout(() => {
      setQueued(false);
      searching.current = false;
    }, 300000);
    return () => clearTimeout(timeout);
  }, [queued]);
  useEffect(() => {
    if (
      pending &&
      room &&
      (room.myGuess ||
        room.round !== pending.round ||
        room.status === 'round_over' ||
        room.status === 'finished')
    ) {
      setPending(null);
      try {
        sessionStorage.removeItem(`${key}:pending`);
      } catch {
        /* optional */
      }
    }
  }, [room, pending]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const action = (event: string, extra: Record<string, unknown> = {}) => {
    const current = generation.current;
    return run(async () => {
      const next = await roomAction<RoomView>(event, {
        roomId: room!.id,
        ...extra,
      });
      if (current === generation.current) accept(next);
    });
  };
  const send = (input: AnswerInput) => {
    const current = generation.current;
    const id = room?.id;
    setPending(input);
    try {
      sessionStorage.setItem(
        `${key}:pending`,
        JSON.stringify({ roomId: id, input })
      );
    } catch {
      /* optional */
    }
    return run(async () => {
      try {
        const next = await roomAction<RoomView>('location:room:answer', {
          roomId: id,
          ...input,
        });
        if (current === generation.current) accept(next);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (
          current === generation.current &&
          code &&
          !['LOCATION_BUSY', 'REDIS_UNAVAILABLE', 'INTERNAL_ERROR', 'RATE_LIMITED'].includes(code)
        ) {
          setPending(null);
          try {
            sessionStorage.removeItem(`${key}:pending`);
          } catch {
            /* optional */
          }
          const next = await roomAction<RoomView>('location:room:state', {
            roomId: id,
          });
          if (current === generation.current) accept(next);
        }
        throw e;
      }
    });
  };
  const answer = (guess: Guess) =>
    room &&
    void send({
      ...guess,
      round: room.round,
      version: room.round,
      requestId: crypto.randomUUID(),
    });
  const me = room?.players.find((player) => player.key === room.me);
  const own = room?.results.find((result) => result.key === room.me);
  const viewed =
    room?.results.find((result) => result.key === selectedPlayer) || own;
  const leave = async () => {
    if (
      !room ||
      !(await confirm({
        title: t('location.leaveRoom'),
        message: t('location.abandonPrompt'),
        confirmLabel: t('location.leaveRoom'),
        tone: 'warning',
      }))
    )
      return;
    await run(async () => {
      await roomAction('location:room:leave', { roomId: room.id });
      setRoom(null);
      roomRef.current = null;
      setPending(null);
      try {
        sessionStorage.removeItem(key);
        sessionStorage.removeItem(`${key}:pending`);
      } catch {
        /* optional */
      }
    });
  };
  return (
    <Page
      title={`${t('location.title')} · ${t('location.multiplayer')}`}
      className="location-page"
      icon={<Users size={18} />}
      actions={
        <Link className="btn btn-ghost btn-sm" to="/entertainment/location" aria-label={t('location.title')}>
          <ArrowLeft size={16} />
        </Link>
      }
    >
      {error && (
        <div className="location-alert" role="alert">
          {error}
          {pending && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => void send(pending)}
            >
              {t('location.retry')}
            </button>
          )}
        </div>
      )}
      {!room ? (
        <section className="location-lobby">
          <span className="location-eyebrow">CS2 // MULTIPLAYER</span>
          <h1>{t('location.multiplayer')}</h1>
          <p>{t('location.roomHelp')}</p>
          <DifficultySelect
            value={difficulty}
            onChange={setDifficulty}
            disabled={busy || queued}
          />
          <div className="location-multi-controls">
            <label>
              {t('location.duration')}
              <select
                className="input"
                disabled={busy || queued}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {[60, 120, 180].map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {t('location.seconds', { count: seconds })}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn location-start"
              disabled={busy || queued}
              onClick={() =>
                void run(async () =>
                  accept(
                    await roomAction<RoomView>('location:room:create', {
                      difficulty,
                      duration,
                    })
                  )
                )
              }
            >
              {t('location.createRoom')}
            </button>
          </div>
          <div className="location-join">
            <input
              className="input"
              aria-label={t('location.roomCode')}
              placeholder={t('location.roomCode')}
              maxLength={5}
              value={code}
              disabled={busy || queued}
              onChange={(e) =>
                setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
              }
            />
            <button
              className="btn"
              disabled={busy || queued || code.length !== 5}
              onClick={() =>
                void run(async () =>
                  accept(
                    await roomAction<RoomView>('location:room:join', {
                      roomId: code,
                    })
                  )
                )
              }
            >
              {t('location.joinRoom')}
            </button>
          </div>
          <div className="location-match">
            {authInitialized && !canUseMatchmaking && (
              <p className="muted matchmaking-requirement">
                {t('multi.matchVerifiedRequired')}
              </p>
            )}
            <button
              className="btn btn-ghost"
              disabled={
                busy || (!queued && (!authInitialized || !canUseMatchmaking))
              }
              onClick={() =>
                void run(async () => {
                  if (queued) {
                    await roomAction('location:match:cancel', { difficulty });
                    setQueued(false);
                    searching.current = false;
                  } else {
                    if (!matchmakingAllowed.current) {
                      setError(t('errors.EMAIL_VERIFICATION_REQUIRED'));
                      return;
                    }
                    searchDifficulty.current = difficulty;
                    const result = await roomAction<{
                      room?: RoomView;
                      queued?: boolean;
                    }>('location:match:join', { difficulty });
                    if (result.room) accept(result.room);
                    else {
                      setQueued(true);
                      searching.current = true;
                    }
                  }
                })
              }
            >
              {t(queued ? 'location.cancelMatch' : 'location.quickMatch')}
            </button>
            {queued && <p role="status">{t('location.searching')}</p>}
          </div>
        </section>
      ) : (
        <>
          <div className="location-game-status">
            <strong>
              {room.id}
              <button
                className="btn btn-ghost btn-sm"
                aria-label={t('location.copy')}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(room.id)
                    .catch(() => undefined)
                }
              >
                <Copy size={14} />
              </button>
            </strong>
            <span>
              {room.round
                ? t('location.round', { round: room.round })
                : t('location.waiting')}
            </span>
            <RoomCountdown clock deadline={room.startsAt || room.endsAt || room.nextAt} offset={offset.current} />
            <span>{t(`location.${room.difficulty}`)}</span>
          </div>
          <div className="location-player-strip">
            {[...room.players]
              .sort(
                (a, b) =>
                  Number(a.retired) - Number(b.retired) || b.score - a.score
              )
              .map((player) => (
                <div
                  key={player.key}
                  className={player.key === room.me ? 'me' : ''}
                >
                  <strong>
                    {player.rank ? `#${player.rank} ` : ''}
                    {player.name}
                  </strong>
                  <small>
                    {player.key === room.host ? `${t('location.host')} · ` : ''}
                    {t(
                      player.retired
                        ? 'location.retired'
                        : !player.connected
                          ? 'location.offline'
                          : player.submitted
                            ? 'location.submitted'
                            : player.ready
                              ? 'location.ready'
                              : 'location.waiting'
                    )}
                  </small>
                  <span>{player.score.toLocaleString()}</span>
                </div>
              ))}
          </div>
          {['round_over', 'finished'].includes(room.status) && (
            <label>
              {t('location.playerPins')}
              <select
                className="input"
                value={viewed?.key || room.me}
                onChange={(e) => setSelectedPlayer(e.target.value)}
              >
                {room.players.map((player) => (
                  <option key={player.key} value={player.key}>
                    {player.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {room.status === 'waiting' ? (
            <div className="location-room-waiting">
              <p>{t('location.roomHelp')}</p>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void action('location:room:ready', { ready: !me?.ready })
                }
              >
                {t(me?.ready ? 'location.unready' : 'location.ready')}
              </button>
              {room.host === room.me && (
                <button
                  className="btn location-start"
                  disabled={
                    busy ||
                    room.players.length < 2 ||
                    !room.players.every((p) => p.ready && p.connected)
                  }
                  onClick={() => void action('location:room:start')}
                >
                  {t('location.startMatch')}
                </button>
              )}
            </div>
          ) : room.status === 'finished' && viewed ? (
            <Results
              results={viewed.rounds}
              score={room.players.find((p) => p.key === viewed.key)?.score || 0}
              playerName={viewed.key === room.me ? undefined : viewed.name}
            />
          ) : room.status === 'cancelled' ? (
            <h2>{t('location.cancelled')}</h2>
          ) : room.status === 'round_over' && viewed?.rounds[room.round - 1] ? (
            <RoundReview
              key={viewed.key}
              result={viewed.rounds[room.round - 1]}
              playerName={viewed.key === room.me ? undefined : viewed.name}
            />
          ) : (
            room.question && (
              <>
                {room.status === 'preparing' && (
                  <RoomCountdown label={t('location.preparing')} deadline={room.startsAt} offset={offset.current} />
                )}
                <p className="location-rules-note">
                  {t(
                    me?.submitted
                      ? 'location.waitingAnswers'
                      : 'location.timeoutNotice'
                  )}
                </p>
                <QuestionPanel
                  imageUrl={room.question.imageUrl}
                  maps={room.maps}
                  onSubmit={answer}
                  disabled={
                    busy ||
                    Boolean(pending) ||
                    Boolean(me?.submitted) ||
                    Boolean(me?.retired) ||
                    room.status !== 'playing'
                  }
                />
              </>
            )
          )}
          <button
            className="btn btn-ghost location-abandon"
            disabled={busy}
            onClick={() => void leave()}
          >
            {t('location.leaveRoom')}
          </button>
        </>
      )}
      <div className="location-rules-entry">
        <GameRules variant="location" />
      </div>
    </Page>
  );
}
