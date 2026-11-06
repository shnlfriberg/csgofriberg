import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getSocket } from '../../api/socket';
import type { PresenceStats } from '../../types';

type ModeKey = keyof NonNullable<PresenceStats['modes']>;

/** Modes grouped by game so the live view reads as four short lists instead of one long strip. */
const FAMILIES: Array<{ id: string; label: string; modes: ModeKey[] }> = [
  { id: 'classic', label: 'adminUi.familyClassic', modes: ['classicSingle', 'classicDaily', 'classicRooms', 'relayRooms', 'relay2v2Rooms'] },
  { id: 'soup', label: 'adminUi.familySoup', modes: ['turtleSoup'] },
  { id: 'location', label: 'adminUi.familyLocation', modes: ['locationDaily', 'locationRandom', 'locationRooms'] },
  { id: 'card', label: 'adminUi.familyCard', modes: ['cardSingle', 'cardDaily', 'cardFriend', 'cardRanked'] },
];

/** Subscribe to live presence for as long as the admin console is open. */
export function usePresence(): PresenceStats | null {
  const [presence, setPresence] = useState<PresenceStats | null>(null);
  useEffect(() => {
    const socket = getSocket();
    const onStats = (stats: PresenceStats) => setPresence(stats);
    const subscribe = () => socket.emit('presence:subscribe');
    socket.on('presence:stats', onStats);
    socket.on('connect', subscribe);
    if (socket.connected) subscribe();
    return () => {
      socket.emit('presence:unsubscribe');
      socket.off('presence:stats', onStats);
      socket.off('connect', subscribe);
    };
  }, []);
  return presence;
}

export function OnlinePill({ presence }: { presence: PresenceStats | null }) {
  const { t } = useTranslation();
  const count = presence?.onlineUsers;
  return (
    <Link className="admin-online-pill" to="/admin" title={t('adminUi.onlinePillTitle')} data-live={presence ? 'true' : 'false'}>
      <span className="admin-live-dot" aria-hidden="true" />
      {t('adminUi.onlinePill', { count: count ?? '—' })}
    </Link>
  );
}

/** Live online count and unfinished games per mode, grouped by game family. */
export default function AdminPresence({ presence }: { presence: PresenceStats | null }) {
  const { t } = useTranslation();
  const values = presence?.modes;
  const max = values ? Math.max(1, ...Object.values(values)) : 1;
  return (
    <section className="admin-presence" aria-label={t('presence.label')}>
      <dl className="admin-presence-total">
        <div className="admin-presence-online">
          <dt><Users size={16} aria-hidden="true" />{t('presence.online')}</dt>
          <dd>{presence?.onlineUsers ?? '—'}</dd>
        </div>
      </dl>
      <div className="admin-presence-families">
        {FAMILIES.map((family) => (
          <article className={`admin-presence-family is-${family.id}`} key={family.id}>
            <h3>{t(family.label)}</h3>
            <dl>
              {family.modes.map((mode) => {
                const value = values?.[mode];
                return (
                  <div key={mode}>
                    <dt>{t(`presence.${mode}`)}</dt>
                    <dd>{value ?? '—'}</dd>
                    <span className="admin-presence-bar" aria-hidden="true">
                      <i style={{ width: value ? `${Math.max(4, (value / max) * 100)}%` : 0 }} />
                    </span>
                  </div>
                );
              })}
            </dl>
          </article>
        ))}
      </div>
      <p className="admin-presence-hint">{t('presence.hint')}</p>
    </section>
  );
}
