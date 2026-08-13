import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Globe,
  House,
  Dices,
  DoorOpen,
  Copy,
  Check,
  Zap,
  Rocket,
  XCircle,
  Eye,
  Settings2,
  ChevronDown,
} from 'lucide-react';
import Page from '../components/Page';
import { getSocket } from '../api/socket';
import { translate } from '../i18n/messages';
import { RoomState } from '../types';
import { useConfirm } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_DIFFICULTIES } from '../config/difficulties';
import { difficultyLabel } from '../utils/difficulty';
import {
  loadMultiLobbyPreferences,
  saveMultiLobbyPreferences,
  MAX_MULTI_GUESS_INTERVAL_SECONDS,
  MAX_MULTI_MAX_GUESSES,
  MAX_MULTI_ROUND_DURATION_SECONDS,
  MIN_MULTI_GUESS_INTERVAL_SECONDS,
  MIN_MULTI_MAX_GUESSES,
  MIN_MULTI_ROUND_DURATION_SECONDS,
} from '../store/multiLobbyPreferences';
import { useAuth } from '../store/auth';

type DbType = string;
const BO_OPTIONS = [1, 3, 5, 7];
const DEFAULT_ROUND_DURATION_MS = 120_000;

function parseNumberDraft(draft: string): number | null {
  if (!draft.trim()) return null;
  const value = Number(draft);
  return Number.isFinite(value) ? value : null;
}

function OptionGroup<T extends string | number>({
  label,
  options,
  value,
  onChange,
  format,
}: {
  label: string;
  options: T[];
  value: T;
  onChange: (v: T) => void;
  format: (v: T) => string;
}) {
  return (
    <div className="option-row">
      <span className="opt-label">{label}</span>
      {options.map((opt) => (
        <button
          key={String(opt)}
          className={`opt-btn ${opt === value ? 'active' : ''}`}
          onClick={() => onChange(opt)}
        >
          {format(opt)}
        </button>
      ))}
    </div>
  );
}

