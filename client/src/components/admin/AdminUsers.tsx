import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Eye,
  History,
  ListTree,
  Play,
  Search,
  Swords,
  Settings,
  Trophy,
  User,
  X,
} from 'lucide-react';
import { api, errMsg } from '../../api/client';
import type { PlayerPerformanceStats } from '../../types';
import DataTable, { Column } from '../DataTable';
import ModalPortal from '../ModalPortal';
import { toast } from '../Toast';
import Badge from '../Badge';
import ReplayDialog, { type MultiReplay, type Replay, type SingleReplay } from '../ReplayDialog';
import { useTranslation } from 'react-i18next';
import { difficultyLabel } from '../../utils/difficulty';
import { currentLocale } from '../../i18n';
import ExternalAnalysisPanel, { type ExternalAnalysisView } from './ExternalAnalysisPanel';

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
interface GuestGamePage { type: 'single' | 'multi'; page: number; pageSize: number; hasNext: boolean; items: UserGame[] }

interface UserStatsView { user: AdminUser; stats: PlayerPerformanceStats }
interface SingleUserGame {
  type: 'single'; id: number; mode: string; status: string; guessCount: number; answer: string; finishedAt: string;
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
type GuestDetailTab = 'stats' | 'games' | 'analysis' | 'manage';

export function AdminGuests() {
  const { t } = useTranslation();
  const [guests, setGuests] = useState<AdminGuest[]>([]);
  const [detail, setDetail] = useState<AdminGuest | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const response = await api.get<GuestPage>('/admin/guests', { params: { page, pageSize, search: search || undefined } });
      if (currentRequest !== requestId.current) return;
      setGuests(Array.isArray(response.data?.guests) ? response.data.guests : []);
      setTotal(Number(response.data?.total ?? 0));
      if (response.data?.page && response.data.page !== page) setPage(response.data.page);
    }
    catch (error) { toast.error(errMsg(error)); }
    finally { if (currentRequest === requestId.current) setLoading(false); }
  }, [page, pageSize, search]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setSearch(searchInput.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);
  const toggle = async (guest: AdminGuest) => {
    try {
      await api.patch(`/admin/guests/${guest.id}/ban`, { banned: !guest.banned });
      setGuests((current) => current.map((item) => item.id === guest.id ? { ...item, banned: !item.banned } : item));
      setDetail((current) => current?.id === guest.id ? { ...current, banned: !current.banned } : current);
      toast.success(!guest.banned ? t('admin.bannedSuccess') : t('admin.unbannedSuccess'));
    } catch (error) { toast.error(errMsg(error)); }
  };
  const columns: Column<AdminGuest>[] = [
    { key: 'displayId', title: t('admin.anonymousId') },
    { key: 'lastSeenAt', title: t('admin.lastSeenAt'), render: (guest) => formatDate(guest.lastSeenAt) },
    { key: 'banned', title: t('admin.banStatus'), render: (guest) => <Badge text={guest.banned ? t('admin.banned') : t('admin.notBanned')} color={guest.banned ? 'gray' : 'green'} /> },
    { key: 'actions', title: t('admin.actions'), render: (guest) => <><button type="button" className="btn btn-ghost" onClick={() => setDetail(guest)}><Eye size={15} />{t('admin.details')}</button><button type="button" className={guest.banned ? 'btn btn-ghost' : 'btn btn-danger'} onClick={() => void toggle(guest)}>{guest.banned ? t('admin.unban') : t('admin.ban')}</button></> },
  ];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return <>
    <div className="card admin-users-card">
      <div className="admin-players-header"><div className="admin-players-title"><h3>{t('admin.guestsTitle')}</h3><p className="muted">{t('admin.totalGuests', { count: total })}</p></div></div>
      <div className="admin-list-toolbar"><label className="admin-search"><Search size={16} /><input className="input" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={t('admin.searchGuests')} /></label></div>
      <div className="admin-users-table"><DataTable columns={columns} rows={guests} rowKey={(guest) => guest.id} loading={loading} empty={search ? t('admin.noMatchGuests') : t('admin.noGuests')} /></div>
      <div className="admin-pagination"><span className="muted">{total ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} / ${total}` : t('admin.zeroItems')}</span><div className="admin-pagination-actions"><button className="btn btn-ghost" aria-label={t('common.previousPage')} disabled={loading || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={17} /></button><span>{t('admin.pageOf', { page, total: totalPages })}</span><button className="btn btn-ghost" aria-label={t('common.nextPage')} disabled={loading || page >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button></div></div>
    </div>
    {detail && <GuestDetailDialog guest={detail} onClose={() => setDetail(null)} onGuestChange={(updated) => { setDetail(updated); setGuests((current) => current.map((item) => item.id === updated.id ? updated : item)); }} />}
  </>;
}

function GuestGamesTab({ guest }: { guest: AdminGuest }) {
  const { t } = useTranslation();
  const [type, setType] = useState<'single' | 'multi'>('single');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<UserGame[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api.get<GuestGamePage>(`/admin/guests/${guest.id}/games`, { params: { type, page, pageSize: 10 } })
      .then((response) => { setItems(response.data.items); setHasNext(response.data.hasNext); })
      .catch((error) => toast.error(errMsg(error)))
      .finally(() => setLoading(false));
  }, [guest.id, page, type]);
  return <>
    <div className="stats-replay-segments admin-user-game-tabs" role="tablist" aria-label={t('admin.gameType')}>
      <button type="button" role="tab" aria-selected={type === 'single'} className={type === 'single' ? 'active' : ''} onClick={() => { setType('single'); setPage(1); }}><User size={15} />{t('admin.single')}</button>
      <button type="button" role="tab" aria-selected={type === 'multi'} className={type === 'multi' ? 'active' : ''} onClick={() => { setType('multi'); setPage(1); }}><Swords size={15} />{t('admin.multi')}</button>
    </div>
    <div className="admin-user-game-list">
      {items.length ? items.map((game) => {
        const result = game.type === 'single' ? game.status : game.result;
        const label = result === 'cooperative' && game.type === 'multi'
          ? t('multi.relayProgress', { solved: game.relaySolvedRounds ?? 0, total: game.totalRounds ?? 0 })
          : result === 'won' ? t('common.win') : result === 'draw' ? t('common.draw') : t('common.loss');
        return <article className="admin-user-game-item" key={`${game.type}:${game.id}`}>
          <div className="admin-user-game-heading"><strong>{game.type === 'single' ? difficultyLabel(t, game.mode) : game.gameMode === 'relay' ? `${difficultyLabel(t, game.mode)} · ${t('multi.relayMode')}` : `${difficultyLabel(t, game.mode)} · BO${game.boType}`}</strong><Badge text={label} color={result === 'won' || result === 'cooperative' ? 'green' : 'gray'} /></div>
          <div className="admin-user-game-details">{game.type === 'single' ? <><span>{t('stats.answer')} <strong>{game.answer}</strong></span><span>{t('stats.guesses')} <strong>{game.guessCount}</strong></span></> : <><span>{t('admin.opponent')} <strong>{game.opponent?.displayId ?? t('stats.unknownOpponent')}</strong></span>{game.gameMode !== 'relay' && <span>{t('stats.score')} <strong>{game.me.score}:{game.opponent?.score ?? 0}</strong></span>}</>}</div>
          <div className="admin-user-game-footer"><time dateTime={game.finishedAt}>{formatDate(game.finishedAt)}</time></div>
        </article>;
      }) : <p className="muted admin-user-game-empty">{loading ? t('common.loading') : type === 'single' ? t('admin.noSingleGames') : t('admin.noMultiGames')}</p>}
    </div>
    <div className="admin-pagination admin-user-game-pagination"><button className="btn btn-ghost" type="button" aria-label={t('common.previousPage')} disabled={page === 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={17} /></button><span>{t('common.page', { page })}</span><button className="btn btn-ghost" type="button" aria-label={t('common.nextPage')} disabled={!hasNext || loading} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button></div>
  </>;
}

export function GuestDetailDialog({ guest, onClose, onGuestChange }: { guest: AdminGuest; onClose: () => void; onGuestChange: (guest: AdminGuest) => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<GuestDetailTab>('stats');
  const [stats, setStats] = useState<PlayerPerformanceStats | null>(null);
  const [analysis, setAnalysis] = useState<ExternalAnalysisView | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', onKeyDown); };
  }, [onClose]);
  useEffect(() => {
    if (tab !== 'stats' || stats) return;
    setLoading(true);
    api.get(`/admin/guests/${guest.id}/stats`)
      .then((response) => setStats(response.data.stats))
      .catch((error) => toast.error(errMsg(error)))
      .finally(() => setLoading(false));
  }, [guest.id, stats, tab]);
  const runAnalysis = async (locale: string) => {
    setAnalysisLoading(true);
    try {
      const response = await api.post<ExternalAnalysisView>(`/admin/guests/${guest.id}/analysis`, { locale });
      setAnalysis(response.data);
    } catch (error) { toast.error(errMsg(error)); }
    finally { setAnalysisLoading(false); }
  };
  const updateBan = async (banned: boolean) => {
    setUpdating(true);
    try {
      await api.patch(`/admin/guests/${guest.id}/ban`, { banned });
      onGuestChange({ ...guest, banned });
      toast.success(banned ? t('admin.bannedSuccess') : t('admin.unbannedSuccess'));
    } catch (error) { toast.error(errMsg(error)); }
    finally { setUpdating(false); }
  };
  const fakeUser: AdminUser = { id: guest.id, username: guest.displayId, displayId: guest.displayId, role: 'user', leaderboardHidden: false, matchmakingRestricted: false, email: null, emailVerified: false, banned: guest.banned, createdAt: guest.createdAt };
  return <ModalPortal><div className="admin-player-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="admin-player-dialog admin-user-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-guest-detail-title">
    <div className="admin-player-dialog-heading"><div><h2 id="admin-guest-detail-title">{t('admin.guestDetail')}</h2><p>{guest.displayId}</p></div><button className="confirm-close" type="button" aria-label={t('common.close')} onClick={onClose}><X size={18} /></button></div>
    <div className="admin-user-detail-tabs admin-guest-detail-tabs" role="tablist" aria-label={t('admin.guestDetail')}>
      {([{ key: 'stats', label: t('admin.detailStats') }, { key: 'games', label: t('admin.gameRecords') }, { key: 'analysis', label: t('admin.detailAnalysis') }, { key: 'manage', label: t('admin.quickManagement') }] as const).map((item) => <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}>{item.label}</button>)}
    </div>
    <div className="admin-user-detail-content">
      {tab === 'stats' && <StatsTab view={stats ? { user: fakeUser, stats } : null} />}
      {tab === 'games' && <GuestGamesTab guest={guest} />}
      {tab === 'analysis' && <ExternalAnalysisPanel view={analysis} loading={analysisLoading} onAnalyze={(locale) => void runAnalysis(locale)} />}
      {tab === 'manage' && <div className="admin-quick-management">
        <div className="admin-user-leaderboard-control"><div><strong>{t('admin.banStatus')}</strong><span>{guest.banned ? t('admin.banned') : t('admin.notBanned')}</span></div><label className="admin-user-leaderboard-toggle"><input type="checkbox" checked={guest.banned} disabled={updating} onChange={(event) => void updateBan(event.target.checked)} /><span>{guest.banned ? t('admin.banned') : t('admin.notBanned')}</span></label></div>
      </div>}
    </div>
  </div></div></ModalPortal>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString(currentLocale());
}
function formatWinRate(value: number): string { return `${(value * 100).toFixed(1)}%`; }

function GamesTab({ user, onReplayOpenChange }: { user: AdminUser; onReplayOpenChange?: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [type, setType] = useState<'single' | 'multi'>('single');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<UserGame[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayLoadingId, setReplayLoadingId] = useState<number | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    api.get<UserGamePage>(`/admin/users/${user.id}/games`, { params: { type, page, pageSize: 10 } })
      .then((res) => {
        if (currentRequest !== requestId.current) return;
        setItems(res.data.items);
        setHasNext(res.data.hasNext);
      })
      .catch((err) => { if (currentRequest === requestId.current) toast.error(errMsg(err)); })
      .finally(() => { if (currentRequest === requestId.current) setLoading(false); });
  }, [page, type, user.id]);

  const openReplay = async (game: UserGame) => {
    setReplayLoadingId(game.id);
    try {
      if (game.type === 'single') {
        const res = await api.get<Omit<SingleReplay, 'type'>>(`/admin/users/${user.id}/games/${game.id}/replay`);
        setReplay({ type: 'single', ...res.data });
        onReplayOpenChange?.(true);
      } else {
        const res = await api.get<Omit<MultiReplay, 'type'>>(`/admin/users/${user.id}/matches/${game.id}/replay`);
        setReplay({ type: 'multi', ...res.data });
        onReplayOpenChange?.(true);
      }
    } catch (err) { toast.error(errMsg(err)); }
    finally { setReplayLoadingId(null); }
  };

  const closeReplay = () => {
    setReplay(null);
    onReplayOpenChange?.(false);
  };

  return (
    <>
      <div className="stats-replay-segments admin-user-game-tabs" role="tablist" aria-label={t('admin.gameType')}>
        <button type="button" role="tab" aria-selected={type === 'single'} className={type === 'single' ? 'active' : ''} onClick={() => { setType('single'); setPage(1); setItems([]); }}>
          <User size={15} />{t('admin.single')}
        </button>
        <button type="button" role="tab" aria-selected={type === 'multi'} className={type === 'multi' ? 'active' : ''} onClick={() => { setType('multi'); setPage(1); setItems([]); }}>
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
                <strong>{game.type === 'single' ? difficultyLabel(t, game.mode) : game.gameMode === 'relay' ? `${difficultyLabel(t, game.mode)} · ${t('multi.relayMode')}` : `${difficultyLabel(t, game.mode)} · BO${game.boType}`}</strong>
                <Badge text={label} color={result === 'won' || result === 'cooperative' ? 'green' : 'gray'} />
              </div>
              <div className="admin-user-game-details">
                {game.type === 'single' ? <>
                  <span>{t('stats.answer')} <strong>{game.answer}</strong></span>
                  <span>{t('stats.guesses')} <strong>{game.guessCount}</strong></span>
                </> : <>
                  <span>{t('admin.opponent')} <strong>{game.opponent?.displayId ?? t('stats.unknownOpponent')}</strong></span>
                  {game.gameMode !== 'relay' && <span>{t('stats.score')} <strong>{game.me.score}:{game.opponent?.score ?? 0}</strong></span>}
                </>}
              </div>
              <div className="admin-user-game-footer">
                <time dateTime={game.finishedAt}>{formatDate(game.finishedAt)}</time>
                <button className="btn btn-ghost btn-sm" type="button" disabled={replayLoadingId !== null} onClick={() => void openReplay(game)}>
                  <Play size={14} />{replayLoadingId === game.id ? t('stats.loading') : t('stats.replay')}
                </button>
              </div>
            </article>
          );
        }) : <p className="muted admin-user-game-empty">{loading ? t('common.loading') : type === 'single' ? t('admin.noSingleGames') : t('admin.noMultiGames')}</p>}
      </div>
      <div className="admin-pagination admin-user-game-pagination">
        <button className="btn btn-ghost" type="button" aria-label={t('common.previousPage')} disabled={page === 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={17} /></button>
        <span>{t('common.page', { page })}</span>
        <button className="btn btn-ghost" type="button" aria-label={t('common.nextPage')} disabled={!hasNext || loading} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button>
      </div>
      {replay && <ReplayDialog replay={replay} onClose={closeReplay} showDecisionTimes />}
    </>
  );
}

function StatsTab({ view }: { view: UserStatsView | null }) {
  const { t } = useTranslation();
  if (!view) return <p className="muted admin-user-detail-loading">{t('common.loading')}</p>;
  const { single, multi } = view.stats;
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
  return <>
    <div className="admin-user-leaderboard-control">
      <div><strong>{t('admin.leaderboardVisibility')}</strong><span>{t('admin.leaderboardVisibilityHint')}</span></div>
      <label className="admin-user-leaderboard-toggle">
        <input type="checkbox" checked={!view.leaderboardHidden} disabled={updating} onChange={(event) => onToggle(!event.target.checked)} />
        <span>{view.leaderboardHidden ? t('admin.leaderboardHidden') : t('admin.leaderboardVisible')}</span>
      </label>
    </div>
    <div className="admin-user-ranking-grid">
      {view.entries.map((entry) => <article key={`${entry.mode}:${entry.difficulty}`}>
        <div><strong>{difficultyLabel(t, entry.difficulty)}</strong><Badge text={t(`admin.${entry.mode}`)} color={entry.mode === 'single' ? 'green' : 'gray'} /></div>
        <b>{entry.rank == null ? '-' : `#${entry.rank}`}</b>
        <span>{t('admin.rankPopulation', { count: entry.totalRanked })}</span>
        <small>{t('admin.rankRecord', { wins: entry.wins, total: entry.total, rate: formatWinRate(entry.winRate) })}</small>
      </article>)}
    </div>
  </>;
}

