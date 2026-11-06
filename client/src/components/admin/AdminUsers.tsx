import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarChart3,
  History,
  ListTree,
  Play,
  Settings,
  Swords,
  Trophy,
  User,
  type LucideIcon,
} from 'lucide-react';
import { api, errMsg } from '../../api/client';
import type { PlayerPerformanceStats } from '../../types';
import DataTable, { Column } from '../DataTable';
import { toast } from '../Toast';
import Badge from '../Badge';
import ReplayDialog, { type MultiReplay, type Replay, type SingleReplay } from '../ReplayDialog';
import { useTranslation } from 'react-i18next';
import { difficultyLabel } from '../../utils/difficulty';
import { currentLocale } from '../../i18n';
import ExternalAnalysisPanel, { type ExternalAnalysisView } from './ExternalAnalysisPanel';
import AdminDialog from './AdminDialog';
import { Panel, Pagination, SearchBox, SimplePager, SwitchRow, Toolbar, formatDateTime } from './ui';

export interface AdminUser {
  id: number;
  username: string;
  displayId: string;
  role: 'user' | 'admin';
  leaderboardHidden: boolean;
  matchmakingRestricted: boolean;
  email: string | null;
  emailVerified: boolean;
  banned: boolean;
  createdAt: string;
}

interface UserPage {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export interface AdminGuest { id: number; displayId: string; banned: boolean; createdAt: string; lastSeenAt: string }
interface GuestPage { guests: AdminGuest[]; total: number; page: number; pageSize: number; totalPages: number }

interface UserStatsView { user: AdminUser; stats: PlayerPerformanceStats }
interface SingleUserGame {
  type: 'single'; id: number; mode: string; variant?: 'classic' | 'turtle-soup'; status: string; guessCount: number; questionCount?: number; answer: string; finishedAt: string;
}
interface MultiUserGame {
  type: 'multi'; id: number; mode: string; boType: number; gameMode?: 'classic' | 'relay';
  totalRounds?: number; relaySolvedRounds?: number; result: 'won' | 'lost' | 'draw' | 'cooperative';
  me: { score: number }; opponent: { displayId: string; score: number } | null; finishedAt: string;
}
type UserGame = SingleUserGame | MultiUserGame;
interface UserGamePage { type: 'single' | 'multi'; page: number; pageSize: number; hasNext: boolean; items: UserGame[] }
interface LeaderboardEntry {
  mode: 'single' | 'multi'; difficulty: string; rank: number | null; totalRanked: number;
  total: number; wins: number; winRate: number; avgGuesses: number | null;
}
interface LeaderboardView { leaderboardHidden: boolean; entries: LeaderboardEntry[] }
type DetailTab = 'stats' | 'games' | 'leaderboards' | 'analysis' | 'manage';

const PAGE_SIZE_OPTIONS = [20, 50, 100];

function formatWinRate(value: number): string { return `${(value * 100).toFixed(1)}%`; }

/** Tab strip for the record drawers. */
function DetailTabs<T extends string>({ label, tabs, value, onChange }: {
  label: string;
  tabs: Array<{ key: T; label: string; icon: LucideIcon }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="admin-detail-tabs" role="tablist" aria-label={label}>
      {tabs.map(({ key, label: text, icon: Icon }) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} onClick={() => onChange(key)}>
          <Icon size={15} aria-hidden="true" />{text}
        </button>
      ))}
    </div>
  );
}

