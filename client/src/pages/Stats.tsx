import { useCallback, useEffect, useRef, useState } from 'react';
import { BarChart3, Check, ChevronDown, ChevronLeft, ChevronRight, Play, Swords, User, Users } from 'lucide-react';
import Page from '../components/Page';
import DataTable, { Column } from '../components/DataTable';
import Badge from '../components/Badge';
import { api, errMsg } from '../api/client';
import { toast } from '../components/Toast';
import ReplayDialog, { type MultiReplay, type Replay, type SingleReplay } from '../components/ReplayDialog';
import { useTranslation } from 'react-i18next';
import { difficultyLabel } from '../utils/difficulty';
import { currentLocale } from '../i18n';
import type { PlayerPerformanceStats } from '../types';
import { AVAILABLE_DIFFICULTIES } from '../config/difficulties';

interface SingleStats {
  totalGames: number;
  wins: number;
  winRate: number;
  avgGuesses: number | null;
  bestGuesses: number | null;
  firstGuess: { playerId: number; nickname: string; percentage: number } | null;
}

interface StatsResponse {
  difficulties: string[];
  personal: SingleStats & {
    multiGames: number;
    multiWins: number;
    multiAvgWinningGuesses: number | null;
  };
  global: SingleStats & {
    multiGames: number;
    multiAvgWinningGuesses: number | null;
    registeredUsers: number;
  };
}

interface SingleReplayItem {
  type: 'single';
  id: number;
  mode: string;
  status: string;
  guessCount: number;
  finishedAt: string;
  answer: string;
}

interface MultiReplayItem {
  type: 'multi';
  id: number;
  mode: string;
  boType: number;
  finishedAt: string;
  result: 'won' | 'lost' | 'draw';
  me: { score: number };
  opponent: { displayId: string; score: number } | null;
}

interface ReplayPage<T> {
  type: 'single' | 'multi';
  page: number;
  pageSize: number;
  hasNext: boolean;
  items: T[];
}

type ReplayType = 'single' | 'multi';

const STATS_DIFFICULTIES = AVAILABLE_DIFFICULTIES.map((difficulty) => difficulty.key);

function formatAverage(value: number | null): string {
  return value == null ? '-' : value.toFixed(2);
}

function formatFirstGuess(value: SingleStats['firstGuess']): string {
  return value ? `${value.nickname} ${(value.percentage * 100).toFixed(1)}%` : '-';
}

function StatTable({ rows }: { rows: [string, string | number][] }) {
  return (
    <table className="table stats-summary-table">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}><td>{label}</td><td className="stat-value">{value}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function StatsDifficultyMultiSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const { t } = useTranslation();
  const selected = new Set(value);
  const allSelected = value.length === STATS_DIFFICULTIES.length;
  const summary = allSelected
    ? t('stats.allDifficulties')
    : value.map((key) => difficultyLabel(t, key)).join(', ');

  return (
    <details className="difficulty-multi-select stats-difficulty-select">
      <summary className="difficulty-multi-select-trigger">
        <span className="difficulty-multi-select-summary">{summary}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="difficulty-multi-select-menu" role="group" aria-label={t('stats.difficultyLevels')}>
        <label className="difficulty-multi-select-option">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => onChange([...STATS_DIFFICULTIES])}
          />
          <span>{t('stats.allDifficulties')}</span>
          {allSelected && <Check size={14} aria-hidden="true" />}
        </label>
        {STATS_DIFFICULTIES.map((key) => {
          const isSelected = selected.has(key);
          return (
            <label key={key} className="difficulty-multi-select-option">
              <input
                type="checkbox"
                checked={isSelected}
                disabled={isSelected && value.length === 1}
                onChange={(event) => {
                  const next = event.target.checked
                    ? STATS_DIFFICULTIES.filter((difficulty) => selected.has(difficulty) || difficulty === key)
                    : value.filter((difficulty) => difficulty !== key);
                  if (next.length) onChange(next);
                }}
              />
              <span>{difficultyLabel(t, key)}</span>
              {isSelected && <Check size={14} aria-hidden="true" />}
            </label>
          );
        })}
      </div>
    </details>
  );
}

