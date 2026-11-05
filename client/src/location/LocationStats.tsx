import { useEffect, useRef, useState } from 'react';
import { BarChart3, ChevronDown, ChevronLeft, ChevronRight, Play, Swords, User, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import Badge from '../components/Badge';
import DataTable, { type Column } from '../components/DataTable';
import StatsModeTabs from '../components/StatsModeTabs';
import { currentLocale } from '../i18n';
import { api, message } from './api';
import LocationReplayDialog from './LocationReplayDialog';
import type { Difficulty, LocationReplayItem, LocationReplayPage, LocationStatsResponse, LocationStatsSummary, ReplayRecord } from './types';
import '../styles/location.css';

const difficulties: Difficulty[] = ['easy', 'normal', 'hard'];
export default function LocationStats() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Difficulty[]>(difficulties);
  const difficultyKey = selected.join(',');
  const [summary, setSummary] = useState<LocationStatsResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState('');
  const [summaryRetry, setSummaryRetry] = useState(0);
  const [type, setType] = useState<'single' | 'multi'>('single');
  const [mode, setMode] = useState('all');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<LocationReplayItem[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [listRetry, setListRetry] = useState(0);
  const [opening, setOpening] = useState('');
  const [replay, setReplay] = useState<{ record: ReplayRecord; item: LocationReplayItem } | null>(null);
  const detailRequest = useRef(0);
  useEffect(() => {
    let alive = true;
    setSummaryLoading(true); setSummaryError('');
    void api.get<LocationStatsResponse>('/location/stats', { params: { difficulties: difficultyKey } })
      .then(({ data }) => { if (alive) setSummary(data); })
      .catch((error) => { if (alive) setSummaryError(message(error)); })
      .finally(() => { if (alive) setSummaryLoading(false); });
    return () => { alive = false; };
  }, [difficultyKey, summaryRetry]);
  useEffect(() => {
    let alive = true;
    detailRequest.current++; setReplay(null); setOpening('');
    setLoading(true); setListError(''); setItems([]); setHasNext(false);
    void api.get<LocationReplayPage>('/location/replays', { params: {
      difficulties: difficultyKey, type, mode, page, pageSize: 15,
    } })
      .then(({ data }) => { if (alive) { setItems(data.items); setHasNext(data.hasNext); } })
      .catch((error) => { if (alive) setListError(message(error)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; detailRequest.current++; };
  }, [difficultyKey, type, mode, page, listRetry]);
  const openReplay = async (item: LocationReplayItem) => {
    const request = ++detailRequest.current;
    setOpening(item.gameId); setListError('');
    try {
      const { data } = await api.get<ReplayRecord>(`/location/games/${item.gameId}/replay`);
      if (request === detailRequest.current) setReplay({ record: data, item });
    } catch (error) {
      if (request === detailRequest.current) setListError(message(error));
    } finally {
      if (request === detailRequest.current) setOpening('');
    }
  };
  const replayButton = (item: LocationReplayItem) => <button type="button" className="btn btn-ghost btn-sm stats-replay-button"
    aria-label={t('stats.replayAria', { id: item.gameId })} disabled={opening === item.gameId}
    onClick={() => void openReplay(item)}><Play size={14} />{t(opening === item.gameId ? 'stats.loading' : 'stats.replay')}</button>;
  const resultBadge = (item: LocationReplayItem) => <Badge
    text={item.retired ? t('location.retired') : item.mode === 'multiplayer'
      ? (item.rank === null ? '—' : `${t('location.rank')} #${item.rank}`) : t('location.completedGame')}
    color={item.retired ? 'gray' : 'green'} />;
  const columns: Column<LocationReplayItem>[] = [
    { key: 'mode', title: t('stats.mode'), render: (item) => `${t(`location.${item.mode}`)} · ${t(`location.${item.difficulty}`)}` },
    { key: 'result', title: t('stats.result'), render: resultBadge },
    { key: 'score', title: t('location.totalScore'), render: (item) => `${item.totalScore.toLocaleString()} / 25,000` },
    { key: 'time', title: t('stats.time'), render: (item) => new Date(item.finishedAt).toLocaleString(currentLocale()) },
    { key: 'replay', title: t('stats.replay'), render: replayButton },
  ];
  const formatScore = (score: number | null) => score === null ? '—' : score.toLocaleString();
  const summaryRows = (value: LocationStatsSummary, global: boolean): [string, string | number][] => [
    [t('location.acceptedSubmissionsLifetime'), value.acceptedSubmissions ?? 0],
    [t('stats.singleGames'), value.singleGames],
    [t('location.randomGames'), value.randomGames],
    [t('location.dailyGames'), value.dailyGames],
    [t('location.singleAverage'), formatScore(value.averageScore)],
    [t('location.singleBest'), formatScore(value.bestScore)],
    [t(global ? 'stats.multiGames' : 'stats.multiGamesWins'), global ? value.multiGames : `${value.multiGames} / ${value.multiWins}`],
    ...(global ? [[t('location.multiEntries'), value.multiEntries] as [string, number]] : []),
    [t('location.multiAverage'), formatScore(value.multiAverageScore)],
  ];
  return <Page title={t('stats.title')} icon={<BarChart3 size={17} />} className="location-page">
    <div className="stats-content">
      <StatsModeTabs />
      <section className="stats-difficulty-section" aria-busy={summaryLoading}>
        <div className="stats-difficulty-toolbar">
          <details className="difficulty-multi-select stats-difficulty-select">
            <summary className="difficulty-multi-select-trigger"><span className="difficulty-multi-select-summary">
              {selected.length === 3 ? t('stats.allDifficulties') : selected.map((value) => t(`location.${value}`)).join(', ')}
            </span><ChevronDown size={15} /></summary>
            <div className="difficulty-multi-select-menu" role="group" aria-label={t('stats.difficultyLevels')}>
              <label className="difficulty-multi-select-option"><input type="checkbox" checked={selected.length === 3}
                onChange={() => { setSelected(difficulties); setPage(1); }} />{t('stats.allDifficulties')}</label>
              {difficulties.map((value) => <label className="difficulty-multi-select-option" key={value}>
                <input type="checkbox" checked={selected.includes(value)} disabled={selected.length === 1 && selected.includes(value)}
                  onChange={(event) => { setSelected(difficulties.filter((item) => item === value ? event.target.checked : selected.includes(item))); setPage(1); }} />
                {t(`location.${value}`)}
              </label>)}
            </div>
          </details>
        </div>
        {summaryError && <div role="alert" className="stats-error"><p>{summaryError}</p>
          <button className="btn" disabled={summaryLoading} onClick={() => setSummaryRetry((n) => n + 1)}>{t('common.retry')}</button></div>}
        <div className="stats-overview-grid">
          {(['personal', 'global'] as const).map((scope) => <div className="card" key={scope}>
            <h3>{scope === 'personal' ? <BarChart3 size={16} /> : <Users size={16} />}{t(`stats.${scope}`)}</h3>
            {summary ? <table className="table stats-summary-table"><tbody>
              {summaryRows(summary[scope], scope === 'global').map(([label, value]) => <tr key={label}><td>{label}</td><td className="stat-value">{value}</td></tr>)}
            </tbody></table> : summaryLoading ? <div className="table-skeleton" role="status" aria-label={t('common.loading')}><i /><i /><i /><i /><i /></div> : <p className="muted">{t('stats.loadFailed')}</p>}
          </div>)}
        </div>
      </section>
      <section className="card stats-recent-card">
        <div className="stats-replay-toolbar">
          <h3>{t('stats.personalReplays')}</h3>
          <div className="stats-replay-segments" role="tablist" aria-label={t('stats.replayType')}>
            {(['single', 'multi'] as const).map((value) => <button type="button" role="tab" key={value}
              aria-selected={type === value} className={type === value ? 'active' : ''}
              onClick={() => { setType(value); setPage(1); }}>
              {value === 'single' ? <User size={15} /> : <Swords size={15} />}{t(`stats.${value}`)}
            </button>)}
          </div>
        </div>
        {type === 'single' && <label className="location-history-filter">{t('stats.mode')}
          <select className="input" value={mode} onChange={(event) => { setMode(event.target.value); setPage(1); }}>
            <option value="all">{t('location.allSingleModes')}</option>
            <option value="random">{t('location.random')}</option><option value="daily">{t('location.daily')}</option>
          </select>
        </label>}
        {listError && <div role="alert" className="stats-error"><p>{listError}</p>
          <button className="btn" disabled={loading} onClick={() => setListRetry((n) => n + 1)}>{t('common.retry')}</button></div>}
        <div className="stats-recent-table stats-replay-desktop-list"><DataTable columns={columns} rows={items}
          rowKey={(item) => item.gameId} loading={loading} empty={t('location.noHistory')} /></div>
        <div className="stats-replay-mobile-list" aria-busy={loading}>
          {items.map((item) => <article className="stats-replay-mobile-item" key={item.gameId}>
            <div className="stats-replay-mobile-heading"><strong>{t(`location.${item.mode}`)} · {t(`location.${item.difficulty}`)}</strong>{resultBadge(item)}</div>
            <div className="stats-replay-mobile-details"><span>{t('location.totalScore')} <strong>{item.totalScore.toLocaleString()} / 25,000</strong></span></div>
            <div className="stats-replay-mobile-footer"><time>{new Date(item.finishedAt).toLocaleString(currentLocale())}</time>{replayButton(item)}</div>
          </article>)}
          {!items.length && <p className="muted">{t(loading ? 'common.loading' : 'location.noHistory')}</p>}
        </div>
        <div className="stats-pagination">
          <button className="btn btn-ghost" type="button" aria-label={t('common.previousPage')} disabled={page === 1 || loading}
            onClick={() => setPage((n) => n - 1)}><ChevronLeft size={17} /></button>
          <span>{t('common.page', { page })}</span>
          <button className="btn btn-ghost" type="button" aria-label={t('common.nextPage')} disabled={!hasNext || loading}
            onClick={() => setPage((n) => n + 1)}><ChevronRight size={17} /></button>
        </div>
      </section>
    </div>
    {replay && <LocationReplayDialog key={replay.item.gameId} replay={replay.record} item={replay.item}
      onClose={() => { detailRequest.current++; setReplay(null); }} />}
  </Page>;
}