/** Paged single / multiplayer history for a user or a guest. Replays are only offered for registered users. */
function GameHistory({ endpoint, replay }: {
  endpoint: string;
  replay?: { userId: number; onOpenChange?: (open: boolean) => void };
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [type, setType] = useState<'single' | 'multi'>('single');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<UserGame[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [openReplay, setOpenReplay] = useState<Replay | null>(null);
  const [replayLoadingId, setReplayLoadingId] = useState<number | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    api.get<UserGamePage>(endpoint, { params: { type, page, pageSize: 10 } })
      .then((res) => {
        if (currentRequest !== requestId.current) return;
        setItems(res.data.items);
        setHasNext(res.data.hasNext);
      })
      .catch((err) => { if (currentRequest === requestId.current) toast.error(errMsg(err)); })
      .finally(() => { if (currentRequest === requestId.current) setLoading(false); });
  }, [endpoint, page, type]);

  const showReplay = async (game: UserGame) => {
    if (!replay) return;
    setReplayLoadingId(game.id);
    try {
      if (game.type === 'single') {
        const res = await api.get<Omit<SingleReplay, 'type'>>(`/admin/users/${replay.userId}/games/${game.id}/replay`);
        setOpenReplay({ type: 'single', ...res.data });
      } else {
        const res = await api.get<Omit<MultiReplay, 'type'>>(`/admin/users/${replay.userId}/matches/${game.id}/replay`);
        setOpenReplay({ type: 'multi', ...res.data });
      }
      replay.onOpenChange?.(true);
    } catch (err) { toast.error(errMsg(err)); }
    finally { setReplayLoadingId(null); }
  };

  const switchType = (next: 'single' | 'multi') => { setType(next); setPage(1); setItems([]); };

  return (
    <>
      <div className="stats-replay-segments admin-user-game-tabs" role="tablist" aria-label={t('admin.gameType')}>
        <button type="button" role="tab" aria-selected={type === 'single'} className={type === 'single' ? 'active' : ''} onClick={() => switchType('single')}>
          <User size={15} />{t('admin.single')}
        </button>
        <button type="button" role="tab" aria-selected={type === 'multi'} className={type === 'multi' ? 'active' : ''} onClick={() => switchType('multi')}>
          <Swords size={15} />{t('admin.multi')}
        </button>
      </div>
      <div className="admin-user-game-list">
        {items.length ? items.map((game) => {
          const result = game.type === 'single' ? game.status : game.result;
          const label = result === 'cooperative' && game.type === 'multi'
            ? t('multi.relayProgress', { solved: game.relaySolvedRounds ?? 0, total: game.totalRounds ?? 0 })
            : result === 'won' ? t('common.win') : result === 'draw' ? t('common.draw') : t('common.loss');
          return (
            <article className="admin-user-game-item" key={`${game.type}:${game.id}`}>
              <div className="admin-user-game-heading">
                <strong>{game.type === 'single' ? `${difficultyLabel(t, game.mode)}${game.variant === 'turtle-soup' ? ` · ${t('soup.shortTitle')}` : ''}` : game.gameMode === 'relay' ? `${difficultyLabel(t, game.mode)} · ${t('multi.relayMode')}` : `${difficultyLabel(t, game.mode)} · BO${game.boType}`}</strong>
                <Badge text={label} color={result === 'won' || result === 'cooperative' ? 'green' : 'gray'} />
              </div>
              <div className="admin-user-game-details">
                {game.type === 'single' ? <>
                  <span>{t('stats.answer')} <strong>{game.answer}</strong></span>
                  {game.variant === 'turtle-soup' && <span>{t('soup.questionCount')} <strong>{game.questionCount ?? 0}</strong></span>}
                  <span>{t(game.variant === 'turtle-soup' ? 'soup.guessCount' : 'stats.guesses')} <strong>{game.guessCount}</strong></span>
                </> : <>
                  <span>{t('admin.opponent')} <strong>{game.opponent?.displayId ?? t('stats.unknownOpponent')}</strong></span>
                  {game.gameMode !== 'relay' && <span>{t('stats.score')} <strong>{game.me.score}:{game.opponent?.score ?? 0}</strong></span>}
                </>}
              </div>
              <div className="admin-user-game-footer">
                <time dateTime={game.finishedAt}>{formatDateTime(game.finishedAt, locale)}</time>
                {replay && (
                  <button className="admin-action" type="button" disabled={replayLoadingId !== null} onClick={() => void showReplay(game)}>
                    <Play size={14} />{replayLoadingId === game.id ? t('stats.loading') : t('stats.replay')}
                  </button>
                )}
              </div>
            </article>
          );
        }) : <p className="muted admin-user-game-empty">{loading ? t('common.loading') : type === 'single' ? t('admin.noSingleGames') : t('admin.noMultiGames')}</p>}
      </div>
      <SimplePager page={page} hasNext={hasNext} loading={loading} onPage={setPage} />
      {openReplay && <ReplayDialog replay={openReplay} onClose={() => { setOpenReplay(null); replay?.onOpenChange?.(false); }} showDecisionTimes />}
    </>
  );
}

