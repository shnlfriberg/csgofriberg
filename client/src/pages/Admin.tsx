import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { ChevronDown, Home, Menu, PanelLeftClose, PanelLeftOpen, Wrench, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ThemeToggle from '../components/ThemeToggle';
import AdminPlayers from '../components/admin/AdminPlayers';
import AdminAnnouncements from '../components/admin/AdminAnnouncements';
import AdminResourceVersion from '../components/admin/AdminResourceVersion';
import AdminUsers, { AdminGuests } from '../components/admin/AdminUsers';
import AdminApiTokens from '../components/admin/AdminApiTokens';
import AdminReports from '../components/admin/AdminReports';
import AdminPlayerChanges from '../components/admin/AdminPlayerChanges';
import AdminLocation from '../components/admin/AdminLocation';
import AdminDashboard from '../components/admin/AdminDashboard';
import { OnlinePill, usePresence } from '../components/admin/AdminPresence';
import { useAdminTab } from '../components/admin/useAdminTab';
import { useAdminCounts, type AdminCounts } from '../components/admin/useAdminCounts';
import {
  CARD_TABS,
  LOCATION_TABS,
  NAV_GROUPS,
  adminPath,
  resolveAdminRoute,
  type CardTab,
  type LocationTab,
  type NavGroup,
} from '../components/admin/nav';
import '../styles/admin-console.css';

const AdminCardLink = lazy(() => import('../components/admin/AdminCardLink'));
const RAIL_KEY = 'admin:sidebar-rail';

function readRail(): boolean {
  try { return localStorage.getItem(RAIL_KEY) === '1'; } catch { return false; }
}

const NARROW_QUERY = '(max-width: 960px)';
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

function badgeText(counts: AdminCounts, key: keyof AdminCounts | undefined): string | null {
  if (!key) return null;
  const value = counts[key];
  if (typeof value !== 'number' || value <= 0) return null;
  if (key === 'careers' && value >= 50) return '50+';
  return value > 99 ? '99+' : String(value);
}

export default function Admin() {
  const { t } = useTranslation();
  const rest = useParams()['*'] ?? '';
  const { pathname } = useLocation();
  const route = resolveAdminRoute(rest);
  const presence = usePresence();
  const { counts, loading: countsLoading, refresh } = useAdminCounts();
  const [locationTab, setLocationTab] = useAdminTab<LocationTab>('location', LOCATION_TABS, 'capture');
  const [cardTab, setCardTab] = useAdminTab<CardTab>('card-link', CARD_TABS, 'careers');
  const [locationVisited, setLocationVisited] = useState(false);
  const [cardVisited, setCardVisited] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Desktop only: fold the sidebar to an icon rail. Phones use the drawer instead.
  const [railPreference, setRailed] = useState(readRail);
  const narrow = useNarrowViewport();
  const railed = railPreference && !narrow;
  const toggleRail = () => setRailed((value) => {
    try { localStorage.setItem(RAIL_KEY, value ? '0' : '1'); } catch { /* Keep in-memory state. */ }
    return !value;
  });
  const section = route?.section;
  const tab = route?.tab;

  // Keep the heavy workspaces mounted after the first visit so unsaved capture queues survive navigation.
  useEffect(() => {
    if (section === 'location' && tab) {
      setLocationVisited(true);
      setLocationTab(tab as LocationTab);
    }
    if (section === 'card-link' && tab) {
      setCardVisited(true);
      setCardTab(tab as CardTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, tab]);

  useEffect(() => setNavOpen(false), [pathname]);
  // Entering a group opens it and keeps it open after leaving; the user can still fold it.
  const activeGroupId = route?.group?.id;
  useEffect(() => {
    if (activeGroupId) setExpanded((current) => current[activeGroupId] ? current : { ...current, [activeGroupId]: true });
  }, [activeGroupId]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const item = route?.item;
  const pageTitle = item ? t(item.label) : t('admin.title');
  useEffect(() => {
    document.title = `${pageTitle} · ${t('admin.title')} · ${t('common.brand')}`;
  }, [pageTitle, t]);

  if (!route) return <Navigate to="/admin" replace />;
  if (section === 'location' && !tab) return <Navigate to={adminPath(`location/${locationTab}`)} replace />;
  if (section === 'card-link' && !tab) return <Navigate to={adminPath(`card-link/${cardTab}`)} replace />;

  const groupOpen = (group: NavGroup) =>
    railed || (expanded[group.id] ?? (!group.collapsible || group === route.group));

  return (
    <div className={`admin-console${navOpen ? ' nav-open' : ''}${railed ? ' is-railed' : ''}`}>
      <a className="skip-link" href="#admin-main">{t('common.skipToContent')}</a>
      <aside className="admin-sidebar" id="admin-sidebar" aria-label={t('adminUi.navLabel')}>
        <div className="admin-brand">
          <Link to="/admin"><Wrench size={17} aria-hidden="true" /><span>{t('admin.title')}</span></Link>
          <button className="admin-icon-btn admin-nav-close" type="button" aria-label={t('adminUi.closeMenu')} onClick={() => setNavOpen(false)}>
            <X size={17} />
          </button>
        </div>
        <nav className="admin-nav">
          {NAV_GROUPS.map((group) => {
            const open = groupOpen(group);
            const groupBadge = !open
              ? group.items.map((entry) => badgeText(counts, entry.badge)).find(Boolean)
              : null;
            return (
              <div className="admin-nav-group" key={group.id}>
                <button
                  className="admin-nav-group-label is-toggle"
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpanded((current) => ({ ...current, [group.id]: !open }))}
                >
                  <span>{t(group.label)}</span>
                  {groupBadge && <span className="admin-nav-dot" aria-hidden="true" />}
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                {open && (
                  <ul>
                    {group.items.map((entry) => {
                      const Icon = entry.icon;
                      const active = entry === item;
                      const badge = badgeText(counts, entry.badge);
                      return (
                        <li key={entry.id}>
                          <Link className="admin-nav-link" to={adminPath(entry.id)} aria-current={active ? 'page' : undefined} title={railed ? t(entry.label) : undefined}>
                            <Icon size={16} aria-hidden="true" />
                            <span>{t(entry.label)}</span>
                            {badge && <span className="admin-nav-badge">{badge}</span>}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </nav>
        <div className="admin-sidebar-foot">
          <Link className="admin-nav-link" to="/" title={railed ? t('adminUi.backToGame') : undefined}><Home size={16} aria-hidden="true" /><span>{t('adminUi.backToGame')}</span></Link>
        </div>
      </aside>
      {navOpen && <button className="admin-scrim" type="button" aria-label={t('adminUi.closeMenu')} onClick={() => setNavOpen(false)} />}
      <div className="admin-main">
        <header className="admin-topbar">
          <button
            className="admin-icon-btn admin-menu-btn"
            type="button"
            aria-label={t('adminUi.openMenu')}
            aria-controls="admin-sidebar"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <Menu size={18} />
          </button>
          <button
            className="admin-icon-btn admin-rail-btn"
            type="button"
            aria-label={railed ? t('adminUi.expandSidebar') : t('adminUi.collapseSidebar')}
            title={railed ? t('adminUi.expandSidebar') : t('adminUi.collapseSidebar')}
            aria-controls="admin-sidebar"
            aria-expanded={!railed}
            onClick={toggleRail}
          >
            {railed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
          <nav className="admin-breadcrumb" aria-label={t('adminUi.breadcrumb')}>
            <ol>
              <li><Link to="/admin">{t('admin.title')}</Link></li>
              {route.group && route.group.id !== 'overview' && <li>{t(route.group.label)}</li>}
              {section !== 'dashboard' && <li aria-current="page">{pageTitle}</li>}
            </ol>
          </nav>
          <div className="admin-topbar-actions">
            <OnlinePill presence={presence} />
            <ThemeToggle />
          </div>
        </header>
        <main className="admin-content" id="admin-main" tabIndex={-1}>
          <header className="admin-page-head">
            <h1>{pageTitle}</h1>
            {item && <p>{t(item.description)}</p>}
          </header>
          {section === 'dashboard' && <AdminDashboard presence={presence} counts={counts} countsLoading={countsLoading} onRefresh={() => void refresh()} />}
          {section === 'users' && <AdminUsers />}
          {section === 'guests' && <AdminGuests />}
          {section === 'reports' && <AdminReports />}
          {section === 'players' && <AdminPlayers />}
          {section === 'player-changes' && <AdminPlayerChanges />}
          {section === 'announcements' && <AdminAnnouncements />}
          {section === 'api-tokens' && <AdminApiTokens />}
          {section === 'resources' && <AdminResourceVersion />}
          {(locationVisited || section === 'location') && (
            <div className="admin-keepalive" hidden={section !== 'location'}>
              <AdminLocation visible={section === 'location'} tab={section === 'location' && tab ? tab as LocationTab : locationTab} />
            </div>
          )}
          {(cardVisited || section === 'card-link') && (
            <div className="admin-keepalive" hidden={section !== 'card-link'}>
              <Suspense fallback={<p className="admin-loading" role="status">{t('common.loading')}</p>}>
                <AdminCardLink tab={section === 'card-link' && tab ? tab as CardTab : cardTab} />
              </Suspense>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
