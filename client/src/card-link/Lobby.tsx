import type { Difficulty, Variant } from '@friberg/card-link-core';
import { useState } from 'react';
import { ArrowUpRight, CalendarDays, Dices, DoorOpen, Gamepad2, House, Play, Users, XCircle, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Lobby entries mirror 图寻: single player, daily and one multiplayer page that
 * holds creating a friend room, random (ranked) matchmaking and joining by code.
 */
export type LobbyScene = 'practice' | 'daily' | 'friend';
export const lobbyScenes: LobbyScene[] = ['practice', 'daily', 'friend'];

/** Resolve the `?menu=` value; older links to the ranked menu open the multiplayer page. */
export function lobbySceneFrom(menu: string | null): LobbyScene | null {
  if (menu === 'ranked') return 'friend';
  return lobbyScenes.includes(menu as LobbyScene) ? menu as LobbyScene : null;
}

/** Mode entries reuse the home menu card look and palette. */
const SCENE_CARDS: Record<LobbyScene, { icon: typeof Gamepad2; color: string; title: string; intro: string }> = {
  practice: { icon: Gamepad2, color: '#74e38f', title: 'practice', intro: 'practiceIntro' },
  daily: { icon: CalendarDays, color: '#f25f5c', title: 'daily', intro: 'dailyIntro' },
  friend: { icon: Users, color: '#ffb64e', title: 'multiplayer', intro: 'multiplayerIntro' },
};
type Props = {
  scene: LobbyScene | null;
  navigate: (scene: LobbyScene | null) => void;
  variant: Variant;
  setVariant: (variant: Variant) => void;
  /** Card link unavailable or a request is running. */
  disabled: boolean;
  loading: boolean;
  start: (scene: LobbyScene, difficulty: Difficulty, duration: number) => void;
  join: (code: string) => void;
  queue: (variant: Variant) => void;
  /** Currently waiting in the ranked queue. */
  queued?: boolean;
  cancelQueue?: () => void;
  /** Signed in with a verified email (random matchmaking only). */
  matchAllowed?: boolean;
  /** Account state is known, so a missing verification can be explained. */
  authReady?: boolean;
  /** Scenes an administrator paused for new games (`false` = paused). */
  sceneAccess?: Partial<Record<'practice' | 'daily' | 'friend' | 'ranked', boolean>>;
};
function OptionRow<T extends string | number>({ label, options, value, onChange, format, disabled }: {
  label: string; options: readonly T[]; value: T; onChange: (value: T) => void; format: (value: T) => string; disabled?: boolean;
}) {
  return <div className="option-row" role="group" aria-label={label}>
    <span className="opt-label">{label}</span>
    {options.map(option => <button type="button" key={String(option)} className={`opt-btn ${option === value ? 'active' : ''}`}
      aria-pressed={option === value} disabled={disabled} onClick={() => onChange(option)}>{format(option)}</button>)}
  </div>;
}
const HAND_MODES = ['unlimited', 'limited'] as const;

export default function CardLobby({
  scene, navigate, variant, setVariant, disabled, loading, start, join, queue,
  queued = false, cancelQueue, matchAllowed = true, authReady = true, sceneAccess = {},
}: Props) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`card.${key}`);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [soloDuration, setSoloDuration] = useState(0);
  const [roomDuration, setRoomDuration] = useState(180);
  const [code, setCode] = useState('');
  // The random-match card keeps its own hand mode, independent of the friend-room card.
  const [matchVariant, setMatchVariant] = useState<Variant>(variant);
  if (!scene) return <div className="menu-grid ent-menu-grid cl-modes">
    {lobbyScenes.map(value => {
      const card = SCENE_CARDS[value];
      // Name the entry by its mode; the one-line intro is announced as its description.
      return <button type="button" key={value} className="menu-card cl-mode" style={{ ['--menu-color' as string]: card.color }}
        aria-label={tr(card.title)} aria-describedby={`cl-mode-${value}-intro`} onClick={() => navigate(value)}>
        <span className="menu-icon" aria-hidden="true"><card.icon size={22} /></span>
        <span className="menu-copy"><span className="menu-label">{tr(card.title)}</span><span className="menu-description" id={`cl-mode-${value}-intro`}>{tr(card.intro)}</span></span>
        <ArrowUpRight className="menu-arrow" size={18} aria-hidden="true" />
      </button>;
    })}
  </div>;

  if (scene === 'friend') {
    const friendPaused = sceneAccess.friend === false;
    const rankedPaused = sceneAccess.ranked === false;
    return <section className="cl-multi" aria-label={tr('multiplayer')}>
      <div className="lobby-grid cl-lobby-grid">
        <div className="card multi-lobby-create-card">
          <h3><House size={16} aria-hidden="true" />{tr('create')}</h3>
          {friendPaused && <p role="status" className="muted">{tr('scenePaused')}</p>}
          <OptionRow label={tr('handMode')} options={HAND_MODES} value={variant} onChange={setVariant}
            disabled={loading || queued} format={value => tr(value)} />
          <OptionRow label={tr('difficulty')} options={['easy', 'normal', 'hard'] as const} value={difficulty}
            onChange={setDifficulty} disabled={loading || queued} format={value => tr(value)} />
          <OptionRow label={tr('time')} options={[120, 180, 300]} value={roomDuration}
            onChange={setRoomDuration} disabled={loading || queued} format={value => `${value} ${tr('seconds')}`} />
          <div className="cl-setup-action">
            <button className="btn btn-lg" disabled={disabled || queued || friendPaused}
              onClick={() => start('friend', difficulty, roomDuration)}>
              <Zap size={16} aria-hidden="true" />{tr('create')}
            </button>
          </div>
        </div>
        <div className="card multi-lobby-match-card">
          <h3><Dices size={16} aria-hidden="true" />{tr('randomMatch')}</h3>
          <p className="muted">{tr('rankedSettings')}</p>
          {authReady && !matchAllowed && <p className="muted matchmaking-requirement">{t('multi.matchVerifiedRequired')}</p>}
          {rankedPaused && <p role="status" className="muted">{tr('scenePaused')}</p>}
          <OptionRow label={tr('handMode')} options={HAND_MODES} value={matchVariant} onChange={setMatchVariant}
            disabled={loading || queued} format={value => tr(value)} />
          <div className="cl-setup-action cl-match-action">
            {queued && <p role="status" className="cl-searching">
              <span className="spinner matchmaking-spinner" aria-hidden="true" />{tr('queued')}
            </p>}
            {queued
              ? <button className="btn btn-ghost" disabled={loading} onClick={cancelQueue}><XCircle size={15} aria-hidden="true" />{tr('cancel')}</button>
              : <button className="btn btn-accent btn-lg" disabled={disabled || rankedPaused || !matchAllowed}
                onClick={() => queue(matchVariant)}><Dices size={16} aria-hidden="true" />{tr('startMatching')}</button>}
          </div>
        </div>
        <div className="card multi-lobby-join-card cl-join-room">
          <h3><DoorOpen size={16} aria-hidden="true" />{tr('joinRoom')}</h3><p className="muted">{tr('joinSettings')}</p>
          <div className="join-room-form"><input className="input" aria-label={tr('code')} placeholder={tr('code')} value={code} maxLength={8}
            autoComplete="off" disabled={queued} onChange={e => setCode(e.target.value.trim().toUpperCase())} />
            <button className="btn btn-success" disabled={loading || queued || !/^[0-9A-F]{8}$/.test(code)} onClick={() => join(code)}><DoorOpen size={15} aria-hidden="true" />{tr('join')}</button></div>
        </div>
      </div>
    </section>;
  }

  const solo = scene === 'practice';
  const paused = sceneAccess[scene] === false;
  return <section className="cl-setup" aria-label={tr('setup')}>
    <div className="card cl-setup-card">
      {paused && <p role="status" className="muted">{tr('scenePaused')}</p>}
      <OptionRow label={tr('handMode')} options={HAND_MODES} value={variant} onChange={setVariant}
        disabled={loading || queued} format={value => tr(solo ? `solo_${value}` : value)} />
      {solo ? <>
        <OptionRow label={tr('difficulty')} options={['easy', 'normal', 'hard'] as const} value={difficulty}
          onChange={setDifficulty} disabled={loading || queued} format={value => tr(value)} />
        <OptionRow label={tr('time')} options={[0, 120, 180, 300]} value={soloDuration}
          onChange={setSoloDuration} disabled={loading || queued}
          format={value => value ? `${value} ${tr('seconds')}` : tr('untimed')} />
        <p className="muted">{tr('soloExpiry')}</p>
      </> : <>
        <p className="muted">{tr('dailySettings')}</p>
        <p className="muted">{tr('dailyRankingRules')}</p>
      </>}
      <div className="cl-setup-action">
        <button className="btn btn-lg btn-green" disabled={disabled || queued || paused}
          onClick={() => start(scene, solo ? difficulty : 'normal', solo ? soloDuration : 0)}>
          <Play size={16} aria-hidden="true" />{tr('start')}
        </button>
      </div>
    </div>
  </section>;
}