function StatsTab({ stats }: { stats: PlayerPerformanceStats | null }) {
  const { t } = useTranslation();
  if (!stats) return <p className="muted admin-user-detail-loading">{t('common.loading')}</p>;
  const { single, multi } = stats;
  return <div className="admin-user-stats-grid">
    <section><h3>{t('multi.singleStats')}</h3><dl className="player-stats-list">
      <div><dt>{t('multi.games')}</dt><dd>{single.games}</dd></div>
      <div><dt>{t('multi.winsLosses')}</dt><dd>{single.wins} / {single.losses}</dd></div>
      <div><dt>{t('multi.winRate')}</dt><dd>{formatWinRate(single.winRate)}</dd></div>
      <div><dt>{t('multi.avgWinningGuesses')}</dt><dd>{single.avgGuesses?.toFixed(1) ?? '-'}</dd></div>
      <div><dt>{t('multi.fastest')}</dt><dd>{single.bestGuesses ?? '-'}</dd></div>
    </dl></section>
    <section><h3>{t('multi.multiStats')}</h3><dl className="player-stats-list">
      <div><dt>{t('multi.games')}</dt><dd>{multi.games}</dd></div>
      <div><dt>{t('multi.winsLosses')}</dt><dd>{multi.wins} / {multi.losses}</dd></div>
      <div><dt>{t('multi.winRate')}</dt><dd>{formatWinRate(multi.winRate)}</dd></div>
      <div><dt>{t('multi.recentWinningGuessAverage')}</dt><dd>{multi.recentAverageWinningGuesses?.toFixed(1) ?? '-'}</dd></div>
    </dl></section>
  </div>;
}

function LeaderboardsTab({ view, updating, onToggle }: { view: LeaderboardView | null; updating: boolean; onToggle: (hidden: boolean) => void }) {
  const { t } = useTranslation();
  if (!view) return <p className="muted admin-user-detail-loading">{t('common.loading')}</p>;
  return <div className="admin-form-stack">
    <SwitchRow
      title={t('admin.leaderboardVisibility')}
      description={t('admin.leaderboardVisibilityHint')}
      checked={!view.leaderboardHidden}
      disabled={updating}
      onChange={(visible) => onToggle(!visible)}
      onText={t('admin.leaderboardVisible')}
      offText={t('admin.leaderboardHidden')}
    />
    <div className="admin-user-ranking-grid">
      {view.entries.map((entry) => <article key={`${entry.mode}:${entry.difficulty}`}>
        <div><strong>{difficultyLabel(t, entry.difficulty)}</strong><Badge text={t(`admin.${entry.mode}`)} color={entry.mode === 'single' ? 'green' : 'gray'} /></div>
        <b>{entry.rank == null ? '-' : `#${entry.rank}`}</b>
        <span>{t('admin.rankPopulation', { count: entry.totalRanked })}</span>
        <small>{t('admin.rankRecord', { wins: entry.wins, total: entry.total, rate: formatWinRate(entry.winRate) })}</small>
      </article>)}
    </div>
  </div>;
}

function useStats(endpoint: string, active: boolean) {
  const [stats, setStats] = useState<PlayerPerformanceStats | null>(null);
  const requested = useRef(false);
  useEffect(() => {
    if (!active || requested.current) return;
    requested.current = true;
    api.get(endpoint)
      .then((response) => setStats(response.data.stats))
      .catch((error) => { requested.current = false; toast.error(errMsg(error)); });
  }, [active, endpoint]);
  return stats;
}

