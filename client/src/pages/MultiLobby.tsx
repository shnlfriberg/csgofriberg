import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
} from 'lucide-react';
import Page from '../components/Page';
import { getSocket } from '../api/socket';
import { translate } from '../i18n/messages';
import { RoomState } from '../types';
import { useConfirm } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';
import ModalPortal from '../components/ModalPortal';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_DIFFICULTIES } from '../config/difficulties';
import { difficultyLabel } from '../utils/difficulty';

type DbType = string;
const BO_OPTIONS = [1, 3, 5, 7];

function localMatchDeadline(input: {
  startsAt?: unknown;
  startsInMs?: unknown;
  serverNow?: unknown;
}): number | null {
  const startsInMs = Number(input.startsInMs);
  if (Number.isFinite(startsInMs) && startsInMs >= 0) {
    return performance.now() + startsInMs;
  }

  const startsAt = Number(input.startsAt);
  const serverNow = Number(input.serverNow);
  if (
    Number.isFinite(startsAt) &&
    Number.isFinite(serverNow) &&
    startsAt > serverNow
  ) {
    return performance.now() + (startsAt - serverNow);
  }

  return null;
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

function MatchFoundDialog({ countdown }: { countdown: number }) {
  const { t } = useTranslation();
  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = oldOverflow;
    };
  }, []);

  return (
    <ModalPortal>
      <div className="overlay" role="presentation">
        <div className="overlay-card match-found-dialog" role="dialog" aria-modal="true" aria-labelledby="match-found-title">
          <Check size={34} color="var(--success)" aria-hidden="true" />
          <h2 id="match-found-title">{t('multi.found')}</h2>
          <p className="match-found-countdown" aria-live="polite">{countdown}</p>
          <p className="muted">{t('multi.enterAfter')}</p>
        </div>
      </div>
    </ModalPortal>
  );
}