function AnalysisTab({
  user,
  view,
  loading,
  onAnalyze,
  updating,
  onToggle,
  banUpdating,
  onBan,
}: {
  user: AdminUser;
  view: ExternalAnalysisView | null;
  loading: boolean;
  onAnalyze: (locale: string) => void;
  updating: boolean;
  onToggle: (restricted: boolean) => void;
  banUpdating: boolean;
  onBan: (banned: boolean) => void;
}) {
  const { t } = useTranslation();
  const restrictionControl = <div className="admin-user-leaderboard-control admin-user-restriction-control">
    <div><strong>{t('admin.matchmakingRestriction')}</strong></div>
    <label className="admin-user-leaderboard-toggle">
      <input type="checkbox" checked={user.matchmakingRestricted} disabled={updating} onChange={(event) => onToggle(event.target.checked)} />
      <span>{user.matchmakingRestricted ? t('admin.matchmakingRestricted') : t('admin.matchmakingNormal')}</span>
    </label>
  </div>;
  const banControl = <div className="admin-user-leaderboard-control admin-user-restriction-control">
    <div><strong>{t('admin.banStatus')}</strong><span>{user.email ? `${user.email} · ${user.emailVerified ? t('admin.emailVerified') : t('admin.emailUnverified')}` : t('admin.noEmail')}</span></div>
    <label className="admin-user-leaderboard-toggle">
      <input type="checkbox" checked={user.banned} disabled={banUpdating} onChange={(event) => onBan(event.target.checked)} />
      <span>{user.banned ? t('admin.banned') : t('admin.notBanned')}</span>
    </label>
  </div>;
  return <>{banControl}{restrictionControl}<ExternalAnalysisPanel view={view} loading={loading} onAnalyze={onAnalyze} /></>;
}