function useAnalysis(endpoint: string) {
  const [analysis, setAnalysis] = useState<ExternalAnalysisView | null>(null);
  const [loading, setLoading] = useState(false);
  const run = async (locale: string) => {
    setLoading(true);
    try {
      const response = await api.post<ExternalAnalysisView>(endpoint, { locale });
      setAnalysis(response.data);
    } catch (error) { toast.error(errMsg(error)); }
    finally { setLoading(false); }
  };
  return { analysis, loading, run };
}

export function GuestDetailDialog({ guest, onClose, onGuestChange }: { guest: AdminGuest; onClose: () => void; onGuestChange: (guest: AdminGuest) => void }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [tab, setTab] = useState<'stats' | 'games' | 'analysis' | 'manage'>('stats');
  const stats = useStats(`/admin/guests/${guest.id}/stats`, tab === 'stats');
  const analysis = useAnalysis(`/admin/guests/${guest.id}/analysis`);
  const [updating, setUpdating] = useState(false);
  const updateBan = async (banned: boolean) => {
    setUpdating(true);
    try {
      await api.patch(`/admin/guests/${guest.id}/ban`, { banned });
      onGuestChange({ ...guest, banned });
      toast.success(banned ? t('admin.bannedSuccess') : t('admin.unbannedSuccess'));
    } catch (error) { toast.error(errMsg(error)); }
    finally { setUpdating(false); }
  };
  const banSwitch = (
    <SwitchRow title={t('admin.banStatus')} checked={guest.banned} disabled={updating} onChange={(value) => void updateBan(value)} onText={t('admin.banned')} offText={t('admin.notBanned')} />
  );
  return (
    <AdminDialog
      variant="drawer"
      title={t('admin.guestDetail')}
      subtitle={<>{guest.displayId}<span className="admin-detail-summary"><Badge text={guest.banned ? t('admin.banned') : t('admin.notBanned')} color={guest.banned ? 'gray' : 'green'} /></span></>}
      onClose={onClose}
      className="admin-user-detail-dialog"
    >
      <DetailTabs
        label={t('admin.guestDetail')}
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'stats', label: t('admin.detailStats'), icon: BarChart3 },
          { key: 'games', label: t('admin.gameRecords'), icon: History },
          { key: 'analysis', label: t('admin.detailAnalysis'), icon: ListTree },
          { key: 'manage', label: t('admin.quickManagement'), icon: Settings },
        ]}
      />
      {tab === 'stats' && <StatsTab stats={stats} />}
      {tab === 'games' && <GameHistory endpoint={`/admin/guests/${guest.id}/games`} />}
      {tab === 'analysis' && <div className="admin-form-stack">
        {banSwitch}
        <ExternalAnalysisPanel view={analysis.analysis} loading={analysis.loading} onAnalyze={(value) => void analysis.run(value)} />
      </div>}
      {tab === 'manage' && <div className="admin-form-stack">
        <dl className="admin-kv">
          <dt>{t('admin.anonymousId')}</dt><dd>{guest.displayId}</dd>
          <dt>{t('admin.lastSeenAt')}</dt><dd>{formatDateTime(guest.lastSeenAt, locale)}</dd>
        </dl>
        {banSwitch}
      </div>}
    </AdminDialog>
  );
}