export default function Stats() {
  const { t } = useTranslation();
  const [selectedDifficulties, setSelectedDifficulties] = useState<string[]>(STATS_DIFFICULTIES);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [type, setType] = useState<ReplayType>('single');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Array<SingleReplayItem | MultiReplayItem>>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayLoadingId, setReplayLoadingId] = useState<number | null>(null);
  const [opponentStats, setOpponentStats] = useState<PlayerPerformanceStats | null>(null);
  const [opponentStatsLoading, setOpponentStatsLoading] = useState(false);
  const requestId = useRef(0);
  const statsRequestId = useRef(0);

  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);

  const loadStats = useCallback(() => {
    const currentRequest = ++statsRequestId.current;
    setStatsLoading(true);
    setStatsError(false);
    api.get<StatsResponse>('/stats/me', {
      params: { difficulties: selectedDifficulties.join(',') },
    })
      .then((res) => {
        if (currentRequest === statsRequestId.current) setStats(res.data);
      })
      .catch(() => {
        if (currentRequest === statsRequestId.current) setStatsError(true);
      })
      .finally(() => {
        if (currentRequest === statsRequestId.current) setStatsLoading(false);
      });
  }, [selectedDifficulties]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const loadReplays = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const res = await api.get<ReplayPage<SingleReplayItem | MultiReplayItem>>('/stats/replays', {
        params: { type, page, pageSize: 15 },
      });
      if (currentRequest !== requestId.current) return;
      setItems(res.data.items);
      setHasNext(res.data.hasNext);
    } catch (err) {
      if (currentRequest === requestId.current) toast.error(errMsg(err));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [page, type]);

  useEffect(() => { void loadReplays(); }, [loadReplays]);

  const chooseType = (next: ReplayType) => {
    setType(next);
    setPage(1);
    setItems([]);
  };

  const openReplay = async (item: SingleReplayItem | MultiReplayItem) => {
    setReplayLoadingId(item.id);
    setOpponentStats(null);
    try {
      if (item.type === 'single') {
        const res = await api.get<Omit<SingleReplay, 'type'>>(`/stats/games/${item.id}/replay`);
        setReplay({ type: 'single', ...res.data });
      } else {
        const res = await api.get<Omit<MultiReplay, 'type'>>(`/stats/matches/${item.id}/replay`);
        setReplay({ type: 'multi', ...res.data });
      }
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setReplayLoadingId(null);
    }
  };

  const loadOpponentStats = async () => {
    if (replay?.type !== 'multi' || opponentStatsLoading) return;
    setOpponentStatsLoading(true);
    try {
      const res = await api.get<{ displayId: string; stats: PlayerPerformanceStats }>(
        `/stats/matches/${replay.id}/opponent-stats`
      );
      setOpponentStats(res.data.stats);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setOpponentStatsLoading(false);
    }
  };

  const replayButton = (item: SingleReplayItem | MultiReplayItem) => (
    <button
      className="btn btn-ghost btn-sm stats-replay-button"
      type="button"
      onClick={() => void openReplay(item)}
      disabled={replayLoadingId === item.id}
      aria-label={t('stats.replayAria', { id: item.id })}
    >
      <Play size={14} />
      {replayLoadingId === item.id ? t('stats.loading') : t('stats.replay')}
    </button>
  );

  const singleColumns: Column<SingleReplayItem>[] = [
    { key: 'mode', title: t('stats.mode'), render: (game) => difficultyLabel(t, game.mode) },
    { key: 'status', title: t('stats.result'), render: (game) => game.status === 'won'
      ? <Badge text={t('common.win')} color="green" /> : <Badge text={t('common.loss')} color="gray" /> },
    { key: 'guessCount', title: t('stats.guesses') },
    { key: 'answer', title: t('stats.answer') },
    { key: 'finishedAt', title: t('stats.time'), render: (game) => new Date(game.finishedAt).toLocaleString(currentLocale()) },
    { key: 'replay', title: t('stats.replay'), render: replayButton },
  ];

  const multiColumns: Column<MultiReplayItem>[] = [
    { key: 'mode', title: t('stats.mode'), render: (game) => `${difficultyLabel(t, game.mode)} · BO${game.boType}` },
    { key: 'result', title: t('stats.result'), render: (game) => game.result === 'won'
      ? <Badge text={t('common.win')} color="green" />
      : game.result === 'draw'
        ? <Badge text={t('common.draw')} color="gray" />
        : <Badge text={t('common.loss')} color="gray" /> },
    { key: 'opponent', title: t('stats.matchup'), render: (game) => `${t('common.me')} / ${game.opponent?.displayId ?? t('stats.unknownOpponent')}` },
    { key: 'score', title: t('stats.score'), render: (game) => `${game.me.score}:${game.opponent?.score ?? 0}` },
    { key: 'finishedAt', title: t('stats.time'), render: (game) => new Date(game.finishedAt).toLocaleString(currentLocale()) },
    { key: 'replay', title: t('stats.replay'), render: replayButton },
  ];

  return (
    <Page title={t('stats.title')} icon={<BarChart3 size={17} />}>
      <div className="stats-content">
        {!stats && statsLoading && (
          <section className="stats-difficulty-section" aria-busy="true">
            <div className="stats-difficulty-toolbar">
              <StatsDifficultyMultiSelect value={selectedDifficulties} onChange={setSelectedDifficulties} />
            </div>
            <div className="stats-overview-grid">
              <div className="card" role="status" aria-label={t('common.loading')}>
                <div className="table-skeleton"><i /><i /><i /><i /><i /><i /><i /><i /></div>
              </div>
              <div className="card" aria-hidden="true">
                <div className="table-skeleton"><i /><i /><i /><i /><i /><i /><i /><i /></div>
              </div>
            </div>
          </section>
        )}
        {!stats && !statsLoading && statsError && (
          <section className="stats-difficulty-section">
            <div className="stats-difficulty-toolbar">
              <StatsDifficultyMultiSelect value={selectedDifficulties} onChange={setSelectedDifficulties} />
            </div>
            <div className="card game-empty-actions" style={{ alignItems: 'center' }}>
              <p className="muted" style={{ margin: 0 }}>{t('stats.loadFailed')}</p>
              <button className="btn btn-ghost btn-sm" type="button" onClick={loadStats}>
                {t('common.retry')}
              </button>
            </div>
          </section>
        )}
        {stats && (
          <section className="stats-difficulty-section" aria-busy={statsLoading}>
            <div className="stats-difficulty-toolbar">
              <StatsDifficultyMultiSelect value={selectedDifficulties} onChange={setSelectedDifficulties} />
            </div>
            <div className="stats-overview-grid">
              <div className="card">
                <h3><BarChart3 size={16} />{t('stats.personal')}</h3>
                <StatTable rows={[
                  [t('stats.singleGames'), stats.personal.totalGames],
                  [t('stats.singleWins'), stats.personal.wins],
                  [t('stats.singleWinRate'), `${(stats.personal.winRate * 100).toFixed(1)}%`],
                  [t('stats.avgWinningGuesses'), formatAverage(stats.personal.avgGuesses)],
                  [t('stats.bestGuess'), stats.personal.bestGuesses ?? '-'],
                  [t('stats.topFirstGuess'), formatFirstGuess(stats.personal.firstGuess)],
                  [t('stats.multiGamesWins'), `${stats.personal.multiGames} / ${stats.personal.multiWins}`],
                  [t('stats.multiAvgWinningGuesses'), formatAverage(stats.personal.multiAvgWinningGuesses)],
                ]} />
              </div>
              <div className="card">
                <h3><Users size={16} />{t('stats.global')}</h3>
                <StatTable rows={[
                  [t('stats.registeredUsers'), stats.global.registeredUsers],
                  [t('stats.singleGames'), stats.global.totalGames],
                  [t('stats.singleWins'), stats.global.wins],
                  [t('stats.globalWinRate'), `${(stats.global.winRate * 100).toFixed(1)}%`],
                  [t('stats.avgWinningGuesses'), formatAverage(stats.global.avgGuesses)],
                  [t('stats.topFirstGuess'), formatFirstGuess(stats.global.firstGuess)],
                  [t('stats.multiGames'), stats.global.multiGames],
                  [t('stats.multiAvgWinningGuesses'), formatAverage(stats.global.multiAvgWinningGuesses)],
                ]} />
              </div>
            </div>
          </section>
        )}

        <section className="card stats-recent-card">
          <div className="stats-replay-toolbar">
            <h3>{t('stats.personalReplays')}</h3>
            <div className="stats-replay-segments" role="tablist" aria-label={t('stats.replayType')}>
              <button type="button" role="tab" aria-selected={type === 'single'} className={type === 'single' ? 'active' : ''} onClick={() => chooseType('single')}>
                <User size={15} />{t('stats.single')}
              </button>
              <button type="button" role="tab" aria-selected={type === 'multi'} className={type === 'multi' ? 'active' : ''} onClick={() => chooseType('multi')}>
                <Swords size={15} />{t('stats.multi')}
              </button>
            </div>
          </div>
          <div className="stats-recent-table stats-replay-desktop-list">
            {type === 'single' ? (
              <DataTable
                columns={singleColumns}
                rows={items.filter((item): item is SingleReplayItem => item.type === 'single')}
                rowKey={(game) => game.id}
                loading={loading}
                empty={t('stats.noSingle')}
              />
            ) : (
              <DataTable
                columns={multiColumns}
                rows={items.filter((item): item is MultiReplayItem => item.type === 'multi')}
                rowKey={(game) => game.id}
                loading={loading}
                empty={t('stats.noMulti')}
              />
            )}
          </div>
          <div className="stats-replay-mobile-list">
            {items.length ? items.map((item) => {
              const result = item.type === 'single' ? item.status : item.result;
              return (
              <article className="stats-replay-mobile-item" key={`${item.type}:${item.id}`}>
                <div className="stats-replay-mobile-heading">
                  <strong>{item.type === 'single'
                    ? difficultyLabel(t, item.mode)
                    : `${difficultyLabel(t, item.mode)} · BO${item.boType}`}</strong>
                  <Badge
                    text={result === 'won' ? t('common.win') : result === 'draw' ? t('common.draw') : t('common.loss')}
                    color={result === 'won' ? 'green' : 'gray'}
                  />
                </div>
                <div className="stats-replay-mobile-details">
                  {item.type === 'single' ? (
                    <>
                      <span>{t('stats.answer')} <strong>{item.answer}</strong></span>
                      <span>{t('stats.guesses')} <strong>{item.guessCount}</strong></span>
                    </>
                  ) : (
                    <>
                      <span>{t('stats.matchup')} <strong>{t('common.me')} / {item.opponent?.displayId ?? t('stats.unknownOpponent')}</strong></span>
                      <span>{t('stats.score')} <strong>{item.me.score}:{item.opponent?.score ?? 0}</strong></span>
                    </>
                  )}
                </div>
                <div className="stats-replay-mobile-footer">
                  <time dateTime={item.finishedAt}>{new Date(item.finishedAt).toLocaleString(currentLocale())}</time>
                  {replayButton(item)}
                </div>
              </article>
              );
            }) : <p className="muted">{loading
              ? t('common.loading')
              : type === 'single' ? t('stats.noSingle') : t('stats.noMulti')}</p>}
          </div>
          <div className="stats-pagination">
            <button className="btn btn-ghost" type="button" aria-label={t('common.previousPage')} title={t('common.previousPage')} disabled={page === 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              <ChevronLeft size={17} />
            </button>
            <span>{t('common.page', { page })}</span>
            <button className="btn btn-ghost" type="button" aria-label={t('common.nextPage')} title={t('common.nextPage')} disabled={!hasNext || loading} onClick={() => setPage((current) => current + 1)}>
              <ChevronRight size={17} />
            </button>
          </div>
        </section>
      </div>
      {replay && (
        <ReplayDialog
          replay={replay}
          opponentStats={opponentStats}
          opponentStatsLoading={opponentStatsLoading}
          onViewOpponentStats={replay.type === 'multi' ? () => void loadOpponentStats() : undefined}
          onClose={() => {
            setReplay(null);
            setOpponentStats(null);
          }}
        />
      )}
    </Page>
  );
}
