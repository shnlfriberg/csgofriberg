import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, History, Play, Search, Swords, User, X } from 'lucide-react';
import { api, errMsg } from '../../api/client';
import type { PlayerPerformanceStats } from '../../types';
import DataTable, { Column } from '../DataTable';
import ModalPortal from '../ModalPortal';
import { toast } from '../Toast';
import Badge from '../Badge';
import ReplayDialog, {
  type MultiReplay,
  type Replay,
  type SingleReplay,
} from '../ReplayDialog';
import { useTranslation } from 'react-i18next';
import { difficultyLabel } from '../../utils/difficulty';
import { currentLocale } from '../../i18n';

interface AdminUser {
  id: number;
  username: string;
  displayId: string;
  role: 'user' | 'admin';
  leaderboardHidden: boolean;
  createdAt: string;
}

interface UserPage {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface UserStatsView {
  user: AdminUser;
  stats: PlayerPerformanceStats;
}

interface SingleUserGame {
  type: 'single';
  id: number;
  mode: string;
  status: string;
  guessCount: number;
  answer: string;
  finishedAt: string;
}

interface MultiUserGame {
  type: 'multi';
  id: number;
  mode: string;
  boType: number;
  result: 'won' | 'lost' | 'draw';
  me: { score: number };
  opponent: { displayId: string; score: number } | null;
  finishedAt: string;
}

type UserGame = SingleUserGame | MultiUserGame;

interface UserGamePage {
  type: 'single' | 'multi';
  page: number;
  pageSize: number;
  hasNext: boolean;
  items: UserGame[];
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString(currentLocale());
}

function formatWinRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function UserStatsDialog({ view, onClose }: { view: UserStatsView; onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const { single, multi } = view.stats;
  return (
    <ModalPortal>
      <div className="admin-player-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}>
        <div className="admin-player-dialog admin-user-stats-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-user-stats-title">
          <div className="admin-player-dialog-heading">
            <div>
              <h2 id="admin-user-stats-title">{t('admin.userStats')}</h2>
              <p>{view.user.username} · {view.user.displayId}</p>
            </div>
            <button className="confirm-close" type="button" aria-label={t('admin.closeUserStats')} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
          <div className="admin-user-stats-grid">
            <section>
              <h3>{t('multi.singleStats')}</h3>
              <dl className="player-stats-list">
                <div><dt>{t('multi.games')}</dt><dd>{single.games}</dd></div>
                <div><dt>{t('multi.winsLosses')}</dt><dd>{single.wins} / {single.losses}</dd></div>
                <div><dt>{t('multi.winRate')}</dt><dd>{formatWinRate(single.winRate)}</dd></div>
                <div><dt>{t('multi.avgWinningGuesses')}</dt><dd>{single.avgGuesses?.toFixed(1) ?? '-'}</dd></div>
                <div><dt>{t('multi.fastest')}</dt><dd>{single.bestGuesses ?? '-'}</dd></div>
              </dl>
            </section>
            <section>
              <h3>{t('multi.multiStats')}</h3>
              <dl className="player-stats-list">
                <div><dt>{t('multi.games')}</dt><dd>{multi.games}</dd></div>
                <div><dt>{t('multi.winsLosses')}</dt><dd>{multi.wins} / {multi.losses}</dd></div>
                <div><dt>{t('multi.winRate')}</dt><dd>{formatWinRate(multi.winRate)}</dd></div>
              </dl>
            </section>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

function UserGamesDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
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
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !replay) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, replay]);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    api.get<UserGamePage>(`/admin/users/${user.id}/games`, {
      params: { type, page, pageSize: 10 },
    }).then((res) => {
      if (currentRequest !== requestId.current) return;
      setItems(res.data.items);
      setHasNext(res.data.hasNext);
    }).catch((err) => {
      if (currentRequest === requestId.current) toast.error(errMsg(err));
    }).finally(() => {
      if (currentRequest === requestId.current) setLoading(false);
    });
  }, [page, type, user.id]);

  const chooseType = (next: 'single' | 'multi') => {
    setType(next);
    setPage(1);
    setItems([]);
  };

  const openReplay = async (game: UserGame) => {
    setReplayLoadingId(game.id);
    try {
      if (game.type === 'single') {
        const res = await api.get<Omit<SingleReplay, 'type'>>(
          `/admin/users/${user.id}/games/${game.id}/replay`
        );
        setReplay({ type: 'single', ...res.data });
      } else {
        const res = await api.get<Omit<MultiReplay, 'type'>>(
          `/admin/users/${user.id}/matches/${game.id}/replay`
        );
        setReplay({ type: 'multi', ...res.data });
      }
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setReplayLoadingId(null);
    }
  };

  return (
    <>
      <ModalPortal>
        <div className="admin-player-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !replay) onClose();
        }}>
          <div className="admin-player-dialog admin-user-games-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-user-games-title">
          <div className="admin-player-dialog-heading">
            <div>
              <h2 id="admin-user-games-title">{t('admin.gamesTitle')}</h2>
              <p>{user.username} · {user.displayId}</p>
            </div>
            <button className="confirm-close" type="button" aria-label={t('admin.closeGames')} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
          <div className="stats-replay-segments admin-user-game-tabs" role="tablist" aria-label={t('admin.gameType')}>
            <button type="button" role="tab" aria-selected={type === 'single'} className={type === 'single' ? 'active' : ''} onClick={() => chooseType('single')}>
              <User size={15} />{t('admin.single')}
            </button>
            <button type="button" role="tab" aria-selected={type === 'multi'} className={type === 'multi' ? 'active' : ''} onClick={() => chooseType('multi')}>
              <Swords size={15} />{t('admin.multi')}
            </button>
          </div>
          <div className="admin-user-game-list">
            {items.length ? items.map((game) => {
              const result = game.type === 'single' ? game.status : game.result;
              const label = result === 'won' ? t('common.win') : result === 'draw' ? t('common.draw') : t('common.loss');
              return (
                <article className="admin-user-game-item" key={`${game.type}:${game.id}`}>
                  <div className="admin-user-game-heading">
                    <strong>{game.type === 'single'
                      ? difficultyLabel(t, game.mode)
                      : `${difficultyLabel(t, game.mode)} · BO${game.boType}`}</strong>
                    <Badge text={label} color={result === 'won' ? 'green' : 'gray'} />
                  </div>
                  <div className="admin-user-game-details">
                    {game.type === 'single' ? (
                      <>
                        <span>{t('stats.answer')} <strong>{game.answer}</strong></span>
                        <span>{t('stats.guesses')} <strong>{game.guessCount}</strong></span>
                      </>
                    ) : (
                      <>
                        <span>{t('admin.opponent')} <strong>{game.opponent?.displayId ?? t('stats.unknownOpponent')}</strong></span>
                        <span>{t('stats.score')} <strong>{game.me.score}:{game.opponent?.score ?? 0}</strong></span>
                      </>
                    )}
                  </div>
                  <div className="admin-user-game-footer">
                    <time dateTime={game.finishedAt}>{formatDate(game.finishedAt)}</time>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      disabled={replayLoadingId !== null}
                      onClick={() => void openReplay(game)}
                    >
                      <Play size={14} />
                      {replayLoadingId === game.id ? t('stats.loading') : t('stats.replay')}
                    </button>
                  </div>
                </article>
              );
            }) : <p className="muted admin-user-game-empty">{loading
              ? t('common.loading')
              : type === 'single' ? t('admin.noSingleGames') : t('admin.noMultiGames')}</p>}
          </div>
          <div className="admin-pagination admin-user-game-pagination">
            <button className="btn btn-ghost" type="button" aria-label={t('common.previousPage')} title={t('common.previousPage')} disabled={page === 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              <ChevronLeft size={17} />
            </button>
            <span>{t('common.page', { page })}</span>
            <button className="btn btn-ghost" type="button" aria-label={t('common.nextPage')} title={t('common.nextPage')} disabled={!hasNext || loading} onClick={() => setPage((current) => current + 1)}>
              <ChevronRight size={17} />
            </button>
          </div>
          </div>
        </div>
      </ModalPortal>
      {replay && <ReplayDialog replay={replay} onClose={() => setReplay(null)} />}
    </>
  );
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
  const [statsLoadingId, setStatsLoadingId] = useState<number | null>(null);
  const [visibilityUpdatingId, setVisibilityUpdatingId] = useState<number | null>(null);
  const [statsView, setStatsView] = useState<UserStatsView | null>(null);
  const [gamesUser, setGamesUser] = useState<AdminUser | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const res = await api.get<UserPage>('/admin/users', {
        params: { page, pageSize, search: search || undefined },
      });
      if (currentRequest !== requestId.current) return;
      setUsers(res.data.users);
      setTotal(res.data.total);
      if (res.data.page !== page) setPage(res.data.page);
    } catch (err) {
      if (currentRequest === requestId.current) toast.error(errMsg(err));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [page, pageSize, search]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const viewStats = async (user: AdminUser) => {
    if (statsLoadingId !== null) return;
    setStatsLoadingId(user.id);
    try {
      const res = await api.get<UserStatsView>(`/admin/users/${user.id}/stats`);
      setStatsView(res.data);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setStatsLoadingId(null);
    }
  };

  const updateLeaderboardVisibility = async (user: AdminUser, hidden: boolean) => {
    if (visibilityUpdatingId !== null) return;
    setVisibilityUpdatingId(user.id);
    try {
      await api.patch(`/admin/users/${user.id}/leaderboard-visibility`, { hidden });
      setUsers((current) => current.map((item) => item.id === user.id
        ? { ...item, leaderboardHidden: hidden }
        : item));
      setStatsView((current) => current?.user.id === user.id
        ? { ...current, user: { ...current.user, leaderboardHidden: hidden } }
        : current);
      toast.success(hidden ? t('admin.leaderboardHiddenSuccess') : t('admin.leaderboardVisibleSuccess'));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setVisibilityUpdatingId(null);
    }
  };

  const columns: Column<AdminUser>[] = [
    { key: 'username', title: t('admin.username') },
    { key: 'displayId', title: t('admin.anonymousId') },
    { key: 'role', title: t('admin.permission'), render: (user) => user.role === 'admin' ? t('admin.adminRole') : t('admin.userRole') },
    {
      key: 'leaderboardHidden',
      title: t('admin.leaderboardStatus'),
      render: (user) => (
        <Badge
          text={user.leaderboardHidden ? t('admin.leaderboardHidden') : t('admin.leaderboardVisible')}
          color={user.leaderboardHidden ? 'gray' : 'green'}
        />
      ),
    },
    { key: 'createdAt', title: t('admin.createdAt'), render: (user) => formatDate(user.createdAt) },
    {
      key: 'actions',
      title: t('admin.actions'),
      render: (user) => (
        <span className="admin-user-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={statsLoadingId !== null}
            onClick={() => void viewStats(user)}
          >
            <Eye size={15} />
            {statsLoadingId === user.id ? t('admin.querying') : t('admin.viewStats')}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setGamesUser(user)}>
            <History size={15} />
            {t('admin.gameRecords')}
          </button>
          <label className="admin-user-leaderboard-toggle">
            <input
              type="checkbox"
              checked={user.leaderboardHidden}
              disabled={visibilityUpdatingId !== null}
              aria-label={user.leaderboardHidden
                ? t('admin.showUserOnLeaderboard', { user: user.username })
                : t('admin.hideUserFromLeaderboard', { user: user.username })}
              onChange={(event) => void updateLeaderboardVisibility(user, event.target.checked)}
            />
            <span>{user.leaderboardHidden ? t('admin.showOnLeaderboard') : t('admin.hideFromLeaderboard')}</span>
          </label>
        </span>
      ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <>
      <div className="card admin-users-card">
        <div className="admin-players-header">
          <div className="admin-players-title">
            <h3>{t('admin.usersTitle')}</h3>
            <p className="muted">{t('admin.totalUsers', { count: total })}</p>
          </div>
        </div>
        <div className="admin-list-toolbar">
          <label className="admin-search">
            <Search size={16} />
            <input
              className="input"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('admin.searchUsers')}
            />
          </label>
          <label className="admin-page-size">
            <span>{t('admin.pageSize')}</span>
            <select
              className="input"
              value={pageSize}
              onChange={(event) => {
                setPage(1);
                setPageSize(Number(event.target.value));
              }}
            >
              {[20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
        </div>
        <div className="admin-users-table">
          <DataTable
            columns={columns}
            rows={users}
            rowKey={(user) => user.id}
            empty={loading ? t('common.loading') : search ? t('admin.noMatchUsers') : t('admin.noUsers')}
          />
        </div>
        <div className="admin-pagination">
          <span className="muted">
            {total ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} / ${total}` : t('admin.zeroItems')}
          </span>
          <div className="admin-pagination-actions">
            <button
              className="btn btn-ghost"
              aria-label={t('common.previousPage')}
              title={t('common.previousPage')}
              disabled={loading || page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft size={17} />
            </button>
            <span>{t('admin.pageOf', { page, total: totalPages })}</span>
            <button
              className="btn btn-ghost"
              aria-label={t('common.nextPage')}
              title={t('common.nextPage')}
              disabled={loading || page >= totalPages}
              onClick={() => setPage((current) => current + 1)}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </div>
      </div>
      {statsView && <UserStatsDialog view={statsView} onClose={() => setStatsView(null)} />}
      {gamesUser && <UserGamesDialog user={gamesUser} onClose={() => setGamesUser(null)} />}
    </>
  );
}