export function UserDetailDialog({ user, onClose, onUserChange }: { user: AdminUser; onClose: () => void; onUserChange: (user: AdminUser) => void }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [tab, setTab] = useState<DetailTab>('stats');
  const stats = useStats(`/admin/users/${user.id}/stats`, tab === 'stats');
  const [leaderboards, setLeaderboards] = useState<LeaderboardView | null>(null);
  const analysis = useAnalysis(`/admin/users/${user.id}/analysis`);
  const [visibilityUpdating, setVisibilityUpdating] = useState(false);
  const [restrictionUpdating, setRestrictionUpdating] = useState(false);
  const [banUpdating, setBanUpdating] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const leaderboardsRequested = useRef(false);

  useEffect(() => {
    if (tab !== 'leaderboards' || leaderboardsRequested.current) return;
    leaderboardsRequested.current = true;
    api.get(`/admin/users/${user.id}/leaderboards`)
      .then((res) => setLeaderboards(res.data as LeaderboardView))
      .catch((err) => { leaderboardsRequested.current = false; toast.error(errMsg(err)); });
  }, [tab, user.id]);

  const updateVisibility = async (hidden: boolean) => {
    setVisibilityUpdating(true);
    try {
      await api.patch(`/admin/users/${user.id}/leaderboard-visibility`, { hidden });
      onUserChange({ ...user, leaderboardHidden: hidden });
      setLeaderboards((current) => current ? { ...current, leaderboardHidden: hidden } : current);
      toast.success(hidden ? t('admin.leaderboardHiddenSuccess') : t('admin.leaderboardVisibleSuccess'));
    } catch (err) { toast.error(errMsg(err)); }
    finally { setVisibilityUpdating(false); }
  };

  const updateMatchmakingRestriction = async (restricted: boolean) => {
    setRestrictionUpdating(true);
    try {
      await api.patch(`/admin/users/${user.id}/matchmaking-restriction`, { restricted });
      onUserChange({ ...user, matchmakingRestricted: restricted });
      toast.success(restricted ? t('admin.matchmakingRestrictedSuccess') : t('admin.matchmakingRestoredSuccess'));
    } catch (err) { toast.error(errMsg(err)); }
    finally { setRestrictionUpdating(false); }
  };

  const updateBan = async (banned: boolean) => {
    setBanUpdating(true);
    try {
      await api.patch(`/admin/users/${user.id}/ban`, { banned });
      onUserChange({ ...user, banned });
      toast.success(banned ? t('admin.bannedSuccess') : t('admin.unbannedSuccess'));
    } catch (err) { toast.error(errMsg(err)); }
    finally { setBanUpdating(false); }
  };

  const emailText = user.email ? `${user.email} · ${user.emailVerified ? t('admin.emailVerified') : t('admin.emailUnverified')}` : t('admin.noEmail');
  const banSwitch = <SwitchRow title={t('admin.banStatus')} description={emailText} checked={user.banned} disabled={banUpdating} onChange={(value) => void updateBan(value)} onText={t('admin.banned')} offText={t('admin.notBanned')} />;
  const restrictionSwitch = <SwitchRow title={t('admin.matchmakingRestriction')} checked={user.matchmakingRestricted} disabled={restrictionUpdating} onChange={(value) => void updateMatchmakingRestriction(value)} onText={t('admin.matchmakingRestricted')} offText={t('admin.matchmakingNormal')} />;

  return (
    <AdminDialog
      variant="drawer"
      title={t('admin.userDetail')}
      subtitle={<>{user.username} · {user.displayId}<UserBadges user={user} /></>}
      onClose={onClose}
      suspended={replayOpen}
      className="admin-user-detail-dialog"
    >
      <DetailTabs
        label={t('admin.userDetail')}
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'stats', label: t('admin.detailStats'), icon: BarChart3 },
          { key: 'games', label: t('admin.gameRecords'), icon: History },
          { key: 'leaderboards', label: t('admin.detailLeaderboards'), icon: Trophy },
          { key: 'analysis', label: t('admin.detailAnalysis'), icon: ListTree },
          { key: 'manage', label: t('admin.quickManagement'), icon: Settings },
        ]}
      />
      {tab === 'stats' && <StatsTab stats={stats} />}
      {tab === 'games' && <GameHistory endpoint={`/admin/users/${user.id}/games`} replay={{ userId: user.id, onOpenChange: setReplayOpen }} />}
      {tab === 'leaderboards' && <LeaderboardsTab view={leaderboards} updating={visibilityUpdating} onToggle={(hidden) => void updateVisibility(hidden)} />}
      {tab === 'analysis' && <div className="admin-form-stack">
        <div className="admin-switch-list">{banSwitch}{restrictionSwitch}</div>
        <ExternalAnalysisPanel view={analysis.analysis} loading={analysis.loading} onAnalyze={(value) => void analysis.run(value)} />
      </div>}
      {tab === 'manage' && <div className="admin-form-stack">
        <dl className="admin-kv">
          <dt>{t('admin.username')}</dt><dd>{user.username}</dd>
          <dt>{t('admin.anonymousId')}</dt><dd>{user.displayId}</dd>
          <dt>{t('admin.permission')}</dt><dd>{user.role === 'admin' ? t('admin.adminRole') : t('admin.userRole')}</dd>
          <dt>{t('admin.email')}</dt><dd>{emailText}</dd>
          <dt>{t('admin.createdAt')}</dt><dd>{formatDateTime(user.createdAt, locale)}</dd>
        </dl>
        <div className="admin-switch-list">
          {banSwitch}
          {restrictionSwitch}
          <SwitchRow title={t('admin.leaderboardVisibility')} checked={!user.leaderboardHidden} disabled={visibilityUpdating} onChange={(visible) => void updateVisibility(!visible)} onText={t('admin.leaderboardVisible')} offText={t('admin.leaderboardHidden')} />
        </div>
      </div>}
    </AdminDialog>
  );
}