export default function MultiLobby() {
  const { t } = useTranslation();
  const difficulties = AVAILABLE_DIFFICULTIES;
  const [dbType, setDbType] = useState<DbType>('normal');
  const [boType, setBoType] = useState(3);
  const [allowSpectators, setAllowSpectators] = useState(false);
  const anonymous = true;
  const [mmDbType, setMmDbType] = useState<DbType>('normal');
  const mmAnonymous = true;
  const [joinCode, setJoinCode] = useState('');
  const [createdRoom, setCreatedRoom] = useState<RoomState | null>(null);
  const [currentRoom, setCurrentRoom] = useState<RoomState | null>(null);
  const [currentRole, setCurrentRole] = useState<'player' | 'spectator'>('player');
  const [copied, setCopied] = useState(false);
  const [searching, setSearching] = useState(false);
  const [matchDeadline, setMatchDeadline] = useState<number | null>(null);
  const [matchCountdown, setMatchCountdown] = useState(0);
  const navigate = useNavigate();
  const confirm = useConfirm();
  const searchingRef = useRef(false);
  const replacingRoomRef = useRef(false);
  const matchOptionsRef = useRef({ dbType: mmDbType, anonymous: mmAnonymous });
  matchOptionsRef.current = { dbType: mmDbType, anonymous: mmAnonymous };

  useEffect(() => {
    if (!difficulties.length) return;
    const defaultKey = difficulties.find((item) => item.key === 'normal')?.key ?? difficulties[0].key;
    if (!difficulties.some((item) => item.key === dbType)) setDbType(defaultKey);
    if (!difficulties.some((item) => item.key === mmDbType)) setMmDbType(defaultKey);
  }, [difficulties, dbType, mmDbType]);

  useEffect(() => {
    if (!matchDeadline) {
      setMatchCountdown(0);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((matchDeadline - performance.now()) / 1000));
      setMatchCountdown(left);
      if (left <= 0) {
        setMatchDeadline(null);
        navigate('/multi/room');
      }
    };
    tick();
    const timer = window.setInterval(tick, 200);
    return () => window.clearInterval(timer);
  }, [matchDeadline, navigate]);

  useEffect(() => {
    const socket = getSocket();
    const onMatchFound = (payload: { startsAt?: number; startsInMs?: number } = {}) => {
      searchingRef.current = false;
      setSearching(false);
      const deadline = localMatchDeadline(payload);
      if (deadline) {
        setMatchDeadline(deadline);
      } else {
        navigate('/multi/room');
      }
    };
    const restoreSearch = () => {
      if (!searchingRef.current) return;
      socket.emit('match:start', matchOptionsRef.current, (res: any) => {
        if (res?.room) {
          searchingRef.current = false;
          setSearching(false);
          const deadline = localMatchDeadline({
            startsAt: res.room.matchStartsAt,
            serverNow: res.serverNow,
          });
          if (deadline) {
            setMatchDeadline(deadline);
          } else {
            navigate('/multi/room');
          }
          return;
        }
        if (!res?.code) return;
        searchingRef.current = false;
        setSearching(false);
        toast.error(translate(res.code));
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
        const deadline = localMatchDeadline({
          startsAt: res.room.matchStartsAt,
          serverNow: res.serverNow,
        });
        if (deadline) {
          setMatchDeadline(deadline);
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
  }, [navigate]);

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
    if (!replaceExisting && currentRoom) {
      if (!await leaveCurrentFor(currentRoom, currentRole, t('multi.createNewRoom'))) return;
    }
    getSocket().emit('room:create', { dbType, boType, allowSpectators, anonymous }, (res: any) => {
      if (res?.code === 'ALREADY_IN_ROOM' && res.room) {
        setCurrentRoom(res.room);
        setCurrentRole(res.role ?? 'player');
        void leaveCurrentFor(res.room, res.role ?? 'player', t('multi.createNewRoom')).then((left) => {
          if (left) void create(true);
        });
        return;
      }
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
        const deadline = localMatchDeadline({
          startsAt: res.room.matchStartsAt,
          serverNow: res.serverNow,
        });
        if (deadline) {
          setMatchDeadline(deadline);
        } else {
          navigate('/multi/room');
        }
        return;
      }
      if (res?.code) {
        setSearching(false);
        searchingRef.current = false;
        toast.error(translate(res.code));
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
            {t('multi.roomSummary', {
              room: currentRoom.id,
              bo: currentRoom.boType,
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
            {t('multi.database', { type: difficultyLabel(t, createdRoom.dbType) })} · {t('multi.format', { bo: createdRoom.boType })} · {createdRoom.allowSpectators ? t('multi.allowSpectating') : t('multi.denySpectating')}
            {' · '}{createdRoom.anonymous ? t('multi.anonymousRoom') : t('multi.showNames')}
          </p>
          <button className="btn btn-lg" onClick={() => navigate('/multi/room')}>
            <Rocket size={16} />
            {t('multi.enterRoom')}
          </button>
        </div>
      ) : (
        <div className="lobby-grid">
          <div className="card" style={{ margin: 0 }}>
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
              label={t('multi.formatLabel')}
              options={BO_OPTIONS}
              value={boType}
              onChange={setBoType}
              format={(v) => `BO${v}`}
            />
            <label className="spectator-option">
              <input
                type="checkbox"
                checked={allowSpectators}
                onChange={(event) => setAllowSpectators(event.target.checked)}
              />
              <span>{t('multi.allowSpectating')}</span>
            </label>
            <div style={{ textAlign: 'center', marginTop: 14 }}>
              <button className="btn btn-lg" onClick={() => void create()}>
                <Zap size={16} />
                {t('multi.createRoom')}
              </button>
            </div>
          </div>

          <div className="card" style={{ margin: 0 }}>
            <h3>
              <Dices size={16} />
              {t('multi.randomMatch')}
            </h3>
            <p className="muted">{t('multi.fixedBo3')}</p>
            <OptionGroup
              label={t('multi.playerDatabase')}
              options={difficulties.map((item) => item.key) as DbType[]}
              value={mmDbType}
              onChange={setMmDbType}
              format={(v) => difficultyLabel(t, v)}
            />
            {searching ? (
              <div style={{ textAlign: 'center', marginTop: 14 }}>
                <div className="spinner" />
                <p style={{ margin: '12px 0', fontWeight: 600 }}>{t('multi.searching')}</p>
                <button className="btn btn-ghost btn-sm" onClick={cancelMatch}>
                  <XCircle size={15} />
                  {t('multi.cancelMatch')}
                </button>
              </div>
            ) : (
              <div style={{ textAlign: 'center', marginTop: 14 }}>
                <button className="btn btn-accent btn-lg" onClick={startMatch}>
                  <Dices size={16} />
                  {t('multi.startMatch')}
                </button>
              </div>
            )}
          </div>

          <div className="card" style={{ margin: 0 }}>
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
      {matchDeadline && <MatchFoundDialog countdown={matchCountdown} />}
    </Page>
  );
}
