import type { Difficulty, Variant } from '@friberg/card-link-core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import CardLinkIcon from '../components/CardLinkIcon';

export type LobbyScene = 'practice' | 'daily' | 'friend' | 'ranked';
export const lobbyScenes: LobbyScene[] = ['practice', 'daily', 'friend', 'ranked'];
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
export default function CardLobby({ scene, navigate, variant, setVariant, disabled, loading, start, join, queue }: Props) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`card.${key}`);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [soloDuration, setSoloDuration] = useState(0);
  const [roomDuration, setRoomDuration] = useState(180);
  const [code, setCode] = useState('');
  if (!scene) return <div className="cl-modes">
    {lobbyScenes.map(value => <button key={value} className="cl-mode" onClick={() => navigate(value)}>
      <CardLinkIcon /><strong>{tr(value === 'friend' ? 'multiplayer' : value === 'ranked' ? 'randomMatch' : value)}</strong>
    </button>)}
  </div>;
  const solo = scene === 'practice';
  const configurable = solo || scene === 'friend';
  return <section className="cl-setup" aria-label={tr('setup')}>
    <div className="cl-toolbar"><button className="btn btn-ghost" onClick={() => navigate(null)}>← {tr('back')}</button>
      <h2>{tr(scene === 'friend' ? 'multiplayer' : scene === 'ranked' ? 'randomMatch' : scene)}</h2></div>
    <div className="cl-toolbar" role="group" aria-label={tr('handMode')}>
      {(['unlimited', 'limited'] as const).map(value => <button key={value} aria-pressed={variant === value}
        className={variant === value ? 'btn' : 'btn btn-ghost'} disabled={loading}
        onClick={() => setVariant(value)}>{tr(solo ? `solo_${value}` : value)}</button>)}
    </div>
    {configurable ? <div className="cl-toolbar">
      <label>{tr('difficulty')} <select value={difficulty} disabled={loading} onChange={e => setDifficulty(e.target.value as Difficulty)}>
        {(['easy', 'normal', 'hard'] as const).map(value => <option key={value} value={value}>{tr(value)}</option>)}
      </select></label>
      <label>{tr('time')} <select value={solo ? soloDuration : roomDuration} disabled={loading}
        onChange={e => (solo ? setSoloDuration : setRoomDuration)(Number(e.target.value))}>
        {solo && <option value={0}>{tr('untimed')}</option>}
        {[120, 180, 300].map(seconds => <option key={seconds} value={seconds}>{seconds} {tr('seconds')}</option>)}
      </select></label>
    </div> : <p className="muted">{tr(scene === 'ranked' ? 'rankedSettings' : 'dailySettings')}</p>}
    {solo && <p className="muted">{tr('soloExpiry')}</p>}
    {scene === 'daily' && <p className="muted">{tr('dailyRankingRules')}</p>}
    {scene === 'ranked' ? <button className="btn" disabled={disabled} onClick={queue}>{tr('startMatching')}</button> :
      <button className="btn" disabled={disabled} onClick={() => start(scene, configurable ? difficulty : 'normal', solo ? soloDuration : scene === 'friend' ? roomDuration : 0)}>
        {tr(scene === 'friend' ? 'create' : 'start')}
      </button>}
    {scene === 'friend' && <div className="cl-join-room">
      <h3>{tr('joinRoom')}</h3><p className="muted">{tr('joinSettings')}</p>
      <div className="cl-toolbar"><input aria-label={tr('code')} placeholder={tr('code')} value={code} maxLength={8}
        onChange={e => setCode(e.target.value.trim().toUpperCase())} />
        <button className="btn" disabled={loading || !/^[0-9A-F]{8}$/.test(code)} onClick={() => join(code)}>{tr('join')}</button></div>
    </div>}
  </section>;
}