function UserBadges({ user }: { user: Pick<AdminUser, 'banned' | 'matchmakingRestricted' | 'leaderboardHidden'> }) {
  const { t } = useTranslation();
  const flags = [
    user.banned && t('admin.banned'),
    user.matchmakingRestricted && t('adminUi.badgeRestricted'),
    user.leaderboardHidden && t('adminUi.badgeHidden'),
  ].filter(Boolean) as string[];
  return (
    <span className="admin-badges admin-detail-summary">
      {flags.length ? flags.map((flag) => <Badge key={flag} text={flag} color={flag === t('admin.banned') ? 'amber' : 'gray'} />) : <Badge text={t('adminUi.normal')} color="green" />}
    </span>
  );
}

function usePagedList<T>(endpoint: string, key: 'users' | 'guests', defaultPageSize = 50) {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const res = await api.get<UserPage & GuestPage>(endpoint, { params: { page, pageSize, search: search || undefined } });
      if (currentRequest !== requestId.current) return;
      const list = res.data?.[key];
      setRows(Array.isArray(list) ? list as T[] : []);
      setTotal(Number(res.data?.total ?? 0));
      if (res.data?.page && res.data.page !== page) setPage(res.data.page);
    } catch (err) { if (currentRequest === requestId.current) toast.error(errMsg(err)); }
    finally { if (currentRequest === requestId.current) setLoading(false); }
  }, [endpoint, key, page, pageSize, search]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setSearch(searchInput.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  return { rows, setRows, total, page, setPage, pageSize, setPageSize, searchInput, setSearchInput, search, loading };
}