function QuickManagementTab({
  user,
  visibilityUpdating,
  restrictionUpdating,
  banUpdating,
  onVisibility,
  onRestriction,
  onBan,
}: {
  user: AdminUser;
  visibilityUpdating: boolean;
  restrictionUpdating: boolean;
  banUpdating: boolean;
  onVisibility: (hidden: boolean) => void;
  onRestriction: (restricted: boolean) => void;
  onBan: (banned: boolean) => void;
}) {
  const { t } = useTranslation();
  return <div className="admin-quick-management">
    <div className="admin-user-leaderboard-control"><div><strong>{t('admin.email')}</strong><span>{user.email ? `${user.email} · ${user.emailVerified ? t('admin.emailVerified') : t('admin.emailUnverified')}` : t('admin.noEmail')}</span></div></div>
    <div className="admin-user-leaderboard-control"><div><strong>{t('admin.banStatus')}</strong></div><label className="admin-user-leaderboard-toggle"><input type="checkbox" checked={user.banned} disabled={banUpdating} onChange={(event) => onBan(event.target.checked)} /><span>{user.banned ? t('admin.banned') : t('admin.notBanned')}</span></label></div>
    <div className="admin-user-leaderboard-control"><div><strong>{t('admin.matchmakingRestriction')}</strong></div><label className="admin-user-leaderboard-toggle"><input type="checkbox" checked={user.matchmakingRestricted} disabled={restrictionUpdating} onChange={(event) => onRestriction(event.target.checked)} /><span>{user.matchmakingRestricted ? t('admin.matchmakingRestricted') : t('admin.matchmakingNormal')}</span></label></div>
    <div className="admin-user-leaderboard-control"><div><strong>{t('admin.leaderboardVisibility')}</strong></div><label className="admin-user-leaderboard-toggle"><input type="checkbox" checked={!user.leaderboardHidden} disabled={visibilityUpdating} onChange={(event) => onVisibility(!event.target.checked)} /><span>{user.leaderboardHidden ? t('admin.leaderboardHidden') : t('admin.leaderboardVisible')}</span></label></div>
  </div>;
}

