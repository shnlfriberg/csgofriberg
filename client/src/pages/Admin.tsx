import { useEffect, useState } from 'react';
import { Gamepad2, Swords, Users, Wrench } from 'lucide-react';
import Page from '../components/Page';
import AdminPlayers from '../components/admin/AdminPlayers';
import AdminAnnouncements from '../components/admin/AdminAnnouncements';
import AdminResourceVersion from '../components/admin/AdminResourceVersion';
import AdminUsers from '../components/admin/AdminUsers';
import AdminApiTokens from '../components/admin/AdminApiTokens';
import { getSocket } from '../api/socket';
import { PresenceStats } from '../types';
import { useTranslation } from 'react-i18next';

type Tab = 'players' | 'users' | 'announcements' | 'apiTokens' | 'resources';

export default function Admin() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('players');
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

  return (
    <Page title={t('admin.title')} icon={<Wrench size={17} />}>
      <section className="presence-grid" aria-label={t('admin.presence')}>
        <div className="presence-item">
          <Users size={20} />
          <span>{t('admin.online')}</span>
          <strong>{presence?.onlineUsers ?? '-'}</strong>
        </div>
        <div className="presence-item">
          <Swords size={20} />
          <span>{t('admin.multiRooms')}</span>
          <strong>{presence?.multiplayerRooms ?? '-'}</strong>
        </div>
        <div className="presence-item">
          <Gamepad2 size={20} />
          <span>{t('admin.singleGames')}</span>
          <strong>{presence?.singleGames ?? '-'}</strong>
        </div>
      </section>
      <div className="admin-tabs">
        <button className={tab === 'players' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('players')}>
          {t('admin.playersTab')}
        </button>
        <button className={tab === 'users' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('users')}>
          {t('admin.usersTab')}
        </button>
        <button className={tab === 'announcements' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('announcements')}>
          {t('admin.announcementsTab')}
        </button>
        <button className={tab === 'apiTokens' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('apiTokens')}>
          {t('admin.apiTokensTab')}
        </button>
        <button className={tab === 'resources' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('resources')}>
          {t('admin.resourcesTab')}
        </button>
      </div>
      {tab === 'players' && <AdminPlayers />}
      {tab === 'users' && <AdminUsers />}
      {tab === 'announcements' && <AdminAnnouncements />}
      {tab === 'apiTokens' && <AdminApiTokens />}
      {tab === 'resources' && <AdminResourceVersion />}
    </Page>
  );
}
