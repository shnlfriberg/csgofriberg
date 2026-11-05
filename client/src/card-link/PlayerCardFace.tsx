import type { CardPlayer, Variant } from '@friberg/card-link-core';
import { useTranslation } from 'react-i18next';
import { countryLabel } from '../utils/playerGeography';

/** The same frozen player information for live cards and historical replays. */
export default function PlayerCardFace({ player, id, variant }: { player?: CardPlayer; id: number; variant?: Variant }) {
  const { t } = useTranslation();
  const hearts = variant === 'limited' && ['中国', 'china', 'cn', 'chn'].includes(player?.nationality.trim().toLowerCase() ?? '');
  const champion = variant === 'limited' && player?.majorChampion === true;
  const suit = hearts ? '♥' : '♠';
  return <>
    <div className="cl-card-corner" data-cl-hearts={hearts || undefined} data-cl-champion={champion || undefined}><span aria-hidden="true">{suit}</span><small>
      {player?.nationality ? countryLabel(t, player.nationality) : t('common.unknown')}
    </small></div>
    <div className="cl-card-identity"><small>ID</small><strong>{player?.nickname ?? id}</strong>
      <span className={`cl-card-suit${hearts ? ' cl-card-hearts' : ''}`} aria-hidden="true">{suit}</span>
      <span className="cl-card-age">{t('card.age')}: {player?.age ?? t('common.unknown')}</span>
    </div>
  </>;
}
