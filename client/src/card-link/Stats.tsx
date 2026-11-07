import CardReplayDialog, { type CardReplay } from './ReplayDialog';
import { useEffect, useRef, useState } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Play, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Variant } from '@friberg/card-link-core';
import { api, errMsg } from '../api/client';
import { currentLocale } from '../i18n';
import Page from '../components/Page';
import Badge from '../components/Badge';
import DataTable, { type Column } from '../components/DataTable';
import StatsModeTabs from '../components/StatsModeTabs';
import '../styles/location.css';
import './style.css';

type Summary = { games: number; entries: number; rounds: number; solved: number; modes: Record<string, number>; solveRate: number | null; averageHops: number | null; averageElapsed: number | null };
type SummaryResponse = { personal: Summary; global: Summary; rating: number | null };
type Item = { id: string; scene: string; dailyPractice?: boolean; variant: Variant; solved: number; rounds: number; hops: number; elapsed: number; finishedAt: number; retired: boolean; rank: number | null };
export default function CardStats() {
  const { t } = useTranslation(), tr = (key: string) => t(`card.${key}`);
  const [variant, setVariant] = useState<Variant>('unlimited');
  const [scene, setScene] = useState('all'), [page, setPage] = useState(1), [retry, setRetry] = useState(0);
  const [summary, setSummary] = useState<SummaryResponse | null>(null), [items, setItems] = useState<Item[]>([]);
  const [hasNext, setHasNext] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [replay, setReplay] = useState<CardReplay | null>(null), [opening, setOpening] = useState('');
  const detailRequest = useRef(0);
  useEffect(() => {
    let alive = true;
    setSummary(null); setError('');
    void api.get<SummaryResponse>('/stats/me', { params: { variant: 'card-link', hand: variant } })
      .then(({ data }) => { if (alive) setSummary(data); }).catch(error => { if (alive) setError(errMsg(error)); });
    return () => { alive = false; };
  }, [variant, retry]);
  useEffect(() => {
    let alive = true;
    detailRequest.current++; setReplay(null); setOpening(''); setItems([]); setLoading(true); setHasNext(false);
    void api.get<{ items: Item[]; hasNext: boolean }>('/stats/replays', { params: { variant: 'card-link', hand: variant, scene, page } })
      .then(({ data }) => { if (alive) { setItems(data.items); setHasNext(data.hasNext); } })
      .catch(error => { if (alive) setError(errMsg(error)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; detailRequest.current++; };
  }, [variant, scene, page, retry]);
  const open = async (item: Item) => {
    const request = ++detailRequest.current;
    setOpening(item.id);
    try { const { data } = await api.get<CardReplay>(`/stats/games/${item.id}/replay`, { params: { variant: 'card-link' } }); if (request === detailRequest.current) setReplay(data); }
    catch (error) { if (request === detailRequest.current) setError(errMsg(error)); }
    finally { if (request === detailRequest.current) setOpening(''); }
  };
  const result = (item: Item) => <Badge text={item.retired ? t('location.retired') : item.rank ? `${t('location.rank')} #${item.rank}` : t('location.completedGame')} color={item.retired ? 'gray' : 'green'} />;
  const replayButton = (item: Item) => <button className="btn btn-ghost btn-sm stats-replay-button" disabled={opening === item.id} onClick={() => void open(item)}><Play size={14} />{t('stats.replay')}</button>;
  const columns: Column<Item>[] = [
    { key: 'mode', title: t('stats.mode'), render: item => `${tr(item.dailyPractice ? 'dailyPractice' : item.scene)} · ${tr(item.variant)}` },
    { key: 'result', title: t('stats.result'), render: result },
    { key: 'solved', title: tr('solvedRounds'), render: item => `${item.solved}/${item.rounds}` },
    { key: 'hops', title: tr('totalHops'), render: item => item.hops },
    { key: 'elapsed', title: tr('solvedTime'), render: item => `${(item.elapsed / 1000).toFixed(1)} ${tr('seconds')}` },
    { key: 'time', title: t('stats.time'), render: item => new Date(item.finishedAt).toLocaleString(currentLocale()) },
    { key: 'replay', title: t('stats.replay'), render: replayButton },
  ];
  const rows = (value: Summary): [string, string | number][] => [
    [tr('totalGames'), value.games],
    ...['practice', 'daily', 'friend', 'ranked'].map(scene => [tr(scene), value.modes[scene] ?? 0] as [string, number]),
    [tr('solvedRounds'), `${value.solved}/${value.rounds}`],
    [tr('solveRate'), value.solveRate === null ? '—' : `${(value.solveRate * 100).toFixed(1)}%`],
    [tr('averageHops'), value.averageHops?.toFixed(2) ?? '—'],
    [tr('averageTime'), value.averageElapsed === null ? '—' : `${(value.averageElapsed / 1000).toFixed(1)} ${tr('seconds')}`],
  ];
  return <Page title={t('stats.title')} icon={<BarChart3 size={17} />} className="location-page"><div className="stats-content">
    <StatsModeTabs />
    <div className="cl-toolbar"><label>{tr('handMode')} <select value={variant} onChange={e => { setVariant(e.target.value as Variant); setPage(1); }}>
      <option value="unlimited">{tr('unlimited')}</option><option value="limited">{tr('limited')}</option></select></label></div>
    {error && <div role="alert" className="stats-error"><p>{error}</p><button className="btn" onClick={() => setRetry(n => n + 1)}>{t('common.retry')}</button></div>}
    <div className="stats-overview-grid">{(['personal', 'global'] as const).map(scope => <section className="card" key={scope}>
      <h3>{scope === 'personal' ? <BarChart3 size={16} /> : <Users size={16} />}{t(`stats.${scope}`)}</h3>
      {summary ? <table className="table stats-summary-table"><tbody>{rows(summary[scope]).map(([label, value]) => <tr key={label}><td>{label}</td><td className="stat-value">{value}</td></tr>)}
        {scope === 'personal' && <tr><td>{tr('rating')}</td><td className="stat-value">{summary.rating ?? '—'}</td></tr>}
      </tbody></table> : <p role="status">{t(error ? 'stats.loadFailed' : 'common.loading')}</p>}
    </section>)}</div>
    <p className="muted">{tr('statsNote')}</p>
    <section className="card stats-recent-card"><h3>{t('stats.personalReplays')}</h3>
      <label className="location-history-filter">{t('stats.mode')} <select className="input" value={scene} onChange={e => { setScene(e.target.value); setPage(1); }}>
        <option value="all">{tr('allScenes')}</option>{['practice', 'daily', 'friend', 'ranked'].map(value => <option key={value} value={value}>{tr(value)}</option>)}
      </select></label>
      <div className="stats-replay-desktop-list"><DataTable columns={columns} rows={items} rowKey={item => item.id} loading={loading} empty={tr('none')} /></div>
      <div className="stats-replay-mobile-list">{items.map(item => <article className="stats-replay-mobile-item" key={item.id}>
        <div className="stats-replay-mobile-heading"><strong>{tr(item.dailyPractice ? 'dailyPractice' : item.scene)} · {tr(item.variant)}</strong>{result(item)}</div>
        <p>{tr('solvedRounds')} {item.solved}/{item.rounds} · {item.hops} {tr('hops')} · {(item.elapsed / 1000).toFixed(1)} {tr('seconds')}</p>
        <div className="stats-replay-mobile-footer"><time>{new Date(item.finishedAt).toLocaleString(currentLocale())}</time>{replayButton(item)}</div>
      </article>)}{!items.length && <p className="muted">{t(loading ? 'common.loading' : 'card.none')}</p>}</div>
      <div className="stats-pagination"><button className="btn btn-ghost" aria-label={t('common.previousPage')} disabled={page === 1 || loading} onClick={() => setPage(n => n - 1)}><ChevronLeft size={17} /></button>
        <span>{t('common.page', { page })}</span><button className="btn btn-ghost" aria-label={t('common.nextPage')} disabled={!hasNext || loading} onClick={() => setPage(n => n + 1)}><ChevronRight size={17} /></button></div>
    </section>
  </div>{replay && <CardReplayDialog replay={replay} close={() => { detailRequest.current++; setReplay(null); }} />}</Page>;
}
