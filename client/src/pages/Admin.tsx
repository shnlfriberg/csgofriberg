import { lazy, Suspense } from 'react';
const AdminCardLink = lazy(() => import('../components/admin/AdminCardLink'));
import { useEffect, useState } from 'react';
import { AlertTriangle, ClipboardCheck, Wrench } from 'lucide-react';
import Page from '../components/Page';
import AdminPlayers from '../components/admin/AdminPlayers';
import AdminAnnouncements from '../components/admin/AdminAnnouncements';
import AdminResourceVersion from '../components/admin/AdminResourceVersion';
import AdminUsers, { AdminGuests } from '../components/admin/AdminUsers';
import AdminApiTokens from '../components/admin/AdminApiTokens';
import AdminReports from '../components/admin/AdminReports';
import AdminPlayerChanges from '../components/admin/AdminPlayerChanges';
import AdminLocation from '../components/admin/AdminLocation';
import AdminPresence from '../components/admin/AdminPresence';
import { getSocket } from '../api/socket';
import { PresenceStats } from '../types';
import { useTranslation } from 'react-i18next';
import { useAdminTab } from '../components/admin/useAdminTab';

type Tab = 'players' | 'playerChanges' | 'users' | 'guests' | 'reports' | 'announcements' | 'apiTokens' | 'resources' | 'location' | 'cardLink';
const tabs: Tab[] = ['players', 'playerChanges', 'users', 'guests', 'reports', 'announcements', 'apiTokens', 'resources', 'location', 'cardLink'];

export default function Admin() {
  const { t } = useTranslation();
  const [tab, setTab] = useAdminTab('main', tabs, 'players');
  const [cardVisited,setCardVisited]=useState(tab === 'cardLink');
  const [locationVisited, setLocationVisited] = useState(tab === 'location');
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
      <AdminPresence presence={presence} />
      <div className="admin-tabs"><button className={tab === 'cardLink' ? 'btn' : 'btn btn-ghost'} onClick={() => {setCardVisited(true);setTab('cardLink');}}>{t('card.admin')}</button>
        <button className={tab === 'players' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('players')}>
          {t('admin.playersTab')}
        </button>
        <button className={tab === 'playerChanges' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('playerChanges')}>
          <ClipboardCheck size={15} />
          {t('admin.playerChangesTab')}
        </button>
        <button className={tab === 'users' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('users')}>
          {t('admin.usersTab')}
        </button>
        <button className={tab === 'guests' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('guests')}>
          {t('admin.guestsTab')}
        </button>
        <button className={tab === 'reports' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('reports')}>
          <AlertTriangle size={15} />
          {t('admin.reportsTab')}
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
        <button className={tab === 'location' ? 'btn' : 'btn btn-ghost'} onClick={() => { setLocationVisited(true); setTab('location'); }}>{t('location.admin')}</button>
      </div>
      {tab === 'players' && <AdminPlayers />}
      {cardVisited && <div hidden={tab !== 'cardLink'}><Suspense fallback={<p>…</p>}><AdminCardLink /></Suspense></div>}
      {locationVisited && <div hidden={tab !== 'location'}><AdminLocation visible={tab === 'location'} /></div>}
      {tab === 'playerChanges' && <AdminPlayerChanges />}
      {tab === 'users' && <AdminUsers />}
      {tab === 'guests' && <AdminGuests />}
      {tab === 'reports' && <AdminReports />}
      {tab === 'announcements' && <AdminAnnouncements />}
      {tab === 'apiTokens' && <AdminApiTokens />}
      {tab === 'resources' && <AdminResourceVersion />}
    </Page>
  );
}