export default function MultiLobby() {
  const { t } = useTranslation();
  const difficulties = AVAILABLE_DIFFICULTIES;
  const difficultyKeys = difficulties.map((item) => item.key);
  const defaultDifficulty = difficulties.find((item) => item.key === 'normal')?.key
    ?? difficulties[0]?.key
    ?? 'normal';
  const [initialPreferences] = useState(() =>
    loadMultiLobbyPreferences(difficultyKeys, defaultDifficulty)
  );
  const [dbType, setDbType] = useState<DbType>(initialPreferences.createDifficulty);
  const [gameMode, setGameMode] = useState<'classic' | 'relay'>(initialPreferences.gameMode);
  const [totalRounds, setTotalRounds] = useState(initialPreferences.totalRounds);
  const [boType, setBoType] = useState(initialPreferences.boType);
  const [maxPlayers, setMaxPlayers] = useState(initialPreferences.maxPlayers);
  const [allowSpectators, setAllowSpectators] = useState(initialPreferences.allowSpectators);
  const [verifiedEmailOnly, setVerifiedEmailOnly] = useState(initialPreferences.verifiedEmailOnly);
  const [maxGuesses, setMaxGuesses] = useState(initialPreferences.maxGuesses);
  const [guessIntervalSeconds, setGuessIntervalSeconds] = useState(
    initialPreferences.guessIntervalSeconds
  );
  const [roundDurationSeconds, setRoundDurationSeconds] = useState(
    initialPreferences.roundDurationSeconds
  );
  const [maxGuessesDraft, setMaxGuessesDraft] = useState(String(initialPreferences.maxGuesses));
  const [guessIntervalDraft, setGuessIntervalDraft] = useState(
    String(initialPreferences.guessIntervalSeconds)
  );
  const [roundDurationDraft, setRoundDurationDraft] = useState(
    String(initialPreferences.roundDurationSeconds)
  );
  const anonymous = true;
  const [mmDbType, setMmDbType] = useState<DbType>(initialPreferences.matchmakingDifficulty);
  const mmAnonymous = true;
  const user = useAuth((state) => state.user);
  const authInitialized = useAuth((state) => state.initialized);
  const canUseMatchmaking = Boolean(user?.id && user.email && user.emailVerified);
  const [joinCode, setJoinCode] = useState('');
  const [createdRoom, setCreatedRoom] = useState<RoomState | null>(null);
  const [currentRoom, setCurrentRoom] = useState<RoomState | null>(null);
  const [currentRole, setCurrentRole] = useState<'player' | 'spectator'>('player');
  const [copied, setCopied] = useState(false);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [matchCooldownDeadline, setMatchCooldownDeadline] = useState<number | null>(null);
  const [matchCooldownSeconds, setMatchCooldownSeconds] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const searchingRef = useRef(false);
  const replacingRoomRef = useRef(false);
  const matchOptionsRef = useRef({ dbType: mmDbType, anonymous: mmAnonymous });
  matchOptionsRef.current = { dbType: mmDbType, anonymous: mmAnonymous };

  const parsedMaxGuesses = parseNumberDraft(maxGuessesDraft);
  const parsedGuessInterval = parseNumberDraft(guessIntervalDraft);
  const parsedRoundDuration = parseNumberDraft(roundDurationDraft);
  const maxGuessesValid = parsedMaxGuesses !== null
    && Number.isInteger(parsedMaxGuesses)
    && parsedMaxGuesses >= MIN_MULTI_MAX_GUESSES
    && parsedMaxGuesses <= MAX_MULTI_MAX_GUESSES;
  const guessIntervalValid = parsedGuessInterval !== null
    && parsedGuessInterval >= MIN_MULTI_GUESS_INTERVAL_SECONDS
    && parsedGuessInterval <= MAX_MULTI_GUESS_INTERVAL_SECONDS;
  const roundDurationValid = parsedRoundDuration !== null
    && Number.isInteger(parsedRoundDuration)
    && parsedRoundDuration >= MIN_MULTI_ROUND_DURATION_SECONDS
    && parsedRoundDuration <= MAX_MULTI_ROUND_DURATION_SECONDS;
  const advancedSettingsValid = maxGuessesValid && guessIntervalValid && roundDurationValid;

  useEffect(() => {
    const cooldownUntil = Number(
      (location.state as { matchmakingCooldownUntil?: unknown } | null)?.matchmakingCooldownUntil
    );
    if (!Number.isFinite(cooldownUntil)) return;
    const remaining = Math.max(0, cooldownUntil - Date.now());
    if (remaining > 0) setMatchCooldownDeadline(performance.now() + remaining);
    navigate('/multi', { replace: true, state: null });
  }, [location.state, navigate]);

  useEffect(() => {
    if (!difficulties.length) return;
    const defaultKey = difficulties.find((item) => item.key === 'normal')?.key ?? difficulties[0].key;
    if (!difficulties.some((item) => item.key === dbType)) setDbType(defaultKey);
    if (!difficulties.some((item) => item.key === mmDbType)) setMmDbType(defaultKey);
  }, [difficulties, dbType, mmDbType]);

  useEffect(() => {
    saveMultiLobbyPreferences({
      gameMode,
      totalRounds,
      createDifficulty: dbType,
      boType,
      maxPlayers,
      allowSpectators,
      verifiedEmailOnly,
      maxGuesses,
      guessIntervalSeconds,
      roundDurationSeconds,
      matchmakingDifficulty: mmDbType,
    });
  }, [
    allowSpectators,
    boType,
    dbType,
    gameMode,
    guessIntervalSeconds,
    maxGuesses,
    maxPlayers,
    mmDbType,
    roundDurationSeconds,
    totalRounds,
    verifiedEmailOnly,
  ]);

  useEffect(() => {
    if (!matchCooldownDeadline) {
      setMatchCooldownSeconds(0);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((matchCooldownDeadline - performance.now()) / 1000));
      setMatchCooldownSeconds(left);
      if (left <= 0) setMatchCooldownDeadline(null);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [matchCooldownDeadline]);

  const applyMatchCooldown = (res: any): boolean => {
    if (res?.code !== 'MATCHMAKING_COOLDOWN') return false;
    const retryAt = Number(res.retryAt);
    const serverNow = Number(res.serverNow);
    const remaining = Number.isFinite(retryAt) && Number.isFinite(serverNow)
      ? Math.max(0, retryAt - serverNow)
      : 10_000;
    setMatchCooldownDeadline(performance.now() + remaining);
    toast.error(t('multi.matchmakingCooldown', { seconds: Math.max(1, Math.ceil(remaining / 1000)) }));
    return true;
  };

  useEffect(() => {
    const socket = getSocket();
    const onMatchFound = () => {
      searchingRef.current = false;
      setSearching(false);
      navigate('/multi/room');
    };
    const restoreSearch = () => {
      if (!searchingRef.current) return;
      socket.emit('match:start', matchOptionsRef.current, (res: any) => {
        if (res?.room) {
          searchingRef.current = false;
          setSearching(false);
          navigate('/multi/room');
          return;
        }
        if (!res?.code) return;
        searchingRef.current = false;
        setSearching(false);
        if (!applyMatchCooldown(res)) toast.error(translate(res.code));
      });
    };
    socket.on('match:found', onMatchFound);
    socket.on('connect', restoreSearch);
    // 查询自己是否还挂在某个房间里(断线重进/误退出场景)
    socket.emit('room:sync', {}, (res: any) => {
      if (res?.room) {
        if (res.room.status === 'finished') {
          socket.emit('room:leave', {}, (leaveRes: any) => {
            if (leaveRes?.code) toast.error(translate(leaveRes.code));
            else setCurrentRoom(null);
          });
          return;
        }
        if (res.room.matchmaking && res.room.status === 'waiting') {
          navigate('/multi/room');
          return;
        }
        setCurrentRoom(res.room);
        setCurrentRole(res.role ?? 'player');
      }
    });
    return () => {
      socket.off('match:found', onMatchFound);
      socket.off('connect', restoreSearch);
      // 离开大厅时取消排队
      if (searchingRef.current) socket.emit('match:cancel', {});
    };
  }, [navigate, t]);

  /** 结束比赛/退出观战:对局中离开即判负,需二次确认 */
  const endCurrent = async () => {
    const matchOngoing =
      currentRole === 'player' &&
      (currentRoom?.status === 'playing' || currentRoom?.status === 'round_over');
    if (matchOngoing && !await confirm({
      title: t('multi.endMatchTitle'),
      message: t('multi.endMatchMessage'),
      confirmLabel: t('multi.endMatchConfirm'),
      tone: 'danger',
    })) return;
    getSocket().emit('room:leave', {}, (res: any) => {
      if (res?.code) {
        toast.error(translate(res.code));
        return;
      }
      setCurrentRoom(null);
    });
  };

  const leaveCurrentFor = async (
    room: RoomState,
    role: 'player' | 'spectator',
    actionLabel: string
  ): Promise<boolean> => {
    if (replacingRoomRef.current) return false;
    replacingRoomRef.current = true;
    const matchOngoing =
      role === 'player' &&
      (room.status === 'playing' || room.status === 'round_over');
    const accepted = await confirm({
      title: t('multi.replaceTitle', { action: actionLabel }),
      message: matchOngoing
        ? t('multi.replaceOngoing', { action: actionLabel })
        : t('multi.replaceWaiting', { room: room.id, action: actionLabel }),
      confirmLabel: matchOngoing ? t('multi.replaceLossConfirm', { action: actionLabel }) : t('multi.replaceConfirm', { action: actionLabel }),
      tone: matchOngoing ? 'danger' : 'warning',
    });
    if (!accepted) {
      replacingRoomRef.current = false;
      return false;
    }
    return new Promise((resolve) => {
      getSocket().emit('room:leave', {}, (res: any) => {
        replacingRoomRef.current = false;
        if (res?.code) {
          toast.error(translate(res.code));
          resolve(false);
          return;
        }
        setCurrentRoom(null);
        resolve(true);
      });
    });
  };

  const create = async (replaceExisting = false) => {
    if (creating || !advancedSettingsValid) return;
    setCreating(true);
    if (!replaceExisting && currentRoom) {
      if (!await leaveCurrentFor(currentRoom, currentRole, t('multi.createNewRoom'))) {
        setCreating(false);
        return;
      }
    }
    getSocket().emit('room:create', {
      dbType,
      gameMode,
      totalRounds,
      boType,
      maxPlayers: gameMode === 'classic' ? maxPlayers : 2,
      allowSpectators,
      verifiedOnly: verifiedEmailOnly,
      anonymous,
      maxGuesses,
      guessIntervalMs: Math.round(guessIntervalSeconds * 1000),
      roundDurationMs: roundDurationSeconds * 1000,
    }, (res: any) => {
      if (res?.code === 'ALREADY_IN_ROOM' && res.room) {
        setCreating(false);
        setCurrentRoom(res.room);
        setCurrentRole(res.role ?? 'player');
        void leaveCurrentFor(res.room, res.role ?? 'player', t('multi.createNewRoom')).then((left) => {
          if (left) void create(true);
        });
        return;
      }
      setCreating(false);
      if (res?.code) {
        toast.error(translate(res.code));
        return;
      }
      setCreatedRoom(res.room);
      toast.success(t('multi.roomCreated'));
    });
  };

  const join = async (code: string, spectate = false, replaceExisting = false) => {
    if (!code.trim()) {
      toast.error(t('multi.enterRoomCode'));
      return;
    }
    if (!replaceExisting && currentRoom && currentRoom.id !== code.trim().toUpperCase()) {
      const action = spectate ? t('multi.joinSpectate') : t('multi.joinNewRoom');
      if (!await leaveCurrentFor(currentRoom, currentRole, action)) return;
    }
    getSocket().emit('room:join', { roomId: code.trim(), spectate }, (res: any) => {
      if (res?.code === 'ALREADY_IN_ROOM' && res.room) {
        setCurrentRoom(res.room);
        setCurrentRole(res.role ?? 'player');
        const action = spectate ? t('multi.joinSpectate') : t('multi.joinNewRoom');
        void leaveCurrentFor(res.room, res.role ?? 'player', action).then((left) => {
          if (left) void join(code, spectate, true);
        });
        return;
      }
      if (res?.code) {
        toast.error(translate(res.code));
        return;
      }
      navigate('/multi/room');
    });
  };

  const startMatch = () => {
    setSearching(true);
    searchingRef.current = true;
    getSocket().emit('match:start', { dbType: mmDbType, anonymous: mmAnonymous }, (res: any) => {
      if (res?.room) {
        setSearching(false);
        searchingRef.current = false;
        navigate('/multi/room');
        return;
      }
      if (res?.code) {
        setSearching(false);
        searchingRef.current = false;
        if (!applyMatchCooldown(res)) toast.error(translate(res.code));
        return;
      }
      if (res?.queued) {
        setSearching(true);
        searchingRef.current = true;
      }
      // queued=false 时 match:found 事件会直接跳转
    });
  };

  const cancelMatch = () => {
    getSocket().emit('match:cancel', {}, (res: any) => {
      if (res?.code) toast.error(translate(res.code));
      setSearching(false);
      searchingRef.current = false;
    });
  };

  const copyCode = async () => {
    if (!createdRoom) return;
    try {
      await navigator.clipboard.writeText(createdRoom.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('multi.copyFailed'));
    }
  };

  return (
    <Page title={t('multi.title')} icon={<Globe size={17} />}>
      {currentRoom && (
        <div className="card multi-lobby-message-card" style={{ borderColor: 'var(--warning)' }}>
          <h3>
            <Rocket size={16} color="var(--warning)" />
            {t('multi.unfinished')}
          </h3>
          <p className="muted">
            {t(currentRoom.gameMode === 'relay' ? 'multi.roomSummaryRelay' : 'multi.roomSummary', {
              room: currentRoom.id,
              bo: currentRoom.boType,
              rounds: currentRoom.totalRounds ?? 3,
              status: currentRoom.status === 'waiting'
              ? t('multi.waiting')
              : currentRoom.status === 'finished'
                ? t('multi.finished')
                : t('multi.roundPlaying', { round: currentRoom.round }),
            })}
            {currentRole === 'spectator' && ` · ${t('multi.spectatorRole')}`}
          </p>
          <div className="multi-lobby-message-actions">
            <button className="btn btn-success" onClick={() => navigate('/multi/room')}>
              <Rocket size={15} />
              {t('multi.reconnect')}
            </button>
            <button className="btn btn-danger" onClick={() => void endCurrent()}>
              <XCircle size={15} />
              {currentRole === 'spectator'
                ? t('multi.exitSpectating')
                : currentRoom.status === 'waiting'
                  ? t('multi.exitRoom')
                  : t('multi.endWithLoss')}
            </button>
          </div>
        </div>
      )}

      {createdRoom ? (
        <div className="card multi-lobby-created-card">
          <h3>
            <Check size={16} color="var(--success)" />
            {t('multi.roomCreated')}
          </h3>
          <p className="muted">{t('multi.shareCode')}</p>
          <div className="room-code-display">{createdRoom.id}</div>
          <button className="btn btn-accent" onClick={() => void copyCode()}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? t('multi.copied') : t('multi.copyCode')}
          </button>
          <p className="muted multi-lobby-created-meta">
            {t('multi.database', { type: difficultyLabel(t, createdRoom.dbType) })} · {createdRoom.gameMode === 'relay' ? t('multi.relayRounds', { rounds: createdRoom.totalRounds ?? 3 }) : t('multi.format', { bo: createdRoom.boType })} · {t('multi.roomCapacity', { current: createdRoom.players.length, max: createdRoom.maxPlayers ?? 2 })} · {createdRoom.allowSpectators ? t('multi.allowSpectating') : t('multi.denySpectating')} · {createdRoom.verifiedOnly ? t('multi.verifiedRoomOnly') : t('multi.anyoneCanJoin')}
            {' · '}{createdRoom.anonymous ? t('multi.anonymousRoom') : t('multi.showNames')}
            {' · '}{t('multi.customRulesSummary', {
              guesses: createdRoom.maxGuesses,
              interval: createdRoom.guessIntervalMs / 1000,
              duration: (createdRoom.roundDurationMs ?? DEFAULT_ROUND_DURATION_MS) / 1000,
            })}
          </p>
          <button className="btn btn-lg" onClick={() => navigate('/multi/room')}>
            <Rocket size={16} />
            {t('multi.enterRoom')}
          </button>
        </div>
      ) : (
        <div className="lobby-grid">
          <div className="card multi-lobby-create-card" style={{ margin: 0 }}>
            <h3>
              <House size={16} />
              {t('multi.createRoom')}
            </h3>
            <OptionGroup
              label={t('multi.playerDatabase')}
              options={difficulties.map((item) => item.key) as DbType[]}
              value={dbType}
              onChange={setDbType}
              format={(v) => difficultyLabel(t, v)}
            />
            <OptionGroup
              label={t('multi.gameModeLabel')}
              options={['classic', 'relay']}
              value={gameMode}
              onChange={setGameMode}
              format={(v) => t(v === 'relay' ? 'multi.relayMode' : 'multi.classicMode')}
            />
            <OptionGroup
              label={gameMode === 'relay' ? t('multi.totalRoundsLabel') : t('multi.formatLabel')}
              options={BO_OPTIONS}
              value={gameMode === 'relay' ? totalRounds : boType}
              onChange={gameMode === 'relay' ? setTotalRounds : setBoType}
              format={(v) => gameMode === 'relay' ? String(v) : `BO${v}`}
            />
            {gameMode === 'classic' && (
              <label className="option-row room-player-limit-setting">
                <span className="opt-label">{t('multi.maxPlayersLabel')}</span>
                <select
                  className="input room-player-limit-select"
                  aria-label={t('multi.maxPlayersLabel')}
                  value={maxPlayers}
                  onChange={(event) => setMaxPlayers(Number(event.currentTarget.value))}
                >
                  {[2, 3, 4, 5, 6, 7, 8].map((count) => (
                    <option key={count} value={count}>
                      {t('multi.playerCountValue', { count })}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="room-create-options">
              <label className="spectator-option">
                <input
                  type="checkbox"
                  checked={allowSpectators}
                  onChange={(event) => setAllowSpectators(event.target.checked)}
                />
                <span>{t('multi.allowSpectating')}</span>
              </label>
              <label className="spectator-option">
                <input
                  type="checkbox"
                  checked={verifiedEmailOnly}
                  onChange={(event) => setVerifiedEmailOnly(event.target.checked)}
                />
                <span>{t('multi.verifiedRoomOnly')}</span>
              </label>
            </div>
            <details className="room-more-settings">
              <summary>
                <Settings2 size={16} aria-hidden="true" />
                <span>{t('multi.moreSettings')}</span>
                <ChevronDown className="room-more-settings-chevron" size={16} aria-hidden="true" />
              </summary>
              <div className="room-more-settings-fields">
                <label className="room-number-setting">
                  <span>{t('multi.maxGuessesLabel')}</span>
                  <span className="room-number-input">
                    <input
                      className="input"
                      type="number"
                      min={MIN_MULTI_MAX_GUESSES}
                      max={MAX_MULTI_MAX_GUESSES}
                      step={1}
                      aria-label={t('multi.maxGuessesLabel')}
                      aria-invalid={!maxGuessesValid}
                      aria-describedby={!maxGuessesValid ? 'max-guesses-error' : undefined}
                      value={maxGuessesDraft}
                      onChange={(event) => {
                        const draft = event.currentTarget.value;
                        setMaxGuessesDraft(draft);
                        const value = parseNumberDraft(draft);
                        if (
                          value !== null
                          && Number.isInteger(value)
                          && value >= MIN_MULTI_MAX_GUESSES
                          && value <= MAX_MULTI_MAX_GUESSES
                        ) {
                          setMaxGuesses(value);
                        }
                      }}
                    />
                    <span>{t('multi.guessCountUnit')}</span>
                  </span>
                  {!maxGuessesValid && (
                    <span id="max-guesses-error" className="room-number-error">
                      {t('multi.integerRangeError', {
                        min: MIN_MULTI_MAX_GUESSES,
                        max: MAX_MULTI_MAX_GUESSES,
                      })}
                    </span>
                  )}
                </label>
                <label className="room-number-setting">
                  <span>{t('multi.guessIntervalLabel')}</span>
                  <span className="room-number-input">
                    <input
                      className="input"
                      type="number"
                      min={MIN_MULTI_GUESS_INTERVAL_SECONDS}
                      max={MAX_MULTI_GUESS_INTERVAL_SECONDS}
                      step={0.1}
                      aria-label={t('multi.guessIntervalLabel')}
                      aria-invalid={!guessIntervalValid}
                      aria-describedby={!guessIntervalValid ? 'guess-interval-error' : undefined}
                      value={guessIntervalDraft}
                      onChange={(event) => {
                        const draft = event.currentTarget.value;
                        setGuessIntervalDraft(draft);
                        const value = parseNumberDraft(draft);
                        if (
                          value !== null
                          && value >= MIN_MULTI_GUESS_INTERVAL_SECONDS
                          && value <= MAX_MULTI_GUESS_INTERVAL_SECONDS
                        ) {
                          setGuessIntervalSeconds(value);
                        }
                      }}
                    />
                    <span>{t('multi.secondsUnit')}</span>
                  </span>
                  {!guessIntervalValid && (
                    <span id="guess-interval-error" className="room-number-error">
                      {t('multi.numberRangeError', {
                        min: MIN_MULTI_GUESS_INTERVAL_SECONDS,
                        max: MAX_MULTI_GUESS_INTERVAL_SECONDS,
                      })}
                    </span>
                  )}
                </label>
                <label className="room-number-setting">
                  <span>{t('multi.roundDurationLabel')}</span>
                  <span className="room-number-input">
                    <input
                      className="input"
                      type="number"
                      min={MIN_MULTI_ROUND_DURATION_SECONDS}
                      max={MAX_MULTI_ROUND_DURATION_SECONDS}
                      step={1}
                      aria-label={t('multi.roundDurationLabel')}
                      aria-invalid={!roundDurationValid}
                      aria-describedby={!roundDurationValid ? 'round-duration-error' : undefined}
                      value={roundDurationDraft}
                      onChange={(event) => {
                        const draft = event.currentTarget.value;
                        setRoundDurationDraft(draft);
                        const value = parseNumberDraft(draft);
                        if (
                          value !== null
                          && Number.isInteger(value)
                          && value >= MIN_MULTI_ROUND_DURATION_SECONDS
                          && value <= MAX_MULTI_ROUND_DURATION_SECONDS
                        ) {
                          setRoundDurationSeconds(value);
                        }
                      }}
                    />
                    <span>{t('multi.secondsUnit')}</span>
                  </span>
                  {!roundDurationValid && (
                    <span id="round-duration-error" className="room-number-error">
                      {t('multi.integerRangeError', {
                        min: MIN_MULTI_ROUND_DURATION_SECONDS,
                        max: MAX_MULTI_ROUND_DURATION_SECONDS,
                      })}
                    </span>
                  )}
                </label>
              </div>
            </details>
            <div style={{ textAlign: 'center', marginTop: 14 }}>
              <button
                className="btn btn-lg"
                onClick={() => void create()}
                disabled={creating || !advancedSettingsValid}
              >
                {creating ? <span className="spinner" style={{ width: 16, height: 16 }} /> : <Zap size={16} />}
                {creating ? t('multi.creating') : t('multi.createRoom')}
              </button>
            </div>
          </div>

          <div className="card multi-lobby-match-card" style={{ margin: 0 }}>
            <h3>
              <Dices size={16} />
              {t('multi.randomMatch')}
            </h3>
            <p className="muted">{t('multi.fixedBo3')}</p>
            {authInitialized && !canUseMatchmaking && (
              <p className="muted matchmaking-requirement">{t('multi.matchVerifiedRequired')}</p>
            )}
            <OptionGroup
              label={t('multi.playerDatabase')}
              options={difficulties.map((item) => item.key) as DbType[]}
              value={mmDbType}
              onChange={setMmDbType}
              format={(v) => difficultyLabel(t, v)}
            />
            {searching ? (
              <div style={{ textAlign: 'center', marginTop: 14 }}>
                <div className="spinner matchmaking-spinner" />
                <p style={{ margin: '12px 0', fontWeight: 600 }}>{t('multi.searching')}</p>
                <button className="btn btn-ghost btn-sm" onClick={cancelMatch}>
                  <XCircle size={15} />
                  {t('multi.cancelMatch')}
                </button>
              </div>
            ) : (
              <div style={{ textAlign: 'center', marginTop: 14 }}>
                <button className="btn btn-accent btn-lg" onClick={startMatch} disabled={!authInitialized || matchCooldownSeconds > 0 || !canUseMatchmaking}>
                  <Dices size={16} />
                  {matchCooldownSeconds > 0
                    ? t('multi.matchmakingCooldownButton', { seconds: matchCooldownSeconds })
                    : t('multi.startMatch')}
                </button>
              </div>
            )}
          </div>

          <div className="card multi-lobby-join-card" style={{ margin: 0 }}>
            <h3>
              <DoorOpen size={16} />
              {t('multi.joinExisting')}
            </h3>
            <p className="muted">{t('multi.joinHint')}</p>
            <div className="join-room-form">
              <input
                className="input"
                placeholder={t('multi.roomCodePlaceholder')}
                value={joinCode}
                maxLength={5}
                autoComplete="off"
                style={{
                  maxWidth: 180,
                  textAlign: 'center',
                  fontFamily: 'Consolas, monospace',
                  fontWeight: 700,
                  fontSize: '1.1rem',
                  letterSpacing: 3,
                  textTransform: 'uppercase',
                }}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && join(joinCode)}
              />
              <button className="btn btn-success" onClick={() => join(joinCode)}>
                <DoorOpen size={15} />
                {t('multi.join')}
              </button>
              <button className="btn btn-ghost" onClick={() => join(joinCode, true)}>
                <Eye size={15} />
                {t('multi.spectate')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
