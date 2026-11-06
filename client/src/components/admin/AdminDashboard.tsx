import { AlertTriangle, ArrowRight, ClipboardCheck, Database, Gamepad2, Inbox, RefreshCw, Users, Workflow } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PresenceStats } from '../../types';
import { currentLocale } from '../../i18n';
import AdminPresence from './AdminPresence';
import type { AdminCounts } from './useAdminCounts';
import { Panel, StatCard } from './ui';

const TODO = [
  { key: 'reports', label: 'adminUi.todoReports', to: '/admin/reports', icon: AlertTriangle },
  { key: 'changes', label: 'adminUi.todoChanges', to: '/admin/player-changes', icon: ClipboardCheck },
  { key: 'submissions', label: 'adminUi.todoSubmissions', to: '/admin/location/submissions', icon: Inbox },
  { key: 'careers', label: 'adminUi.todoCareers', to: '/admin/card-link/reviews', icon: Workflow },
] as const;

function shown(value: number | null | undefined, cap?: number): string {
  if (value === undefined) return '…';
  if (value === null) return '—';
  return cap && value >= cap ? `${cap}+` : String(value);
}

export default function AdminDashboard({
  presence,
  counts,
  countsLoading,
  onRefresh,
}: {
  presence: PresenceStats | null;
  counts: AdminCounts;
  countsLoading: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const active = presence ? presence.singleGames + presence.multiplayerRooms : null;
  const updated = presence?.updatedAt ? new Date(presence.updatedAt).toLocaleTimeString(locale) : '';
  return (
    <div className="admin-dashboard">
      <div className="admin-stat-grid">
        <StatCard
          tone="primary"
          icon={<Users size={16} aria-hidden="true" />}
          label={t('adminUi.onlineNow')}
          value={presence?.onlineUsers ?? '—'}
          hint={presence ? (updated ? t('adminUi.liveUpdated', { time: updated }) : t('adminUi.liveTitle')) : t('adminUi.liveWaiting')}
        />
        <StatCard
          icon={<Gamepad2 size={16} aria-hidden="true" />}
          label={t('adminUi.activeGames')}
          value={active ?? '—'}
          hint={presence ? t('adminUi.activeGamesHint', { single: presence.singleGames, rooms: presence.multiplayerRooms }) : undefined}
        />
        <StatCard
          icon={<Users size={16} aria-hidden="true" />}
          label={t('adminUi.totalUsers')}
          value={shown(counts.users)}
          to="/admin/users"
        />
        <StatCard
          icon={<Database size={16} aria-hidden="true" />}
          label={t('adminUi.totalPlayers')}
          value={shown(counts.players)}
          to="/admin/players"
        />
      </div>
      <div className="admin-dashboard-grid">
        <Panel id="admin-live-title" title={t('adminUi.liveTitle')} className="admin-dashboard-live">
          <AdminPresence presence={presence} />
        </Panel>
        <Panel
          id="admin-todo-title"
          title={t('adminUi.todoTitle')}
          className="admin-dashboard-todo"
          actions={(
            <button className="admin-icon-btn" type="button" aria-label={t('adminUi.refresh')} title={t('adminUi.refresh')} disabled={countsLoading} onClick={onRefresh}>
              <RefreshCw size={15} className={countsLoading ? 'admin-spin' : undefined} />
            </button>
          )}
        >
          <ul className="admin-todo-list">
            {TODO.map(({ key, label, to, icon: Icon }) => {
              const value = counts[key];
              const pending = typeof value === 'number' && value > 0;
              return (
                <li key={key}>
                  <Link className={`admin-todo-item${pending ? ' is-pending' : ''}`} to={to}>
                    <span className="admin-todo-icon"><Icon size={16} aria-hidden="true" /></span>
                    <span className="admin-todo-label">{t(label)}</span>
                    <strong className="admin-todo-count" title={value === null ? t('adminUi.todoUnavailable') : undefined}>
                      {shown(value, key === 'careers' ? 50 : undefined)}
                    </strong>
                    <ArrowRight size={15} aria-hidden="true" className="admin-todo-arrow" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