export function AdminGuests() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const list = usePagedList<AdminGuest>('/admin/guests', 'guests');
  const [detail, setDetail] = useState<AdminGuest | null>(null);
  const replace = (updated: AdminGuest) => list.setRows((current) => current.map((item) => item.id === updated.id ? updated : item));
  const toggle = async (guest: AdminGuest) => {
    try {
      await api.patch(`/admin/guests/${guest.id}/ban`, { banned: !guest.banned });
      replace({ ...guest, banned: !guest.banned });
      setDetail((current) => current?.id === guest.id ? { ...current, banned: !current.banned } : current);
      toast.success(!guest.banned ? t('admin.bannedSuccess') : t('admin.unbannedSuccess'));
    } catch (error) { toast.error(errMsg(error)); }
  };
  const columns: Column<AdminGuest>[] = [
    { key: 'displayId', title: t('admin.anonymousId'), render: (guest) => <strong>{guest.displayId}</strong> },
    { key: 'createdAt', title: t('admin.createdAt'), render: (guest) => formatDateTime(guest.createdAt, locale) },
    { key: 'lastSeenAt', title: t('admin.lastSeenAt'), render: (guest) => formatDateTime(guest.lastSeenAt, locale) },
    { key: 'banned', title: t('admin.banStatus'), render: (guest) => <Badge text={guest.banned ? t('admin.banned') : t('admin.notBanned')} color={guest.banned ? 'amber' : 'green'} /> },
    {
      key: 'actions',
      title: t('admin.actions'),
      render: (guest) => (
        <span className="admin-row-actions">
          <button type="button" className="admin-action" onClick={() => setDetail(guest)}>{t('admin.details')}</button>
          <button type="button" className={`admin-action${guest.banned ? '' : ' is-danger'}`} onClick={() => void toggle(guest)}>{guest.banned ? t('admin.unban') : t('admin.ban')}</button>
        </span>
      ),
    },
  ];
  return <>
    <Panel flush className="admin-list-panel">
      <Toolbar>
        <SearchBox value={list.searchInput} onChange={list.setSearchInput} placeholder={t('admin.searchGuests')} />
        <span className="admin-toolbar-meta">{t('admin.totalGuests', { count: list.total })}</span>
      </Toolbar>
      <div className="admin-table"><DataTable columns={columns} rows={list.rows} rowKey={(guest) => guest.id} loading={list.loading} empty={list.search ? t('admin.noMatchGuests') : t('admin.noGuests')} /></div>
      <Pagination page={list.page} pageSize={list.pageSize} total={list.total} totalPages={Math.ceil(list.total / list.pageSize)} loading={list.loading} onPage={list.setPage} />
    </Panel>
    {detail && <GuestDetailDialog guest={detail} onClose={() => setDetail(null)} onGuestChange={(updated) => { setDetail(updated); replace(updated); }} />}
  </>;
}

export default function AdminUsers() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const list = usePagedList<AdminUser>('/admin/users', 'users');
  const [detailUser, setDetailUser] = useState<AdminUser | null>(null);

  const updateUser = (updated: AdminUser) => {
    list.setRows((current) => current.map((item) => item.id === updated.id ? updated : item));
    setDetailUser(updated);
  };
  const columns: Column<AdminUser>[] = [
    {
      key: 'username',
      title: t('adminUi.userColumn'),
      render: (user) => <span className="admin-cell-stack"><strong>{user.username}</strong><small>{user.displayId}</small></span>,
    },
    {
      key: 'email',
      title: t('admin.email'),
      render: (user) => user.email
        ? <span className="admin-cell-stack"><span>{user.email}</span><small>{user.emailVerified ? t('admin.emailVerified') : t('admin.emailUnverified')}</small></span>
        : <span className="muted">—</span>,
    },
    { key: 'role', title: t('admin.permission'), render: (user) => user.role === 'admin' ? <Badge text={t('admin.adminRole')} color="amber" /> : t('admin.userRole') },
    { key: 'status', title: t('adminUi.statusColumn'), render: (user) => <UserBadges user={user} /> },
    { key: 'createdAt', title: t('admin.createdAt'), render: (user) => formatDateTime(user.createdAt, locale) },
    { key: 'actions', title: t('admin.actions'), render: (user) => <button type="button" className="admin-action" onClick={() => setDetailUser(user)}>{t('admin.details')}</button> },
  ];
  return <>
    <Panel flush className="admin-list-panel">
      <Toolbar>
        <SearchBox value={list.searchInput} onChange={list.setSearchInput} placeholder={t('admin.searchUsers')} />
        <span className="admin-toolbar-meta">{t('admin.totalUsers', { count: list.total })}</span>
      </Toolbar>
      <div className="admin-table"><DataTable columns={columns} rows={list.rows} rowKey={(user) => user.id} loading={list.loading} empty={list.search ? t('admin.noMatchUsers') : t('admin.noUsers')} /></div>
      <Pagination
        page={list.page}
        pageSize={list.pageSize}
        total={list.total}
        totalPages={Math.ceil(list.total / list.pageSize)}
        loading={list.loading}
        onPage={list.setPage}
        onPageSize={(size) => { list.setPage(1); list.setPageSize(size); }}
        pageSizes={PAGE_SIZE_OPTIONS}
      />
    </Panel>
    {detailUser && <UserDetailDialog user={detailUser} onClose={() => setDetailUser(null)} onUserChange={updateUser} />}
  </>;
}
