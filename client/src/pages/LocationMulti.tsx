import RoomCountdown from '../location/RoomCountdown';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, ArrowLeft, Copy, Check, LogOut, House, Dices, DoorOpen, XCircle, Zap, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import GameRules from '../components/GameRules';
import { useConfirm } from '../components/ConfirmDialog';
import { useOccupiedRoomPrompt } from '../components/OccupiedRoomDialog';
import { useAuth } from '../store/auth';
import { getSocket } from '../api/socket';
import { negotiateRoomProtocols, occupiedOf } from '../api/roomKernel';
import {
  DifficultySelect,
  QuestionPanel,
  Results,
  RoundReview,
} from '../location/Components';
import { message, roomAction } from '../location/api';
import {
  applyRoomPatchV2,
  hydrateRoomView,
  isRoomViewV2,
  type RoomPatchV2,
  type RoomPrivatePatchV2,
  type RoomViewV2,
} from '../location/roomProtocol';
import type {
  AnswerInput,
  Difficulty,
  Guess,
  MapDefinition,
  RoomView,
} from '../location/types';
import '../styles/location.css';

const RESYNC_THROTTLE_MS = 15_000;
const QUEUE_TIMEOUT_MS = 300_000;

export default function LocationMulti() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [occupiedDialog, promptOccupied] = useOccupiedRoomPrompt();
  const { user, initialized: authInitialized } = useAuth();
  const canUseMatchmaking = Boolean(user?.id && user.email && user.emailVerified);
  const matchmakingAllowed = useRef(false);
  matchmakingAllowed.current = authInitialized && canUseMatchmaking;
  const [room, setRoom] = useState<RoomView | null>(null);
  // Each lobby card keeps its own difficulty (they used to share one state).
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [matchDifficulty, setMatchDifficulty] = useState<Difficulty>('normal');
  const [duration, setDuration] = useState(120);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState(false);
  const [pending, setPending] = useState<AnswerInput | null>(null);
  const [selectedPlayer, setSelectedPlayer] = useState('');
  const [codeCopied, setCodeCopied] = useState(false);
  const [offset, setOffset] = useState(0);
  const generation = useRef(0);
  const searching = useRef(false);
  const searchDifficulty = useRef(matchDifficulty);
  const roomRef = useRef(room);
  /** Map catalogue held by the client; protocol v2 sends it once per room. */
  const mapsRef = useRef<{ hash: string | null; maps: MapDefinition[] }>({ hash: null, maps: [] });
  const protocolRef = useRef(1);
  /** Seat-private guesses that arrived before their public revision. */
  const privateRef = useRef(new Map<number, Guess | null>());
  const lastSync = useRef(0);
  const key = `location:room:${user?.id || 'guest'}`;
  const pendingKey = `${key}:pending`;
  const identityRef = useRef(user?.id);
  identityRef.current = user?.id;

  const storeRoomId = (id: string | null) => {
    try {
      if (id) sessionStorage.setItem(key, id);
      else sessionStorage.removeItem(key);
    } catch {
      /* optional */
    }
  };

  const accept = (next: RoomView) => {
    if (next.viewerUserId !== (identityRef.current ?? null)) return;
    const previous = roomRef.current;
    if (previous && previous.id === next.id && next.revision < previous.revision) return;
    const waiting = privateRef.current.get(next.revision);
    if (waiting !== undefined) {
      next = { ...next, myGuess: waiting };
      privateRef.current.delete(next.revision);
    }
    // Rounded so the countdown does not restart its timer for every patch.
    setOffset(Math.round((next.serverNow - Date.now()) / 250) * 250);
    roomRef.current = next;
    setRoom(next);
    setQueued(false);
    searching.current = false;
    setError('');
    if (!previous || previous.id !== next.id) storeRoomId(next.id);
  };

  /** Accept a full view in either protocol (v2 views are rehydrated with cached maps). */
  const acceptView = (next: RoomView | RoomViewV2): boolean => {
    if (isRoomViewV2(next)) {
      if (next.maps) mapsRef.current = { hash: next.mapsHash, maps: next.maps };
      else if (next.mapsHash && next.mapsHash !== mapsRef.current.hash) return false;
      accept(hydrateRoomView(next, next.maps ?? mapsRef.current.maps));
      return true;
    }
    mapsRef.current = { hash: null, maps: next.maps };
    accept(next);
    return true;
  };

  const fetchState = (roomId: string, withMaps = false) => {
    const current = generation.current;
    lastSync.current = Date.now();
    return roomAction<RoomView | RoomViewV2>('location:room:state', {
      roomId,
      ...(protocolRef.current === 2 && !withMaps && mapsRef.current.hash ? { mapsHash: mapsRef.current.hash } : {}),
    }).then((next) => {
      if (current !== generation.current) return;
      if (!acceptView(next)) void fetchState(roomId, true);
    });
  };

  useEffect(() => {
    const current = ++generation.current;
    roomRef.current = null;
    mapsRef.current = { hash: null, maps: [] };
    privateRef.current.clear();
    setRoom(null);
    setPending(null);
    setSelectedPlayer('');
    setBusy(false);
    setQueued(false);
    searching.current = false;
    const socket = getSocket();
    const live = () => current === generation.current;
    const receive = (next: RoomView | RoomViewV2) => {
      if (live()) acceptView(next);
    };
    const restore = async () => {
      const protocols = await negotiateRoomProtocols(socket);
      if (!live()) return;
      protocolRef.current = protocols.location ?? 1;
      if (protocolRef.current === 1) socket.emit('location:room:delta', true);
      let id: string | null = null;
      try {
        id = sessionStorage.getItem(key);
        const saved = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
        if (saved?.roomId === id) setPending(saved.input);
      } catch {
        /* optional */
      }
      if (id) void fetchState(id).catch(() => undefined);
      if (searching.current && matchmakingAllowed.current)
        void roomAction<{ room?: RoomView | RoomViewV2 }>('location:match:join', { difficulty: searchDifficulty.current })
          .then((data) => live() && data.room && acceptView(data.room))
          .catch((e) => {
            if (!live()) return;
            if (e?.code === 'EMAIL_VERIFICATION_REQUIRED') {
              setQueued(false);
              searching.current = false;
            }
            setError(message(e));
          });
    };
    /** Protocol v1 (old server or page): top-level patches. */
    const patchV1 = (event: { id: string; baseRevision: number; revision: number; changes: Partial<RoomView> }) => {
      if (!live()) return;
      const base = roomRef.current;
      if (base?.id === event.id && event.revision <= base.revision) return;
      if (base?.id === event.id && base.revision === event.baseRevision) accept({ ...base, ...event.changes });
      else void fetchState(event.id).catch(() => undefined);
    };
    /** Protocol v2: one public patch per revision, applied to the hydrated view. */
    const patchV2 = (event: RoomPatchV2) => {
      if (!live() || event.game !== 'location') return;
      const base = roomRef.current;
      if (!base || base.id !== event.roomId) return;
      if (event.rev <= base.revision) return;
      if (event.base !== base.revision) {
        void fetchState(event.roomId).catch(() => undefined);
        return;
      }
      if (event.sections.maps) mapsRef.current = { hash: event.sections.mapsHash ?? null, maps: event.sections.maps };
      const next = applyRoomPatchV2(base, event, mapsRef.current.maps);
      if (next) accept(next);
      else void fetchState(event.roomId, true).catch(() => undefined);
    };
    const privateV2 = (event: RoomPrivatePatchV2) => {
      if (!live() || event.game !== 'location') return;
      const base = roomRef.current;
      if (!base || base.id !== event.roomId || event.rev < base.revision) return;
      if (event.rev === base.revision) accept({ ...base, myGuess: event.private.myGuess });
      else privateRef.current.set(event.rev, event.private.myGuess);
    };
    const onConnect = () => void restore();
    const onVisible = () => {
      const base = roomRef.current;
      if (document.visibilityState !== 'visible' || !base || Date.now() - lastSync.current < RESYNC_THROTTLE_MS) return;
      void fetchState(base.id).catch(() => undefined);
    };
    socket.on('location:room', receive);
    socket.on('location:room:patch', patchV1);
    socket.on('room-kernel:patch', patchV2);
    socket.on('room-kernel:private', privateV2);
    socket.on('connect', onConnect);
    document.addEventListener('visibilitychange', onVisible);
    if (socket.connected) void restore();
    return () => {
      generation.current++;
      socket.off('location:room', receive);
      socket.off('location:room:patch', patchV1);
      socket.off('room-kernel:patch', patchV2);
      socket.off('room-kernel:private', privateV2);
      socket.off('connect', onConnect);
      document.removeEventListener('visibilitychange', onVisible);
      // Leaving the page stops room delivery to this socket; the seat stays.
      if (protocolRef.current === 2 && roomRef.current) socket.emit('location:room:unsubscribe', { roomId: roomRef.current.id });
      else socket.emit('location:room:delta', false);
      if (searching.current)
        socket.emit('location:match:cancel', { difficulty: searchDifficulty.current });
    };
  }, [key]);

  useEffect(() => {
    if (!queued) return;
    const timeout = setTimeout(() => {
      setQueued(false);
      searching.current = false;
      getSocket().emit('location:match:cancel', { difficulty: searchDifficulty.current });
      setError(t('location.matchTimedOut'));
    }, QUEUE_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [queued, t]);

  useEffect(() => {
    if (
      pending &&
      room &&
      (room.myGuess || room.round !== pending.round || room.status === 'round_over' || room.status === 'finished')
    ) {
      setPending(null);
      try {
        sessionStorage.removeItem(pendingKey);
      } catch {
        /* optional */
      }
    }
  }, [room, pending, pendingKey]);

  useEffect(() => {
    if (!codeCopied) return;
    const timer = setTimeout(() => setCodeCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [codeCopied]);

  const run = async (action: () => Promise<void>, retryAfterLeaving = false): Promise<void> => {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      if (current !== generation.current) return;
      const occupied = occupiedOf(e);
      if (occupied && retryAfterLeaving) {
        setBusy(false);
        if ((await promptOccupied(occupied)) === 'left') await run(action, false);
        return;
      }
      setError(message(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  /** Acknowledged member actions: v1 returns the view, v2 only the new revision. */
  const acknowledge = (result: unknown, roomId: string) => {
    if (result && typeof result === 'object' && 'players' in result) {
      acceptView(result as RoomView | RoomViewV2);
      return;
    }
    const revision = (result as { revision?: number } | null)?.revision;
    if (typeof revision !== 'number') return;
    // The patch normally arrives before the acknowledgement; resync if it was lost.
    setTimeout(() => {
      const base = roomRef.current;
      if (base?.id === roomId && base.revision < revision) void fetchState(roomId).catch(() => undefined);
    }, 1500);
  };

  const action = (event: string, extra: Record<string, unknown> = {}) => {
    const current = generation.current;
    const roomId = room!.id;
    return run(async () => {
      const result = await roomAction<unknown>(event, { roomId, ...extra });
      if (current === generation.current) acknowledge(result, roomId);
    });
  };

  const send = (input: AnswerInput) => {
    const current = generation.current;
    const id = room?.id;
    if (!id) return;
    setPending(input);
    try {
      sessionStorage.setItem(pendingKey, JSON.stringify({ roomId: id, input }));
    } catch {
      /* optional */
    }
    return run(async () => {
      try {
        const result = await roomAction<unknown>('location:room:answer', { roomId: id, ...input });
        if (current === generation.current) acknowledge(result, id);
      } catch (e) {
        const errorCode = (e as { code?: string }).code;
        if (
          current === generation.current &&
          errorCode &&
          !['LOCATION_BUSY', 'REDIS_UNAVAILABLE', 'INTERNAL_ERROR', 'RATE_LIMITED'].includes(errorCode)
        ) {
          setPending(null);
          try {
            sessionStorage.removeItem(pendingKey);
          } catch {
            /* optional */
          }
          await fetchState(id);
        }
        throw e;
      }
    });
  };

  // Stable callback: the question panel and radar do not re-render for every patch.
  const answerRef = useRef<(guess: Guess) => void>(() => undefined);
  answerRef.current = (guess: Guess) => {
    const current = roomRef.current;
    if (!current) return;
    void send({ ...guess, round: current.round, version: current.round, requestId: crypto.randomUUID() });
  };
  const answer = useCallback((guess: Guess) => answerRef.current(guess), []);

  const enterRoom = (event: 'location:room:create' | 'location:room:join', payload: Record<string, unknown>) =>
    run(async () => {
      await negotiateRoomProtocols();
      acceptView(await roomAction<RoomView | RoomViewV2>(event, payload));
    }, true);

  const toggleMatch = () =>
    run(async () => {
      if (queued) {
        await roomAction('location:match:cancel', { difficulty: searchDifficulty.current });
        setQueued(false);
        searching.current = false;
        return;
      }
      if (!matchmakingAllowed.current) {
        setError(t('errors.EMAIL_VERIFICATION_REQUIRED'));
        return;
      }
      await negotiateRoomProtocols();
      searchDifficulty.current = matchDifficulty;
      const result = await roomAction<{ room?: RoomView | RoomViewV2; queued?: boolean }>('location:match:join', { difficulty: matchDifficulty });
      if (result.room) acceptView(result.room);
      else {
        setQueued(true);
        searching.current = true;
      }
    }, true);

  const me = room?.players.find((player) => player.key === room.me);
  const own = room?.results.find((result) => result.key === room.me);
  const viewed = room?.results.find((result) => result.key === selectedPlayer) || own;

  const resetRoom = () => {
    roomRef.current = null;
    mapsRef.current = { hash: null, maps: [] };
    setRoom(null);
    setPending(null);
    storeRoomId(null);
    try {
      sessionStorage.removeItem(pendingKey);
    } catch {
      /* optional */
    }
  };

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
      resetRoom();
    });
  };

  const startBlocked = room && room.status === 'waiting'
    ? room.players.length < 2
      ? t('location.startNeedsPlayers')
      : !room.players.every((p) => p.ready && p.connected)
        ? t('location.startNeedsReady')
        : ''
    : '';

  const statusBar = room ? (
    <>
      <Users size={14} aria-hidden="true" />
      <strong className="location-room-code">
        {room.id}
        <button
          className="btn btn-ghost btn-sm"
          aria-label={t(codeCopied ? 'location.roomCodeCopied' : 'location.copyRoomCode')}
          onClick={() =>
            void navigator.clipboard
              .writeText(room.id)
              .then(() => setCodeCopied(true))
              .catch(() => undefined)
          }
        >
          {codeCopied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <span className="sr-only" aria-live="polite">{codeCopied ? t('location.roomCodeCopied') : ''}</span>
      </strong>
      <span>
        {room.round ? t('location.round', { round: room.round }) : t('location.waiting')}
      </span>
      <RoomCountdown clock deadline={room.startsAt || room.endsAt || room.nextAt} offset={offset} />
      <span className="location-status-meta">{t(`location.${room.difficulty}`)}</span>
      {!['finished', 'cancelled'].includes(room.status) && (
        <button className="btn btn-ghost btn-sm location-abandon" disabled={busy} onClick={() => void leave()}>
          <LogOut size={14} aria-hidden="true" />
          <span className="btn-text">{t('location.leaveRoom')}</span>
        </button>
      )}
    </>
  ) : undefined;

  return (
    <Page
      title={t('location.mapMultiplayer')}
      className="location-page location-play-page location-multi-page"
      icon={<Users size={18} />}
      statusBar={statusBar}
      actions={
        <Link className="btn btn-ghost btn-sm" to="/entertainment/location" aria-label={t('location.title')}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span className="btn-text">{t('location.title')}</span>
        </Link>
      }
    >
      {occupiedDialog}
      {(error || pending) && (error || !busy) && (
        <div className="location-alert" role="alert">
          <span>{error || t('location.pendingAnswer')}</span>
          {pending && (
            <button className="btn btn-sm" disabled={busy} onClick={() => void send(pending)}>
              <RotateCcw size={14} aria-hidden="true" />
              {t('location.retry')}
            </button>
          )}
        </div>
      )}
      {!room ? (
        <section className="location-lobby">
          <p className="muted single-lobby-subtitle">{t('location.roomHelp')}</p>
          <div className="lobby-grid location-lobby-grid">
            <div className="card multi-lobby-create-card">
              <h3>
                <House size={16} aria-hidden="true" />
                {t('location.createRoom')}
              </h3>
              <DifficultySelect variant="pills" value={difficulty} onChange={setDifficulty} disabled={busy || queued} />
              <div className="option-row" role="group" aria-label={t('location.duration')}>
                <span className="opt-label">{t('location.duration')}</span>
                {[60, 120, 180].map((seconds) => (
                  <button
                    type="button"
                    key={seconds}
                    className={`opt-btn ${duration === seconds ? 'active' : ''}`}
                    aria-pressed={duration === seconds}
                    disabled={busy || queued}
                    onClick={() => setDuration(seconds)}
                  >
                    {t('location.seconds', { count: seconds })}
                  </button>
                ))}
              </div>
              <div className="location-card-action">
                <button
                  className="btn btn-lg location-start"
                  disabled={busy || queued}
                  onClick={() => void enterRoom('location:room:create', { difficulty, duration })}
                >
                  <Zap size={16} aria-hidden="true" />
                  {t('location.createRoom')}
                </button>
              </div>
            </div>
            <div className="card multi-lobby-match-card">
              <h3>
                <Dices size={16} aria-hidden="true" />
                {t('location.quickMatch')}
              </h3>
              <p className="muted">{t('location.quickMatchHelp')}</p>
              {authInitialized && !canUseMatchmaking && (
                <p className="muted matchmaking-requirement">{t('multi.matchVerifiedRequired')}</p>
              )}
              <DifficultySelect variant="pills" value={matchDifficulty} onChange={setMatchDifficulty} disabled={busy || queued} />
              <div className="location-card-action">
                {queued && (
                  <p role="status" className="location-searching">
                    <span className="spinner matchmaking-spinner" aria-hidden="true" />
                    {t('location.searching')}
                  </p>
                )}
                <button
                  className={queued ? 'btn btn-ghost' : 'btn btn-accent btn-lg'}
                  disabled={busy || (!queued && (!authInitialized || !canUseMatchmaking))}
                  onClick={() => void toggleMatch()}
                >
                  {queued ? <XCircle size={15} aria-hidden="true" /> : <Dices size={16} aria-hidden="true" />}
                  {t(queued ? 'location.cancelMatch' : 'location.quickMatch')}
                </button>
              </div>
            </div>
            <div className="card multi-lobby-join-card">
              <h3>
                <DoorOpen size={16} aria-hidden="true" />
                {t('location.joinRoom')}
              </h3>
              <p className="muted">{t('location.joinHelp')}</p>
              <div className="join-room-form location-join">
                <input
                  className="input"
                  aria-label={t('location.roomCode')}
                  placeholder={t('location.roomCode')}
                  maxLength={5}
                  autoComplete="off"
                  value={code}
                  disabled={busy || queued}
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                />
                <button
                  className="btn btn-success"
                  disabled={busy || queued || code.length !== 5}
                  onClick={() => void enterRoom('location:room:join', { roomId: code })}
                >
                  <DoorOpen size={15} aria-hidden="true" />
                  {t('location.joinRoom')}
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <>
          <div className="location-player-strip">
            {[...room.players]
              .sort((a, b) => Number(a.retired) - Number(b.retired) || b.score - a.score)
              .map((player) => (
                <div key={player.key} className={player.key === room.me ? 'me' : ''}>
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
            <label className="location-player-pins">
              {t('location.playerPins')}
              <select className="input" value={viewed?.key || room.me} onChange={(e) => setSelectedPlayer(e.target.value)}>
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
              <button className="btn" disabled={busy} onClick={() => void action('location:room:ready', { ready: !me?.ready })}>
                {t(me?.ready ? 'location.unready' : 'location.ready')}
              </button>
              {room.host === room.me && (
                <button
                  className="btn btn-green location-start"
                  disabled={busy || Boolean(startBlocked)}
                  aria-describedby={startBlocked ? 'location-start-blocked' : undefined}
                  onClick={() => void action('location:room:start')}
                >
                  {t('location.startMatch')}
                </button>
              )}
              {room.host === room.me && startBlocked && (
                <p id="location-start-blocked" className="muted location-start-blocked">{startBlocked}</p>
              )}
            </div>
          ) : room.status === 'finished' && viewed ? (
            <Results
              results={viewed.rounds}
              score={room.players.find((p) => p.key === viewed.key)?.score || 0}
              playerName={viewed.key === room.me ? undefined : viewed.name}
            />
          ) : room.status === 'cancelled' ? (
            <section className="card location-room-cancelled" role="status">
              <h2>{t('location.cancelled')}</h2>
              <p className="muted">{t('location.cancelledHelp')}</p>
              <button className="btn btn-lg" onClick={resetRoom}>
                <ArrowLeft size={16} aria-hidden="true" />
                {t('location.backToLobby')}
              </button>
            </section>
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
                  <RoomCountdown label={t('location.preparing')} deadline={room.startsAt} offset={offset} />
                )}
                <p className="location-rules-note">
                  {t(me?.submitted ? 'location.waitingAnswers' : 'location.timeoutNotice')}
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
          {room.status === 'finished' && (
            <div className="location-card-action">
              <button className="btn" onClick={resetRoom}>
                <ArrowLeft size={16} aria-hidden="true" />
                {t('location.backToLobby')}
              </button>
            </div>
          )}
        </>
      )}
      <div className="location-rules-entry">
        <GameRules variant="location" />
      </div>
    </Page>
  );
}
