import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PresenceStats } from '../../types';

const modes = [
  'classicSingle', 'classicDaily', 'classicRooms', 'relayRooms', 'relay2v2Rooms',
  'turtleSoup', 'locationDaily', 'locationRandom', 'locationRooms',
  'cardSingle', 'cardDaily', 'cardFriend', 'cardRanked',
] as const;

export default function AdminPresence({ presence }: { presence: PresenceStats | null }) {
  const { t } = useTranslation();
  return <section className="admin-presence-strip" aria-label={t('presence.label')} title={t('presence.hint')} tabIndex={0}>
    <dl className="admin-presence-items">
      <div className="admin-presence-online"><dt><Users size={16} aria-hidden="true" />{t('presence.online')}</dt><dd>{presence?.onlineUsers ?? '—'}</dd></div>
      {modes.map(mode => <div key={mode}><dt>{t(`presence.${mode}`)}</dt><dd>{presence?.modes?.[mode] ?? '—'}</dd></div>)}
    </dl>
  </section>;
}
