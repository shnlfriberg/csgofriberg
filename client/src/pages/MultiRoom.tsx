import { Ref, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Globe,
  Crown,
  WifiOff,
  Check,
  Hourglass,
  Swords,
  DoorOpen,
  Play,
  Eye,
  EyeOff,
  Timer,
  SkipForward,
  RotateCcw,
  X,
  CircleAlert,
  AlertTriangle,
  Trophy,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import Page from '../components/Page';
import GuessBoard from '../components/GuessBoard';
import GuessInputBar from '../components/GuessInputBar';
import AnswerOverlay, { AnswerInfo } from '../components/AnswerOverlay';
import { getSocket } from '../api/socket';
import { translate } from '../i18n/messages';
import {
  GuessFeedback,
  MultiplayerGuessFeedback,
  RoomPatch,
  RoomState,
  RoomPlayer,
} from '../types';
import { useConfirm } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { difficultyLabel } from '../utils/difficulty';
import PlayerStatsDialog, { type PlayerStatsView } from '../components/PlayerStatsDialog';
import ModalPortal from '../components/ModalPortal';

interface RoundOver {
  winnerKey: string | null;
  reason: string;
  nextRoundAt: number | null;
  answer: AnswerInfo | null;
}

interface MatchOver {
  winnerKey: string | null;
  reason: string;
  answer: AnswerInfo | null;
}

interface RelayAbort {
  reason: 'player_left' | 'disconnect_timeout';
  playerKey: string;
}

const ROUND_TIME_MS = 120_000;
const NEXT_ROUND_DELAY_MS = 6_000;

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

function isVisibleGuess(feedback: MultiplayerGuessFeedback): feedback is GuessFeedback {
  return !('hidden' in feedback);
}

function matchmakingAverageClass(value: number | null | undefined): string {
  if (value == null) return '';
  if (value < 3.5) return ' matchmaking-average-low';
  if (value <= 4.5) return ' matchmaking-average-medium';
  return ' matchmaking-average-high';
}

export function resolveGuessCooldownMs(serverValue: unknown, roomValue: number): number {
  return typeof serverValue === 'number' && Number.isFinite(serverValue)
    ? Math.max(0, serverValue)
    : Math.max(0, roomValue);
}

function applyRoomPatchState(current: RoomState, patch: RoomPatch): RoomState {
  const removedPlayers = new Set(patch.players?.removed ?? []);
  let players = current.players
    .filter((player) => !removedPlayers.has(player.key))
    .map((player) => {
      const update = patch.players?.updated?.find((candidate) => candidate.key === player.key);
      return update ? { ...player, ...update } : player;
    });
  for (const added of patch.players?.added ?? []) {
    const index = players.findIndex((player) => player.key === added.key);
    if (index >= 0) players[index] = added;
    else players = [...players, added];
  }

  return {
    ...current,
    stateVersion: patch.stateVersion,
    hostKey: patch.hostKey ?? current.hostKey,
    players,
    spectatorCount: patch.spectatorCount ?? current.spectatorCount,
  };
}

function matchOverReason(
  result: MatchOver,
  viewerKey: string,
  isSpectator: boolean,
  t: TFunction
): string {
  if (result.reason === 'score') return t('multi.matchReasons.score');
  if (result.reason === 'opponent_left') {
    if (isSpectator) return t('multi.matchReasons.sideLeft');
    return result.winnerKey === viewerKey ? t('multi.matchReasons.opponentLeft') : t('multi.matchReasons.selfLeft');
  }
  if (result.reason === 'disconnect_timeout') {
    if (result.winnerKey == null) return t('multi.matchReasons.bothDisconnected');
    if (isSpectator) return t('multi.matchReasons.sideTimeout');
    return result.winnerKey === viewerKey ? t('multi.matchReasons.opponentTimeout') : t('multi.matchReasons.selfTimeout');
  }
  return result.reason;
}

const ROUND_OVER_REASON: Record<string, string> = {
  guessed: 'multi.roundReasons.guessed',
  exhausted: 'multi.roundReasons.exhausted',
  timeout: 'multi.roundReasons.timeout',
  skipped: 'multi.roundReasons.skipped',
  surrender: 'multi.roundReasons.surrender',
};

/** 使用浏览器单调时钟显示服务端校准后的截止时间。 */
function Countdown({ deadline, onExpire }: { deadline: number | null; onExpire?: () => void }) {
  const [left, setLeft] = useState(0);
  const expired = useRef(false);
  useEffect(() => {
    expired.current = false;
    if (!deadline) {
      setLeft(0);
      return;
    }
    const tick = () => {
      const next = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
      setLeft(next);
      if (next === 0 && !expired.current) {
        expired.current = true;
        onExpire?.();
      }
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [deadline, onExpire]);
  if (!deadline) return null;
  const m = Math.floor(left / 60);
  const s = left % 60;
  return (
    <span className={`countdown ${left <= 15 ? 'urgent' : ''}`}>
      <Timer size={15} />
      {m}:{String(s).padStart(2, '0')}
    </span>
  );
}

function GuessCooldownStatus({ until }: { until: number }) {
  const { t } = useTranslation();
  const [remaining, setRemaining] = useState(() => Math.max(0, until - performance.now()));
  useEffect(() => {
    const initial = Math.max(0, until - performance.now());
    setRemaining(initial);
    if (initial <= 0) return;
    const timer = window.setInterval(() => {
      const next = Math.max(0, until - performance.now());
      setRemaining(next);
      if (next <= 0) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [until]);
  if (remaining <= 0) return null;
  return <>{t('multi.cooldown', { seconds: (remaining / 1000).toFixed(1) })}</>;
}

function PlayerBoard({
  player,
  room,
  title,
  isSelf = false,
  endRef,
}: {
  player: RoomPlayer;
  room: RoomState;
  title: string;
  isSelf?: boolean;
  endRef?: Ref<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  return (
    <div className={`card player-board${isSelf ? ' player-board-self' : ' player-board-opponent'}`} style={{ margin: 0 }}>
      <h3>
        {title}
        <span className="muted" style={{ fontWeight: 400 }}>
          {player.guessCount}/{room.maxGuesses}
        </span>
        {!player.connected && (
          <span className="badge red">
            <WifiOff size={12} />
            {t('multi.offline')}
          </span>
        )}
        {player.skipped && <span className="badge"><SkipForward size={12} />{t('multi.roundSkipped')}</span>}
      </h3>
      {player.guesses.length ? (
        <GuessBoard guesses={player.guesses} />
      ) : (
        <p className="muted">{t('multi.noGuesses')}</p>
      )}
      {endRef && <div className="guess-list-end" ref={endRef} aria-hidden="true" />}
    </div>
  );
}

export default function MultiRoom() {
  const { t } = useTranslation();
  const [room, setRoom] = useState<RoomState | null>(null);
  const [roundOver, setRoundOver] = useState<RoundOver | null>(null);
  const [matchOver, setMatchOver] = useState<MatchOver | null>(null);
  const [matchOverVisible, setMatchOverVisible] = useState(false);
  const [relayAbort, setRelayAbort] = useState<RelayAbort | null>(null);
  const [replayRoundIndex, setReplayRoundIndex] = useState<number | null>(null);
  const [offlineNote, setOfflineNote] = useState('');
  const [showRoomCode, setShowRoomCode] = useState(false);
  const [myKey, setMyKey] = useState('');
  const [roundExpired, setRoundExpired] = useState(false);
  const [skipBusy, setSkipBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [rematchBusy, setRematchBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportDescription, setReportDescription] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const reportDialogRef = useRef<HTMLDivElement>(null);
  const [rematchNotice, setRematchNotice] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const [guessCooldownUntil, setGuessCooldownUntil] = useState(0);
  const [roundDeadline, setRoundDeadline] = useState<number | null>(null);
  const [nextRoundDeadline, setNextRoundDeadline] = useState<number | null>(null);
  const [readyDeadline, setReadyDeadline] = useState<number | null>(null);
  const [statsLoadingKey, setStatsLoadingKey] = useState('');
  const [playerStats, setPlayerStats] = useState<PlayerStatsView | null>(null);
  const [opponentPreview, setOpponentPreview] = useState<PlayerStatsView | null>(null);
  const navigate = useNavigate();
  const confirm = useConfirm();
  const roomRef = useRef<RoomState | null>(null);
  const myKeyRef = useRef('');
  const syncSequenceRef = useRef(0);
  const clockAnchorRef = useRef<ServerClockAnchor | null>(null);
  const activeGuessListEndRef = useRef<HTMLDivElement>(null);
  const relayAbortRef = useRef<RelayAbort | null>(null);
  roomRef.current = room;
  myKeyRef.current = myKey;
  relayAbortRef.current = relayAbort;

  const applyRoomSnapshot = useCallback((
    state: RoomState,
    authoritative = false,
    serverNow?: unknown,
    fallbackDurationMs?: number
  ) => {
    const current = roomRef.current;
    const hadMatchResult = Boolean(current?.matchResult);
    if (!authoritative && (!current || state.id !== current.id)) return;
    if (current && state.id === current.id && state.stateVersion < current.stateVersion) return;
    const receivedAnchor = createClockAnchor(serverNow);
    if (receivedAnchor) clockAnchorRef.current = receivedAnchor;
    const anchor = receivedAnchor ?? clockAnchorRef.current;
    const fallbackDeadline = fallbackDurationMs
      ? performance.now() + fallbackDurationMs
      : null;
    setRoundDeadline(state.status === 'playing'
      ? localDeadline(state.roundEndsAt, anchor) ?? fallbackDeadline
      : null);
    setNextRoundDeadline(state.status === 'round_over'
      ? localDeadline(state.roundResult?.nextRoundAt, anchor) ?? fallbackDeadline
      : null);
    setReadyDeadline(state.status === 'waiting' && state.matchmaking
      ? localDeadline(state.readyCheckEndsAt, anchor)
      : null);
    if (state.gameMode === 'relay' && state.status === 'playing') {
      const lastGuessAt = state.relayGuesses?.at(-1)?.guessedAt;
      const localLastGuessAt = localDeadline(lastGuessAt, anchor);
      setGuessCooldownUntil(localLastGuessAt ? localLastGuessAt + state.guessIntervalMs : 0);
    }
    roomRef.current = state;
    setRoom(state);
    setRoundExpired(state.status !== 'playing');
    setRoundOver(state.matchResult ? null : state.roundResult);
    setMatchOver(state.matchResult);
    if (!state.matchResult) {
      setMatchOverVisible(false);
      setReplayRoundIndex(null);
    }
    else if (!hadMatchResult) setMatchOverVisible(true);
    if (state.players.every((player) => player.connected)) setOfflineNote('');
  }, []);

  const syncRoom = useCallback((socket = getSocket()) => {
    const sequence = ++syncSequenceRef.current;
    socket.emit('room:sync', {}, (res: any) => {
      if (sequence !== syncSequenceRef.current) return;
      if (res?.selfKey) setMyKey(res.selfKey);
      if (res?.room) applyRoomSnapshot(res.room, true, res.serverNow);
    });
  }, [applyRoomSnapshot]);

  useEffect(() => {
    const socket = getSocket();
    const onPatch = (patch: RoomPatch) => {
      setRoom((current) => {
        if (!current || current.id !== patch.roomId) return current;
        if (patch.stateVersion <= current.stateVersion) return current;
        if (patch.baseVersion !== current.stateVersion) {
          syncRoom(socket);
          return current;
        }
        const next = applyRoomPatchState(current, patch);
        roomRef.current = next;
        if (next.players.every((player) => player.connected)) setOfflineNote('');
        return next;
      });
    };
    const onRoundStart = (p: { room: RoomState; serverNow?: number }) => {
      setGuessCooldownUntil(0);
      setRoundOver(null);
      setMatchOverVisible(false);
      setReplayRoundIndex(null);
      setOfflineNote('');
      setRematchNotice('');
      setRoundExpired(false);
      applyRoomSnapshot(p.room, false, p.serverNow, ROUND_TIME_MS);
    };
    const onRoundOver = (p: { room: RoomState; serverNow?: number }) => {
      setGuessCooldownUntil(0);
      setRoundExpired(true);
      applyRoomSnapshot(p.room, false, p.serverNow, NEXT_ROUND_DELAY_MS);
    };
    const onMatchOver = (p: { room: RoomState; serverNow?: number }) => {
      setGuessCooldownUntil(0);
      setRoundExpired(true);
      setRoundOver(null);
      setRematchNotice('');
      applyRoomSnapshot(p.room, false, p.serverNow);
    };
    const onRelayAborted = (p: {
      roomId: string;
      reason: RelayAbort['reason'];
      playerKey: string;
    }) => {
      if (roomRef.current?.id !== p.roomId) return;
      const aborted = { reason: p.reason, playerKey: p.playerKey };
      relayAbortRef.current = aborted;
      setRelayAbort(aborted);
      setGuessCooldownUntil(0);
      setRoundExpired(true);
      setRoundOver(null);
      setMatchOver(null);
      setMatchOverVisible(false);
      setOfflineNote('');
    };
    const onReadyEnded = (p: {
      roomId: string;
      reason: 'timeout' | 'opponent_left';
      penalized: boolean;
      retryAt: number | null;
      serverNow?: number;
    }) => {
      if (roomRef.current?.id !== p.roomId) return;
      roomRef.current = null;
      setRoom(null);
      if (p.reason === 'opponent_left') {
        toast.error(t('multi.readyOpponentLeft'));
      } else if (p.penalized) {
        const seconds = p.retryAt && p.serverNow
          ? Math.max(1, Math.ceil((p.retryAt - p.serverNow) / 1000))
          : 10;
        toast.error(t('multi.readyTimedOutPenalized', { seconds }));
      } else {
        toast.error(t('multi.readyTimedOutOpponent'));
      }
      navigate('/multi');
    };
    const onRematchUpdate = (p: {
      roomId: string;
      stateVersion: number;
      outcome: 'invited' | 'cancelled' | 'declined' | 'accepted';
      actorKey: string;
      player?: { key: string; connected: boolean };
    }) => {
      setRoom((current) => {
        if (!current || current.id !== p.roomId) return current;
        if (p.stateVersion <= current.stateVersion) return current;
        if (p.stateVersion !== current.stateVersion + 1) {
          syncRoom(socket);
          return current;
        }
        const next: RoomState = p.outcome === 'accepted'
          ? {
              ...current,
              status: 'waiting',
              matchmaking: false,
              readyCheckEndsAt: null,
              round: 0,
              roundId: 0,
              roundEndsAt: null,
              rematchInvite: null,
              roundResult: null,
              matchResult: null,
              matchReplay: undefined,
              players: current.players.map((player) => ({
                ...player,
                ready: player.key === current.hostKey,
                score: 0,
                skipped: false,
                guessCount: 0,
                guesses: [],
              })),
              stateVersion: p.stateVersion,
            }
          : {
              ...current,
              rematchInvite: p.outcome === 'invited'
                ? { inviterKey: p.actorKey }
                : null,
              players: p.player
                ? current.players.map((player) => player.key === p.player!.key
                  ? { ...player, connected: p.player!.connected }
                  : player)
                : current.players,
              stateVersion: p.stateVersion,
            };
        roomRef.current = next;
        return next;
      });
      if (p.outcome === 'accepted') {
        setGuessCooldownUntil(0);
        setRoundExpired(true);
        setRoundOver(null);
        setMatchOver(null);
        setMatchOverVisible(false);
        setReplayRoundIndex(null);
        setOfflineNote('');
      }
      const actorIsMe = p.actorKey === myKeyRef.current;
      if (p.outcome === 'invited') {
        setRematchNotice(actorIsMe ? t('multi.rematchInvitedSelf') : t('multi.rematchInvitedOther'));
      } else if (p.outcome === 'cancelled') {
        setRematchNotice(actorIsMe ? t('multi.rematchCancelledSelf') : t('multi.rematchCancelledOther'));
      } else if (p.outcome === 'declined') {
        setRematchNotice(actorIsMe ? t('multi.rematchDeclinedSelf') : t('multi.rematchDeclinedOther'));
      } else {
        setRematchNotice(
          roomRef.current?.hostKey === myKeyRef.current
            ? t('multi.rematchAcceptedHost')
            : t('multi.rematchAcceptedGuest')
        );
      }
    };
    const onOffline = (p: { key: string; graceMs: number }) => {
      if (p.key !== myKeyRef.current) {
        const name = roomRef.current?.players.find((player) => player.key === p.key)?.name ?? t('multi.opponent');
        setOfflineNote(t('multi.offlineGrace', { player: name, seconds: Math.round(p.graceMs / 1000) }));
      }
    };
    const onRoomError = (p: { code: string }) => toast.error(translate(p.code));
    const onIdentity = (p: { key: string }) => setMyKey(p.key);
    const onGuessApplied = (p: {
      roomId: string;
      roundId: number;
      key: string;
      stateVersion: number;
      feedback: MultiplayerGuessFeedback;
      guessedAt?: number;
      currentTurnKey?: string | null;
      serverNow?: number;
    }) => {
      setRoom((current) => {
        if (!current || current.id !== p.roomId || current.roundId !== p.roundId) return current;
        if (p.stateVersion <= current.stateVersion) return current;
        if (p.stateVersion !== current.stateVersion + 1) {
          syncRoom(socket);
          return current;
        }
        const feedback = p.feedback;
        if (current.gameMode === 'relay' && !isVisibleGuess(feedback)) {
          syncRoom(socket);
          return current;
        }
        const relayFeedback = isVisibleGuess(feedback) ? feedback : null;
        const relayGuesses = current.gameMode === 'relay' && relayFeedback
          ? [
              ...(current.relayGuesses ?? []),
              { actorKey: p.key, guessedAt: p.guessedAt ?? Date.now(), feedback: relayFeedback },
            ]
          : current.relayGuesses;
        const next: RoomState = {
          ...current,
          stateVersion: p.stateVersion,
          currentTurnKey: current.gameMode === 'relay'
            ? p.currentTurnKey ?? null
            : current.currentTurnKey,
          relayGuesses,
          players: current.players.map((player) => {
            if (player.key !== p.key) return player;
            return {
              ...player,
              guesses: [...player.guesses, feedback],
              guessCount: player.guessCount + 1,
            };
          }),
        };
        roomRef.current = next;
        if (current.gameMode === 'relay') {
          const anchor = createClockAnchor(p.serverNow) ?? clockAnchorRef.current;
          const localGuessedAt = localDeadline(p.guessedAt, anchor);
          setGuessCooldownUntil(localGuessedAt ? localGuessedAt + current.guessIntervalMs : 0);
        }
        return next;
      });
    };
    socket.on('room:patch', onPatch);
    socket.on('round:start', onRoundStart);
    socket.on('round:over', onRoundOver);
    socket.on('match:over', onMatchOver);
    socket.on('relay:aborted', onRelayAborted);
    socket.on('match:ready-ended', onReadyEnded);
    socket.on('match:rematch:update', onRematchUpdate);
    socket.on('player:offline', onOffline);
    socket.on('room:error', onRoomError);
    socket.on('game:guess:applied', onGuessApplied);
    socket.on('identity:self', onIdentity);

    // 关闭/刷新页面时立刻断开 socket,让对手第一时间收到离线通知
    const onPageHide = () => socket.disconnect();
    // 切回页面(含 bfcache 恢复/移动端切回)时重连并重新同步房间状态
    const resync = () => {
      const s = getSocket(); // 内部会对手动断开的 socket 执行 connect()
      syncRoom(s);
    };
    const onPageShow = () => resync();
    const onVisible = () => {
      if (document.visibilityState === 'visible') resync();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisible);
    // socket 层重连成功后也刷新一次(如网络闪断自动恢复)
    socket.on('connect', resync);

    // 主动向服务端同步一次房间状态;确认不在任何房间才回大厅
    const initialSequence = ++syncSequenceRef.current;
    socket.emit('room:sync', {}, (res: any) => {
      if (initialSequence !== syncSequenceRef.current) return;
      if (res?.selfKey) setMyKey(res.selfKey);
      if (res?.room) applyRoomSnapshot(res.room, true, res.serverNow);
      else if (!roomRef.current && !relayAbortRef.current) {
        const code = res?.code === 'NOT_IN_ROOM' ? 'ROOM_NOT_FOUND' : res?.code ?? 'ROOM_NOT_FOUND';
        toast.error(translate(code));
        navigate('/multi');
      }
    });
    return () => {
      socket.off('room:patch', onPatch);
      socket.off('round:start', onRoundStart);
      socket.off('round:over', onRoundOver);
      socket.off('match:over', onMatchOver);
      socket.off('relay:aborted', onRelayAborted);
      socket.off('match:ready-ended', onReadyEnded);
      socket.off('match:rematch:update', onRematchUpdate);
      socket.off('player:offline', onOffline);
      socket.off('room:error', onRoomError);
      socket.off('game:guess:applied', onGuessApplied);
      socket.off('identity:self', onIdentity);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisible);
      socket.off('connect', resync);
    };
  }, [applyRoomSnapshot, navigate, syncRoom, t]);

  const emit = (event: string, payload: unknown = {}) => {
    getSocket().emit(event, payload, (res: any) => {
      if (res?.code) toast.error(translate(res.code));
      if (res?.room) applyRoomSnapshot(res.room);
    });
  };

  const submitGuess = (playerId: number): Promise<boolean> => new Promise((resolve) => {
    const current = roomRef.current;
    if (!current || current.status !== 'playing' || roundExpired) return resolve(false);
    const remaining = guessCooldownUntil - performance.now();
    if (remaining > 0) {
      return resolve(false);
    }
    const socket = getSocket();
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return false;
      settled = true;
      resolve(accepted);
      return true;
    };
    const timer = window.setTimeout(() => {
      if (!finish(false)) return;
      toast.error(translate('NETWORK_ERROR'));
      syncRoom(socket);
    }, 5_000);
    socket.emit('game:guess', {
      playerId,
      roundId: current.roundId,
      eventId: crypto.randomUUID(),
    }, (res: any) => {
      if (settled) return;
      window.clearTimeout(timer);
      if (res?.room) applyRoomSnapshot(res.room);
      if (res?.code === 'GUESS_COOLDOWN') {
        setGuessCooldownUntil(performance.now() + Math.max(0, Number(res.retryAfterMs) || 0));
        finish(false);
        return;
      }
      if (res?.code === 'NO_ACTIVE_ROUND' || res?.code === 'STALE_ROUND') {
        syncRoom(socket);
        finish(false);
        return;
      }
      if (res?.code === 'ROOM_BUSY') {
        syncRoom(socket);
        finish(false);
        return;
      }
      if (res?.code) {
        toast.error(translate(res.code));
        finish(false);
        return;
      }
      setGuessCooldownUntil(performance.now() + resolveGuessCooldownMs(
        res?.cooldownMs,
        current.guessIntervalMs
      ));
      finish(true);
    });
  });

  const leaveRoom = async () => {
    const currentRoom = room;
    if (!currentRoom || leaving) return;
    const isCurrentSpectator = !currentRoom.players.some((player) => player.key === myKey);
    const isMatchmakingReadyRoom =
      !isCurrentSpectator &&
      currentRoom.matchmaking &&
      currentRoom.status === 'waiting';
    const matchOngoing =
      !isCurrentSpectator &&
      (currentRoom.status === 'playing' || currentRoom.status === 'round_over');
    if (isMatchmakingReadyRoom) {
      if (!await confirm({
        title: t('multi.readyExitTitle'),
        message: t('multi.readyExitWarning'),
        confirmLabel: t('multi.readyExitConfirm'),
        tone: 'warning',
      })) return;
    } else if (matchOngoing && !await confirm({
      title: t('multi.leaveTitle'),
      message: t('multi.leaveMessage'),
      confirmLabel: t('multi.leaveConfirm'),
      tone: 'danger',
    })) return;
    setLeaving(true);
    const socket = getSocket();
    const result = await new Promise<any>((resolve) => {
      let settled = false;
      const finish = (value: any) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = window.setTimeout(() => finish({ code: 'NETWORK_ERROR' }), 5_000);
      socket.emit('room:leave', {}, (res: any) => {
        window.clearTimeout(timer);
        finish(res ?? { ok: true });
      });
    });
    if (result?.code) {
      setLeaving(false);
      toast.error(translate(result.code));
      return;
    }
    const retryAt = Number(result?.retryAt);
    const serverNow = Number(result?.serverNow);
    const matchmakingCooldownUntil =
      result?.retryAt != null &&
      result?.serverNow != null &&
      Number.isFinite(retryAt) &&
      Number.isFinite(serverNow)
        ? Date.now() + Math.max(0, retryAt - serverNow)
        : null;
    setRoom(null);
    roomRef.current = null;
    navigate('/multi', {
      state: matchmakingCooldownUntil ? { matchmakingCooldownUntil } : null,
    });
  };

  const returnFromRelayAbort = () => {
    relayAbortRef.current = null;
    setRelayAbort(null);
    roomRef.current = null;
    setRoom(null);
    navigate('/multi');
  };

  const skipRound = async () => {
    const current = roomRef.current;
    const currentMe = current?.players.find((player) => player.key === myKeyRef.current);
    if (!current || current.status !== 'playing' || !currentMe || currentMe.skipped || skipBusy) return;
    if (!await confirm({
      title: t('multi.skipTitle'),
      message: t('multi.skipMessage'),
      confirmLabel: t('multi.skipConfirm'),
      tone: 'warning',
    })) return;
    setSkipBusy(true);
    getSocket().emit('game:skip-round', { roundId: current.roundId }, (res: any) => {
      setSkipBusy(false);
      if (res?.room) applyRoomSnapshot(res.room);
      if (res?.code === 'NO_ACTIVE_ROUND' || res?.code === 'STALE_ROUND') {
        syncRoom();
        return;
      }
      if (res?.code) toast.error(translate(res.code));
    });
  };

  const updateRematch = (event: string, payload: unknown = {}) => {
    if (rematchBusy) return;
    setRematchBusy(true);
    const socket = getSocket();
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      setRematchBusy(false);
      toast.error(translate('NETWORK_ERROR'));
      syncRoom(socket);
    }, 5_000);
    socket.emit(event, payload, (res: any) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      setRematchBusy(false);
      if (res?.code) toast.error(translate(res.code));
    });
  };

  const me = room?.players.find((p) => p.key === myKey);
  const opponent = room?.players.find((p) => p.key !== myKey);
  const isSpectator = !!room && !me;
  const isHost = room?.hostKey === myKey;
  const playing = room?.status === 'playing';
  const rematchInviterKey = room?.rematchInvite?.inviterKey ?? null;
  const canRematch = Boolean(
    room?.rematchAllowed &&
    room.status === 'finished' &&
    me &&
    room.players.length === 2 &&
    room.players.every((player) => player.connected)
  );
  const viewFinishedMatch = () => {
    if (!room?.matchReplay) {
      setMatchOverVisible(false);
      return;
    }
    setMatchOverVisible(false);
    setReplayRoundIndex(0);
  };
  const viewPlayerStats = (player: RoomPlayer) => {
    if (statsLoadingKey) return;
    if (opponentPreview?.displayId === player.name) {
      setPlayerStats(opponentPreview);
      return;
    }
    setStatsLoadingKey(player.key);
    const socket = getSocket();
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      setStatsLoadingKey('');
      toast.error(translate('NETWORK_ERROR'));
    }, 5_000);
    socket.emit('room:player-stats', { playerKey: player.key }, (res: any) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      setStatsLoadingKey('');
      if (res?.code) {
        toast.error(translate(res.code));
        return;
      }
      if (!res?.stats || res.playerKey !== player.key) {
        toast.error(translate('INTERNAL_ERROR'));
        return;
      }
      setPlayerStats({ displayId: res.displayId, stats: res.stats });
    });
  };

  const statsButton = (player: RoomPlayer | undefined) => {
    const allowed = Boolean(player && (isSpectator || (me && player.key !== myKey)));
    if (!player || !allowed) return null;
    const loading = statsLoadingKey === player.key;
    return (
      <button
        type="button"
        className="player-stats-trigger"
        aria-label={t('multi.viewPlayerStats', { player: player.name })}
        title={t('multi.viewStats')}
        disabled={Boolean(statsLoadingKey)}
        onClick={() => viewPlayerStats(player)}
      >
        {loading ? <span className="player-stats-spinner" /> : <CircleAlert size={16} />}
      </button>
    );
  };

  const submitReport = () => {
    if (reportBusy || !room?.matchmaking || !opponent) return;
    setReportBusy(true);
    getSocket().emit('match:report', { description: reportDescription.trim() }, (res: any) => {
      setReportBusy(false);
      if (res?.code) {
        toast.error(translate(res.code));
        return;
      }
      setReportOpen(false);
      setReportDescription('');
      applyRoomSnapshot({ ...room, reportSubmitted: true });
      toast.success(t('multi.reportSubmitted'));
    });
  };

  useEffect(() => {
    if (!reportOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusDialog = () => reportDialogRef.current?.querySelector<HTMLElement>('textarea, button, [href], input, select, [tabindex]:not([tabindex="-1"])')?.focus();
    const frame = window.requestAnimationFrame(focusDialog);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setReportOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = reportDialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [reportOpen]);

  useEffect(() => {
    if (!room?.matchmaking || room.status !== 'waiting' || !opponent) {
      setOpponentPreview(null);
      return;
    }
    let cancelled = false;
    getSocket().emit('room:player-stats', { playerKey: opponent.key }, (res: any) => {
      if (cancelled || res?.code || !res?.stats || res.playerKey !== opponent.key) return;
      setOpponentPreview({ displayId: res.displayId, stats: res.stats });
    });
    return () => {
      cancelled = true;
    };
  }, [room?.id, room?.matchmaking, room?.status, opponent?.key]);

  useEffect(() => {
    if (!inputFocused || !me || !window.matchMedia('(max-width: 640px)').matches) return;
    let frame = 0;
    const keepActiveGuessesVisible = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const anchor = activeGuessListEndRef.current;
        const scroller = anchor?.closest<HTMLElement>('.page-scroll');
        if (!anchor || !scroller) return;
        const anchorRect = anchor.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const obscuredBy = anchorRect.bottom - (scrollerRect.bottom - 8);
        if (obscuredBy > 0) scroller.scrollBy({ top: obscuredBy, behavior: 'auto' });
      });
    };
    keepActiveGuessesVisible();
    window.visualViewport?.addEventListener('resize', keepActiveGuessesVisible);
    return () => {
      window.cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener('resize', keepActiveGuessesVisible);
    };
  }, [inputFocused, me?.guessCount, room?.relayGuesses?.length, room?.roundId]);

  if (!room) {
    return (
      <Page title={t('multi.roomLoadingTitle')} icon={<Globe size={17} />}>
        <div style={{ textAlign: 'center', padding: 48 }}>
          <div className="spinner" />
          <p className="muted">{t('multi.loadingRoom')}</p>
        </div>
      </Page>
    );
  }

  const leftPlayer = me ?? room.players[0];
  const rightPlayer = me ? opponent : room.players[1];
  const replay = room.matchReplay;
  const replayRound = replayRoundIndex == null ? null : replay?.rounds[replayRoundIndex] ?? null;
  const displayedLeftPlayer = leftPlayer && replayRound
    ? { ...leftPlayer, guessCount: replayRound.me.guesses.length, guesses: replayRound.me.guesses }
    : leftPlayer;
  const displayedRightPlayer = rightPlayer && replayRound
    ? { ...rightPlayer, guessCount: replayRound.opponent.guesses.length, guesses: replayRound.opponent.guesses }
    : rightPlayer;

  return (
    <Page
      className={`game-page multi-game-page${inputFocused ? ' keyboard-active' : ''}`}
      title={room.gameMode === 'relay'
        ? t('multi.relayRoomTitle', { rounds: room.totalRounds ?? 3 })
        : t('multi.roomTitle', { bo: room.boType })}
      icon={<Globe size={17} />}
      actions={
        <div className="room-actions">
          <span className="room-code-wrap">
            <button
              type="button"
              className="room-code-toggle"
              onClick={() => setShowRoomCode((visible) => !visible)}
              title={showRoomCode ? t('multi.hideRoomCode') : t('multi.showRoomCode')}
              aria-label={showRoomCode ? t('multi.hideRoomCode') : t('multi.showRoomCode')}
              aria-pressed={showRoomCode}
            >
              {showRoomCode ? <EyeOff size={15} /> : <Eye size={15} />}
              <span>{showRoomCode ? room.id : '•••••'}</span>
            </button>
            {showRoomCode && <span className="room-code-pop">{room.id}</span>}
          </span>
          <button
            className="btn btn-danger btn-sm"
            aria-label={isSpectator ? t('multi.exitSpectating') : t('multi.leaveRoom')}
            disabled={leaving}
            onClick={() => void leaveRoom()}
          >
            <DoorOpen size={15} />
            <span className="btn-text">
              {leaving ? t('multi.leaving') : isSpectator ? t('multi.exitSpectating') : t('multi.leaveRoom')}
            </span>
          </button>
          {playing && me && room.gameMode !== 'relay' && (
            <button
              className="btn btn-ghost btn-sm"
              disabled={roundExpired || skipBusy || me.skipped}
              onClick={() => void skipRound()}
            >
              <SkipForward size={15} />
              <span className="btn-text">{skipBusy ? t('multi.processing') : me.skipped ? t('multi.roundSkipped') : t('multi.skipRound')}</span>
            </button>
          )}
          {room.status === 'finished' && matchOver && !matchOverVisible && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setMatchOverVisible(true)}
            >
              <Trophy size={15} />
              <span className="btn-text">{t('multi.viewResult')}</span>
            </button>
          )}
        </div>
      }
      statusBar={
        <>
          <Swords size={15} />
          {room.gameMode === 'relay'
            ? room.status === 'waiting'
              ? t('multi.relayWaitingStatus', { database: difficultyLabel(t, room.dbType), total: room.totalRounds ?? 3 })
              : t('multi.relayStatus', { solved: room.relaySolvedRounds, total: room.totalRounds, round: room.round })
            : room.status === 'waiting'
              ? t('multi.waitingStatus', { database: difficultyLabel(t, room.dbType), wins: room.winsNeeded })
              : t('multi.playingStatus', { round: room.round, wins: room.winsNeeded })}
          {room.status === 'waiting' && room.verifiedOnly && (
            <span className="badge amber">{t('multi.verifiedRoomOnly')}</span>
          )}
          {room.status === 'waiting' && room.matchmaking && <Countdown deadline={readyDeadline} />}
          {playing && <Countdown deadline={roundDeadline} onExpire={() => setRoundExpired(true)} />}
          {isSpectator && (
            <span className="badge">
              <Eye size={12} />
              {t('multi.spectating')}
            </span>
          )}
          {room.spectatorCount > 0 && (
            <span className="muted">
              <Eye size={12} style={{ verticalAlign: -2 }} /> {t('multi.spectatorCount', { count: room.spectatorCount })}
            </span>
          )}
          {offlineNote && <span className="error">{offlineNote}</span>}
          {rematchNotice && <span className="muted">{rematchNotice}</span>}
        </>
      }
      dock={
        playing && me ? (
          <GuessInputBar
            onPick={(p) => submitGuess(p.id)}
            onFocusChange={setInputFocused}
            statusText={room.gameMode === 'relay' && room.currentTurnKey !== myKey
              ? t('multi.waitingForTurn', {
                player: room.players.find((player) => player.key === room.currentTurnKey)?.name ?? '-',
              })
              : <GuessCooldownStatus until={guessCooldownUntil} />}
            disabled={Boolean(relayAbort) || roundExpired || me.skipped || (room.gameMode === 'relay'
              ? room.currentTurnKey !== myKey || (room.relayGuesses?.length ?? 0) >= room.maxGuesses
              : me.guessCount >= room.maxGuesses)}
          />
        ) : undefined
      }
    >
      {/* 比分栏 */}
      <div className="card score-bar">
        <span className="player-name score-bar-player-left">
          {leftPlayer?.key === room.hostKey && <Crown size={16} color="var(--warning)" />}
          <span className="player-id-text">{leftPlayer?.name ?? '-'}</span>
          {statsButton(leftPlayer)}
        </span>
        <span className="score">
          {room.gameMode === 'relay'
            ? t('multi.relayProgress', { solved: room.relaySolvedRounds, total: room.totalRounds })
            : `${leftPlayer?.score ?? 0} : ${rightPlayer?.score ?? 0}`}
        </span>
        <span className="player-name score-bar-player-right">
          {rightPlayer?.key === room.hostKey && <Crown size={16} color="var(--warning)" />}
          <span className="player-id-text">{rightPlayer?.name ?? t('multi.waitingForJoin')}</span>
          {statsButton(rightPlayer)}
        </span>
      </div>

      {replay && replayRound && replayRoundIndex != null && (
        <div className="multi-inline-replay" aria-label={t('replay.pagination')}>
          <button
            className="btn btn-ghost"
            type="button"
            aria-label={t('replay.previousRound')}
            title={t('replay.previousRound')}
            disabled={replayRoundIndex === 0}
            onClick={() => setReplayRoundIndex((current) => current == null ? 0 : Math.max(0, current - 1))}
          >
            <ChevronLeft size={17} />
          </button>
          <div className="multi-inline-replay-meta">
            <strong>{t('replay.roundPage', { current: replayRoundIndex + 1, total: replay.rounds.length })}</strong>
            <span>{t('replay.correctAnswer', { name: replayRound.answer.nickname })}</span>
            <span className="badge">
              {replayRound.winner === 'me'
                ? t('replay.meWon')
                : replayRound.winner === 'opponent'
                  ? t('replay.opponentWon')
                  : t('common.draw')}
            </span>
          </div>
          <button
            className="btn btn-ghost"
            type="button"
            aria-label={t('replay.nextRound')}
            title={t('replay.nextRound')}
            disabled={replayRoundIndex >= replay.rounds.length - 1}
            onClick={() => setReplayRoundIndex((current) => current == null
              ? 0
              : Math.min(replay.rounds.length - 1, current + 1))}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      )}

      {/* 等待区 */}
      {room.status === 'waiting' && (
        <div className="card room-waiting-card">
          {!room.matchmaking && (
            <section className="room-attributes" aria-labelledby="room-attributes-title">
              <h3 id="room-attributes-title">{t('multi.roomAttributes')}</h3>
              <ul>
                <li>{t('multi.database', { type: difficultyLabel(t, room.dbType) })}</li>
                <li>{room.gameMode === 'relay'
                  ? t('multi.relayRounds', { rounds: room.totalRounds })
                  : t('multi.format', { bo: room.boType })}</li>
                <li>{t('multi.customRulesSummary', {
                  guesses: room.maxGuesses,
                  seconds: room.guessIntervalMs / 1000,
                })}</li>
                <li>{room.allowSpectators
                  ? t('multi.allowSpectating')
                  : t('multi.denySpectating')}</li>
                <li>{room.verifiedOnly
                  ? t('multi.verifiedRoomOnly')
                  : t('multi.anyoneCanJoin')}</li>
                <li>{room.anonymous ? t('multi.anonymousRoom') : t('multi.showNames')}</li>
              </ul>
            </section>
          )}
          {room.players.map((p) => (
            <div
              key={p.key}
              className="room-player-row"
            >
              <b>{p.name}</b>
              {p.key === room.hostKey && <Crown size={15} color="var(--warning)" />}
              {statsButton(p)}
              {!p.connected && (
                <span className="badge red">
                  <WifiOff size={12} />
                  {t('multi.disconnected')}
                </span>
              )}
              {p.ready ? (
                <span className="badge green">
                  <Check size={12} />
                  {t('multi.ready')}
                </span>
              ) : (
                <span className="badge amber">
                  <Hourglass size={12} />
                  {t('multi.notReady')}
                </span>
              )}
            </div>
          ))}
          {room.players.length < 2 && (
            <p className="muted">{t('multi.waitingOpponent')}</p>
          )}
          {room.matchmaking && opponent && (
            <div className="matchmaking-opponent-preview">
              <span>{t('multi.opponentRecentWinningGuessAverage')}</span>
              <strong className={matchmakingAverageClass(
                opponentPreview?.stats.multi.recentAverageWinningGuesses
              )}>
                {opponentPreview?.stats.multi.recentAverageWinningGuesses?.toFixed(1) ?? '-'}
              </strong>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!opponentPreview}
                onClick={() => opponentPreview && setPlayerStats(opponentPreview)}
              >
                <CircleAlert size={15} />
                {t('multi.viewRecentMatches')}
              </button>
            </div>
          )}
          {!isSpectator && (
            <div className="room-ready-actions">
              {room.matchmaking ? (
                <button
                  className="btn btn-success"
                  onClick={() => emit('room:ready', { ready: !me?.ready })}
                >
                  <Check size={16} />
                  {me?.ready ? t('multi.cancelReady') : t('multi.readyAction')}
                </button>
              ) : isHost ? (
                <button
                  className="btn btn-success"
                  onClick={() => emit('game:start')}
                  disabled={room.players.length < 2 || !room.players.every((p) => p.ready)}
                >
                  <Play size={16} />
                  {t('multi.startGame')}
                </button>
              ) : (
                <button
                  className="btn btn-success"
                  onClick={() => emit('room:ready', { ready: !me?.ready })}
                >
                  <Check size={16} />
                  {me?.ready ? t('multi.cancelReady') : t('multi.readyAction')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* 对局区:左右分栏(移动端上下堆叠) */}
      {room.status !== 'waiting' && (
        room.gameMode === 'relay' ? (
          <div className="card player-board relay-board" style={{ margin: 0 }}>
            <h3>
              {t('multi.sharedGuesses')}
              <span className="muted">{room.relayGuesses?.length ?? 0}/{room.maxGuesses}</span>
              {room.currentTurnKey && (
                <span className="badge amber">
                  {t('multi.currentTurn', {
                    player: room.players.find((player) => player.key === room.currentTurnKey)?.name ?? '-',
                  })}
                </span>
              )}
            </h3>
            {room.relayGuesses?.length ? (
              <GuessBoard
                guesses={room.relayGuesses.map((guess) => guess.feedback)}
                rowAnnotations={room.relayGuesses.map((guess) => {
                  const label = room.players.find((player) => player.key === guess.actorKey)?.name ?? '-';
                  return {
                    content: label,
                    title: label,
                    tone: guess.actorKey === myKey ? 'self' as const : 'other' as const,
                  };
                })}
              />
            ) : <p className="muted">{t('multi.noGuesses')}</p>}
            <div className="guess-list-end" ref={activeGuessListEndRef} aria-hidden="true" />
          </div>
        ) : <div className="boards">
          {displayedLeftPlayer && (
            <PlayerBoard
              key={`${displayedLeftPlayer.key}:${replayRound?.round ?? room.roundId}`}
              player={displayedLeftPlayer}
              room={room}
              title={me ? t('multi.myGuesses') : displayedLeftPlayer.name}
              isSelf={displayedLeftPlayer.key === myKey}
              endRef={displayedLeftPlayer.key === myKey ? activeGuessListEndRef : undefined}
            />
          )}
          {displayedRightPlayer && (
            <PlayerBoard
              key={`${displayedRightPlayer.key}:${replayRound?.round ?? room.roundId}`}
              player={displayedRightPlayer}
              room={room}
              title={displayedRightPlayer.name}
              isSelf={displayedRightPlayer.key === myKey}
              endRef={displayedRightPlayer.key === myKey ? activeGuessListEndRef : undefined}
            />
          )}
        </div>
      )}

      {/* 小局结算 */}
      {roundOver && !matchOver && (
        <AnswerOverlay
          title={
            roundOver.winnerKey == null
              ? t('multi.roundDraw')
              : roundOver.winnerKey === myKey
                ? t('multi.roundWon')
                : isSpectator
                  ? t('multi.playerWonRound', { player: room.players.find((p) => p.key === roundOver.winnerKey)?.name ?? '' })
                  : t('multi.roundLost')
          }
          answer={roundOver.answer}
          onClose={() => setRoundOver(null)}
          extra={
            <p className="muted">
              <Trans
                i18nKey={nextRoundDeadline ? 'multi.nextRoundCountdown' : 'multi.nextRoundSoon'}
                values={{ reason: ROUND_OVER_REASON[roundOver.reason] ? t(ROUND_OVER_REASON[roundOver.reason]) : '' }}
                components={{ countdown: <Countdown deadline={nextRoundDeadline} /> }}
              />
            </p>
          }
          actions={
            <button className="btn btn-ghost" onClick={() => setRoundOver(null)}>
              {t('multi.viewGame')}
            </button>
          }
        />
      )}

      {/* 整场结算 */}
      {matchOver && matchOverVisible && (
        <AnswerOverlay
          title={
            room.gameMode === 'relay'
              ? t('multi.relayMatchComplete')
              : matchOver.winnerKey == null
              ? t('multi.matchEnded')
              : isSpectator
                ? t('multi.playerWonMatch', { player: room.players.find((p) => p.key === matchOver.winnerKey)?.name ?? '' })
                : matchOver.winnerKey === myKey
                  ? t('multi.matchWon')
                  : t('multi.matchLost')
          }
          answer={matchOver.answer}
          onClose={() => setMatchOverVisible(false)}
          extra={
            <div className="match-over-extra">
              <p className="muted">
                {room.gameMode === 'relay' ? t('multi.relayFinalScore', {
                  solved: room.relaySolvedRounds ?? 0,
                  total: room.totalRounds ?? room.boType,
                }) : t('multi.finalScore', {
                  reason: matchOverReason(matchOver, myKey, isSpectator, t),
                  score: `${leftPlayer?.score ?? 0} : ${rightPlayer?.score ?? 0}`,
                })}
              </p>
              {rematchNotice && <p className="muted">{rematchNotice}</p>}
            </div>
          }
          actions={
            <>
              <button className="btn btn-ghost" onClick={viewFinishedMatch}>
                <Eye size={16} />
                {t('multi.viewGame')}
              </button>
              {canRematch && !rematchInviterKey && (
                <button
                  className="btn btn-success"
                  disabled={rematchBusy}
                  onClick={() => updateRematch('match:rematch-invite')}
                >
                  <RotateCcw size={16} />
                  {t('multi.inviteRematch')}
                </button>
              )}
              {canRematch && rematchInviterKey === myKey && (
                <button
                  className="btn btn-ghost"
                  disabled={rematchBusy}
                  onClick={() => updateRematch('match:rematch-cancel')}
                >
                  <X size={16} />
                  {t('multi.cancelInvite')}
                </button>
              )}
              {canRematch && rematchInviterKey && rematchInviterKey !== myKey && (
                <>
                  <button
                    className="btn btn-success"
                    disabled={rematchBusy}
                    onClick={() => updateRematch('match:rematch-respond', { accept: true })}
                  >
                    <Check size={16} />
                    {t('multi.acceptRematch')}
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={rematchBusy}
                    onClick={() => updateRematch('match:rematch-respond', { accept: false })}
                  >
                    <X size={16} />
                    {t('multi.decline')}
                  </button>
                </>
              )}
              <button className="btn btn-ghost" disabled={leaving} onClick={() => void leaveRoom()}>
                <DoorOpen size={16} />
                {leaving ? t('multi.leaving') : t('multi.returnLobby')}
              </button>
              {room.matchmaking && !isSpectator && opponent && !room.reportSubmitted && (
                <button className="match-report-link" type="button" disabled={reportBusy} onClick={() => setReportOpen(true)}>
                  <AlertTriangle size={13} aria-hidden="true" />
                  {t('multi.reportOpponent')}
                </button>
              )}
              {room.matchmaking && room.reportSubmitted && <span className="badge amber">{t('multi.reportSubmitted')}</span>}
            </>
          }
        />
      )}

      {playerStats && (
        <PlayerStatsDialog view={playerStats} onClose={() => setPlayerStats(null)} />
      )}

      {relayAbort && (
        <AnswerOverlay
          title={t('multi.relayAbortedTitle')}
          answer={null}
          extra={
            <p className="muted">
              {t(relayAbort.reason === 'player_left'
                ? 'multi.relayAbortedPlayerLeft'
                : 'multi.relayAbortedDisconnect')}
            </p>
          }
          actions={
            <button className="btn btn-ghost" onClick={returnFromRelayAbort}>
              <DoorOpen size={16} />
              {t('multi.returnLobby')}
            </button>
          }
        />
      )}
      {reportOpen && room?.matchmaking && opponent && (
        <ModalPortal>
          <div className="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setReportOpen(false); }}>
            <div ref={reportDialogRef} className="confirm-dialog match-report-dialog" role="dialog" aria-modal="true" aria-labelledby="match-report-title" tabIndex={-1}>
              <div className="confirm-icon" aria-hidden="true"><AlertTriangle size={22} /></div>
              <div className="confirm-content">
                <div className="confirm-heading">
                  <h2 id="match-report-title">{t('multi.reportTitle')}</h2>
                  <button className="confirm-close" type="button" aria-label={t('common.close')} onClick={() => setReportOpen(false)}><X size={18} /></button>
                </div>
                <p>{t('multi.reportMessage', { player: opponent.name })}</p>
                <textarea
                  className="input match-report-input"
                  value={reportDescription}
                  maxLength={50}
                  rows={3}
                  placeholder={t('multi.reportPlaceholder')}
                  onChange={(event) => setReportDescription(event.target.value.slice(0, 50))}
                />
                <div className="match-report-counter">{reportDescription.length}/50</div>
                <div className="confirm-actions">
                  <button className="btn btn-ghost" type="button" onClick={() => setReportOpen(false)}>{t('common.cancel')}</button>
                  <button className="btn btn-warning" type="button" disabled={reportBusy} onClick={submitReport}><AlertTriangle size={15} />{t('multi.submitReport')}</button>
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </Page>
  );
}