export function UserDetailDialog({ user, onClose, onUserChange }: { user: AdminUser; onClose: () => void; onUserChange: (user: AdminUser) => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<DetailTab>('stats');
  const [stats, setStats] = useState<UserStatsView | null>(null);
  const [leaderboards, setLeaderboards] = useState<LeaderboardView | null>(null);
  const [analysis, setAnalysis] = useState<ExternalAnalysisView | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [visibilityUpdating, setVisibilityUpdating] = useState(false);
  const [restrictionUpdating, setRestrictionUpdating] = useState(false);
  const [banUpdating, setBanUpdating] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const loaded = useRef(new Set<DetailTab>());
  const dialogRef = useRef<HTMLDivElement>(null);
  const replayOpenRef = useRef(replayOpen);
  replayOpenRef.current = replayOpen;

  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (replayOpenRef.current) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', onKeyDown); };
  }, [onClose]);

  useEffect(() => {
    if (tab === 'games' || tab === 'manage' || tab === 'analysis' || loaded.current.has(tab)) return;
    loaded.current.add(tab);
    const endpoint = tab === 'stats' ? 'stats' : 'leaderboards';
    api.get(`/admin/users/${user.id}/${endpoint}`).then((res) => {
      if (tab === 'stats') setStats(res.data as UserStatsView);
      else if (tab === 'leaderboards') setLeaderboards(res.data as LeaderboardView);
    }).catch((err) => { loaded.current.delete(tab); toast.error(errMsg(err)); });
  }, [tab, user.id]);

  const runAnalysis = async (locale: string) => {
    setAnalysisLoading(true);
    try {
      const response = await api.post<ExternalAnalysisView>(`/admin/users/${user.id}/analysis`, { locale });
      setAnalysis(response.data);
    } catch (error) { toast.error(errMsg(error)); }
    finally { setAnalysisLoading(false); }
  };

  const updateVisibility = async (hidden: boolean) => {
    setVisibilityUpdating(true);
    try {
      await api.patch(`/admin/users/${user.id}/leaderboard-visibility`, { hidden });
      const updated = { ...user, leaderboardHidden: hidden };
      onUserChange(updated);
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

  const tabs: Array<{ key: DetailTab; icon: typeof Eye; label: string }> = [
    { key: 'stats', icon: BarChart3, label: t('admin.detailStats') },
    { key: 'games', icon: History, label: t('admin.gameRecords') },
    { key: 'leaderboards', icon: Trophy, label: t('admin.detailLeaderboards') },
    { key: 'analysis', icon: ListTree, label: t('admin.detailAnalysis') },
    { key: 'manage', icon: Settings, label: t('admin.quickManagement') },
  ];
  return <ModalPortal><div className="admin-player-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="admin-player-dialog admin-user-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-user-detail-title" tabIndex={-1}>
      <div className="admin-player-dialog-heading"><div><h2 id="admin-user-detail-title">{t('admin.userDetail')}</h2><p>{user.username} · {user.displayId}</p></div><button className="confirm-close" type="button" aria-label={t('common.close')} onClick={onClose}><X size={18} /></button></div>
      <div className="admin-user-detail-tabs" role="tablist" aria-label={t('admin.userDetail')}>
        {tabs.map((item) => { const Icon = item.icon; return <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}><Icon size={16} />{item.label}</button>; })}
      </div>
      <div className="admin-user-detail-content">
        {tab === 'stats' && <StatsTab view={stats} />}
        {tab === 'games' && <GamesTab user={user} onReplayOpenChange={setReplayOpen} />}
        {tab === 'leaderboards' && <LeaderboardsTab view={leaderboards} updating={visibilityUpdating} onToggle={(hidden) => void updateVisibility(hidden)} />}
        {tab === 'analysis' && <AnalysisTab user={user} view={analysis} loading={analysisLoading} onAnalyze={(locale) => void runAnalysis(locale)} updating={restrictionUpdating} onToggle={(restricted) => void updateMatchmakingRestriction(restricted)} banUpdating={banUpdating} onBan={(banned) => void updateBan(banned)} />}
        {tab === 'manage' && <QuickManagementTab user={user} visibilityUpdating={visibilityUpdating} restrictionUpdating={restrictionUpdating} banUpdating={banUpdating} onVisibility={(hidden) => void updateVisibility(hidden)} onRestriction={(restricted) => void updateMatchmakingRestriction(restricted)} onBan={(banned) => void updateBan(banned)} />}
      </div>
    </div>
  </div></ModalPortal>;
}

