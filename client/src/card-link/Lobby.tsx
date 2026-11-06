import type { Difficulty, Variant } from '@friberg/card-link-core';
import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, CalendarDays, Dices, DoorOpen, Gamepad2, Play, Users, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type LobbyScene = 'practice' | 'daily' | 'friend' | 'ranked';
export const lobbyScenes: LobbyScene[] = ['practice', 'daily', 'friend', 'ranked'];
/** Mode entries reuse the home menu card look and palette. */
const SCENE_CARDS: Record<LobbyScene, { icon: typeof Gamepad2; color: string; title: string; intro: string }> = {
  practice: { icon: Gamepad2, color: '#74e38f', title: 'practice', intro: 'practiceIntro' },
  daily: { icon: CalendarDays, color: '#f25f5c', title: 'daily', intro: 'dailyIntro' },
  friend: { icon: Users, color: '#ffb64e', title: 'multiplayer', intro: 'multiplayerIntro' },
  ranked: { icon: Dices, color: '#65a8ff', title: 'randomMatch', intro: 'randomMatchIntro' },
};
type Props = {
  scene: LobbyScene | null;
  navigate: (scene: LobbyScene | null) => void;
  variant: Variant;
  setVariant: (variant: Variant) => void;
  disabled: boolean;
  loading: boolean;
  start: (scene: Exclude<LobbyScene, 'ranked'>, difficulty: Difficulty, duration: number) => void;
  join: (code: string) => void;
  queue: () => void;
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
export default function CardLobby({ scene, navigate, variant, setVariant, disabled, loading, start, join, queue }: Props) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`card.${key}`);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [soloDuration, setSoloDuration] = useState(0);
  const [roomDuration, setRoomDuration] = useState(180);
  const [code, setCode] = useState('');
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
  const solo = scene === 'practice';
  const configurable = solo || scene === 'friend';
  const SceneIcon = SCENE_CARDS[scene].icon;
  return <section className="cl-setup" aria-label={tr('setup')}>
    <div className="card cl-setup-card">
      <div className="cl-setup-heading">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(null)}><ArrowLeft size={15} aria-hidden="true" />{tr('back')}</button>
        <h3><SceneIcon size={16} aria-hidden="true" />{tr(SCENE_CARDS[scene].title)}</h3>
      </div>
      <OptionRow label={tr('handMode')} options={['unlimited', 'limited'] as const} value={variant} onChange={setVariant}
        disabled={loading} format={value => tr(solo ? `solo_${value}` : value)} />
      {configurable ? <>
        <OptionRow label={tr('difficulty')} options={['easy', 'normal', 'hard'] as const} value={difficulty}
          onChange={setDifficulty} disabled={loading} format={value => tr(value)} />
        <OptionRow label={tr('time')} options={solo ? [0, 120, 180, 300] : [120, 180, 300]} value={solo ? soloDuration : roomDuration}
          onChange={solo ? setSoloDuration : setRoomDuration} disabled={loading}
          format={value => value ? `${value} ${tr('seconds')}` : tr('untimed')} />
      </> : <p className="muted">{tr(scene === 'ranked' ? 'rankedSettings' : 'dailySettings')}</p>}
      {solo && <p className="muted">{tr('soloExpiry')}</p>}
      {scene === 'daily' && <p className="muted">{tr('dailyRankingRules')}</p>}
      <div className="cl-setup-action">
        {scene === 'ranked' ? <button className="btn btn-accent btn-lg" disabled={disabled} onClick={queue}><Dices size={16} aria-hidden="true" />{tr('startMatching')}</button> :
          <button className={scene === 'friend' ? 'btn btn-lg' : 'btn btn-lg btn-green'} disabled={disabled}
            onClick={() => start(scene, configurable ? difficulty : 'normal', solo ? soloDuration : scene === 'friend' ? roomDuration : 0)}>
            {scene === 'friend' ? <Zap size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            {tr(scene === 'friend' ? 'create' : 'start')}
          </button>}
      </div>
    </div>
    {scene === 'friend' && <div className="card cl-join-room">
      <h3><DoorOpen size={16} aria-hidden="true" />{tr('joinRoom')}</h3><p className="muted">{tr('joinSettings')}</p>
      <div className="join-room-form"><input className="input" aria-label={tr('code')} placeholder={tr('code')} value={code} maxLength={8}
        autoComplete="off" onChange={e => setCode(e.target.value.trim().toUpperCase())} />
        <button className="btn btn-success" disabled={loading || !/^[0-9A-F]{8}$/.test(code)} onClick={() => join(code)}><DoorOpen size={15} aria-hidden="true" />{tr('join')}</button></div>
    </div>}
  </section>;
}