export default function AdminUsers() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailUser, setDetailUser] = useState<AdminUser | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const res = await api.get<UserPage>('/admin/users', { params: { page, pageSize, search: search || undefined } });
      if (currentRequest !== requestId.current) return;
      setUsers(res.data.users); setTotal(res.data.total);
      if (res.data.page !== page) setPage(res.data.page);
    } catch (err) { if (currentRequest === requestId.current) toast.error(errMsg(err)); }
    finally { if (currentRequest === requestId.current) setLoading(false); }
  }, [page, pageSize, search]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = window.setTimeout(() => { setPage(1); setSearch(searchInput.trim()); }, 250); return () => window.clearTimeout(timer); }, [searchInput]);

  const updateUser = (updated: AdminUser) => {
    setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
    setDetailUser(updated);
  };
  const columns: Column<AdminUser>[] = [
    { key: 'username', title: t('admin.username') },
    { key: 'displayId', title: t('admin.anonymousId') },
    { key: 'role', title: t('admin.permission'), render: (user) => user.role === 'admin' ? t('admin.adminRole') : t('admin.userRole') },
    { key: 'email', title: t('auth.emailOptional'), render: (user) => user.email ? <span>{user.email}{user.emailVerified ? ' ✓' : ''}</span> : '-' },
    { key: 'banned', title: t('admin.banStatus'), render: (user) => <Badge text={user.banned ? t('admin.banned') : t('admin.notBanned')} color={user.banned ? 'gray' : 'green'} /> },
    { key: 'leaderboardHidden', title: t('admin.leaderboardStatus'), render: (user) => <Badge text={user.leaderboardHidden ? t('admin.leaderboardHidden') : t('admin.leaderboardVisible')} color={user.leaderboardHidden ? 'gray' : 'green'} /> },
    { key: 'createdAt', title: t('admin.createdAt'), render: (user) => formatDate(user.createdAt) },
    { key: 'actions', title: t('admin.actions'), render: (user) => <button type="button" className="btn btn-ghost" onClick={() => setDetailUser(user)}><Eye size={15} />{t('admin.details')}</button> },
  ];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return <>
    <div className="card admin-users-card">
      <div className="admin-players-header"><div className="admin-players-title"><h3>{t('admin.usersTitle')}</h3><p className="muted">{t('admin.totalUsers', { count: total })}</p></div></div>
      <div className="admin-list-toolbar"><label className="admin-search"><Search size={16} /><input className="input" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={t('admin.searchUsers')} /></label><label className="admin-page-size"><span>{t('admin.pageSize')}</span><select className="input" value={pageSize} onChange={(event) => { setPage(1); setPageSize(Number(event.target.value)); }}>{[20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label></div>
      <div className="admin-users-table"><DataTable columns={columns} rows={users} rowKey={(user) => user.id} loading={loading} empty={search ? t('admin.noMatchUsers') : t('admin.noUsers')} /></div>
      <div className="admin-pagination"><span className="muted">{total ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} / ${total}` : t('admin.zeroItems')}</span><div className="admin-pagination-actions"><button className="btn btn-ghost" aria-label={t('common.previousPage')} disabled={loading || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={17} /></button><span>{t('admin.pageOf', { page, total: totalPages })}</span><button className="btn btn-ghost" aria-label={t('common.nextPage')} disabled={loading || page >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button></div></div>
    </div>
    {detailUser && <UserDetailDialog user={detailUser} onClose={() => setDetailUser(null)} onUserChange={updateUser} />}
  </>;
}
