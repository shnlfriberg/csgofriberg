import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MapDefinition, Question } from '../../../location/types';
import { locationAdmin, type BatchPublishResponse, type QuestionPage } from './api';
import { useAdminTask } from './useAdminTask';
import type { RadarSelection } from '../../../location/Radar';
import QuestionAreaFilter from './QuestionAreaFilter';
import PointMergePanel from './PointMergePanel';
import { Combine, Plus, Search, Send } from 'lucide-react';
import { Pagination, Panel, Toolbar } from '../ui';

export default function QuestionManager({
  maps,
  questions,
  onEdit,
  onNew,
  onAddVariant,
  onChanged,
  serverPaged = false,
  revision = 0,
}: {
  serverPaged?: boolean;
  revision?: number;
  maps: MapDefinition[];
  questions: Question[];
  onEdit: (question: Question) => void;
  onNew: () => void;
  onAddVariant?: (question: Question) => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [merging, setMerging] = useState(false);
  const [mapId, setMapId] = useState('');
  const [floorId, setFloorId] = useState('');
  const [area, setArea] = useState<(RadarSelection & { mapId: string; floorId: string; mapVersion: number }) | null>(null);
  const selectedMap = maps.find((map) => map.id === mapId);
  const selectedFloor = selectedMap?.floors.some((floor) => floor.id === floorId) ? floorId : '';
  const selectedArea = area && area.mapId === mapId && area.floorId === selectedFloor && area.mapVersion === selectedMap?.version ? area : null;
  const [status, setStatus] = useState('');
  const [tier, setTier] = useState('');
  const task = useAdminTask();
  const [page, setPage] = useState(1);
  const [remote, setRemote] = useState<QuestionPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [queryError, setQueryError] = useState('');
  const queryKey = JSON.stringify({ mapId: mapId || undefined, floorId: selectedFloor || undefined,
    status: status || undefined, tier: tier || undefined, search: search || undefined,
    ...(selectedArea ? { minU: selectedArea.minU, maxU: selectedArea.maxU, minV: selectedArea.minV, maxV: selectedArea.maxV } : {}) });
  useEffect(() => setPage(1), [queryKey]);
  useEffect(() => {
    if (!serverPaged) return;
    const controller = new AbortController();
    setLoading(true); setQueryError('');
    const timer = setTimeout(() => {
      void locationAdmin.questions({ ...JSON.parse(queryKey), page, pageSize: 40 }, controller.signal)
        .then(data => { if (!controller.signal.aborted) setRemote(data); })
        .catch(() => { if (!controller.signal.aborted) setQueryError(t('location.loadFailed', { defaultValue: '加载失败，请切换筛选重试' })); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [serverPaged, queryKey, page, revision, t]);
  const localPointCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const q of questions) { const key = JSON.stringify([q.mapId, q.capturePointId]); counts[key] = (counts[key] || 0) + 1; }
    return counts;
  }, [questions]);
  const [results, setResults] = useState<BatchPublishResponse['results']>([]);
  const pending = questions.filter((q) => q.status === 'draft' || q.status === 'review');
  const pendingCount = serverPaged ? remote?.pending || 0 : pending.length;
  const published = results.filter((result) => result.ok).length;
  const failures = results.filter((result) => !result.ok);
  const publishAll = () => task.run(async () => {
    const targets = serverPaged ? await locationAdmin.pendingQuestions() : pending.map(({ id, version }) => ({ id, version }));
    if (!targets.length) return;
    setResults([]);
    const completed: BatchPublishResponse['results'] = [];
    try {
      for (let offset = 0; offset < targets.length; offset += 500) {
        const response = await locationAdmin.publishQuestions(targets.slice(offset, offset + 500));
        completed.push(...response.results);
        setResults([...completed]);
      }
    } finally {
      // Refresh even after a lost response: some requests may already be saved.
      await onChanged();
    }
  });
  const filtered = questions.filter(
    (q) =>
      (!mapId || q.mapId === mapId) &&
      (!selectedFloor || q.floorId === selectedFloor) &&
      (!selectedArea || (
        q.u >= selectedArea.minU - 1e-10 && q.u <= selectedArea.maxU + 1e-10 &&
        q.v >= selectedArea.minV - 1e-10 && q.v <= selectedArea.maxV + 1e-10
      )) &&
      (!status || q.status === status) &&
      (!tier || q.tier === tier) &&
      `${q.id} ${q.capturePointId} ${q.source}`
        .toLowerCase()
        .includes(search.toLowerCase())
  );
  const total = serverPaged ? remote?.total || 0 : filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / 40));
  const items = serverPaged ? remote?.items || [] : filtered.slice((page - 1) * 40, page * 40);
  const pointCounts = serverPaged ? remote?.pointCounts || {} : localPointCounts;
  const mapName = (id: string) => maps.find((map) => map.id === id)?.name;
  const filterSelect = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: Array<[string, string]>,
    disabled = false,
  ) => (
    <select className="input" aria-label={label} title={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </select>
  );
  return (
    <Panel flush className="admin-list-panel location-question-panel">
      <Toolbar
        end={(
          <>
            <button className="btn btn-ghost btn-sm" disabled={!selectedMap || !selectedFloor} aria-pressed={merging}
              title={t('location.mergeEntryHelp')} onClick={() => setMerging(value => !value)}>
              <Combine size={15} aria-hidden="true" />{t(merging ? 'location.mergeClose' : 'location.mergeTitle')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={task.busy || !pendingCount}
              title={t('location.batchPublishHelp')} onClick={() => void publishAll()}>
              <Send size={15} aria-hidden="true" />
              {t(task.busy ? 'location.batchPublishing' : 'location.batchPublish', { count: pendingCount })}
            </button>
            <button className="btn btn-sm" disabled={task.busy} onClick={onNew}>
              <Plus size={15} aria-hidden="true" />{t('location.newQuestion')}
            </button>
          </>
        )}
      >
        <span className="admin-search">
          <Search size={15} aria-hidden="true" />
          <input
            className="input"
            aria-label={t('location.searchQuestions')}
            placeholder={t('location.searchQuestions')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </span>
        {filterSelect(t('location.mapName'), mapId, (value) => {
          const next = maps.find((map) => map.id === value);
          setMapId(value);
          setFloorId(next?.floors.length === 1 ? next.floors[0].id : '');
          setArea(null);
        }, [['', t('location.allMaps')], ...maps.map((map): [string, string] => [map.id, map.name])])}
        {filterSelect(t('location.submissionFloor'), selectedFloor, (value) => { setFloorId(value); setArea(null); },
          [['', t('location.allQuestionFloors')], ...(selectedMap?.floors ?? []).map((floor): [string, string] => [floor.id, t(`location.floor.${floor.id}`, { defaultValue: floor.name })])],
          !selectedMap)}
        {filterSelect(t('location.questionStatus'), status, setStatus,
          [['', t('location.allStatuses')], ...['draft', 'review', 'published', 'disabled'].map((item): [string, string] => [item, t(item === 'review' ? 'location.reviewStatus' : `location.${item}`)])])}
        {filterSelect(t('location.questionTier'), tier, setTier,
          [['', t('location.allTiers')], ...['easy', 'medium', 'hard'].map((item): [string, string] => [item, t(`location.${item}`)])])}
      </Toolbar>
      {(results.length > 0 || task.error || failures.length > 0) && (
        <div className="admin-panel-body location-question-notices">
          {results.length > 0 && <p role="status">{t('location.batchPublishResult', { published, failed: failures.length })}</p>}
          {task.error && <p role="alert" className="location-alert">{task.error}</p>}
          {failures.length > 0 && <div className="location-alert" role="alert">
            <strong>{t('location.batchPublishFailures')}</strong>
            <ul>{failures.map((result) => <li key={result.id}>
              {result.capturePointId} · {result.id}：{t(`location.errors.${result.code}`, {
                defaultValue: t(`errors.${result.code}`, { defaultValue: result.code }),
              })}
            </li>)}</ul>
          </div>}
        </div>
      )}
      {merging && selectedMap && selectedFloor && <div className="admin-panel-body location-question-merge">
        <PointMergePanel
          key={`${selectedMap.id}:${selectedMap.version}:${selectedFloor}`}
          map={selectedMap} floorId={selectedFloor} onChanged={onChanged} />
      </div>}
      <div className={`admin-panel-body location-question-layout${selectedMap && selectedFloor ? ' has-area' : ''}`}>
        {selectedMap && selectedFloor && <aside className="location-question-aside">
          <QuestionAreaFilter
            key={`${selectedMap.id}:${selectedMap.version}:${selectedFloor}`}
            map={selectedMap} floorId={selectedFloor} selection={selectedArea}
            onChange={(next) => setArea(next ? { ...next, mapId, floorId: selectedFloor, mapVersion: selectedMap.version } : null)}
          />
        </aside>}
        <div className="location-question-results">
          <div className="location-question-meta">
            <strong role="status">{t('location.questionFilterCount', { count: total, total: serverPaged ? remote?.totalAll ?? total : questions.length })}</strong>
            {!(selectedMap && selectedFloor) && <span>{t('location.questionAreaChooseFloor')}</span>}
            <span>{t('location.samePointDrawHelp')}</span>
          </div>
          {loading && <p role="status" className="admin-help">{t('location.loadingAdmin')}</p>}
          {queryError && <p role="alert" className="location-alert">{queryError}</p>}
          {!items.length && !loading && (
            <p className="admin-empty">{t('location.noQuestions')}</p>
          )}
          <div className="location-admin-question-list">
            {items.map((item) => (
              <div className="location-question-card" key={item.id}>
                <button disabled={task.busy} onClick={() => onEdit(item)}>
                  <img loading="lazy" src={item.thumbnailUrl} alt={item.capturePointId} />
                  <span className="location-question-card-title">{mapName(item.mapId)} · {t(`location.${item.tier}`)}</span>
                  <span className="location-question-card-id">{item.capturePointId}</span>
                  <span>{t('location.samePointQuestions', { count: pointCounts[JSON.stringify([item.mapId, item.capturePointId])] || 1 })}</span>
                  <span className={`location-question-status is-${item.status}`}>
                    {t(item.status === 'review' ? 'location.reviewStatus' : `location.${item.status}`)} · v{item.version}
                  </span>
                  {maps.find((map) => map.id === item.mapId)?.version !== item.mapVersion && (
                    <span className="location-error">{t('location.captureMapChanged')}</span>
                  )}
                </button>
                {onAddVariant && <button className="admin-action" disabled={task.busy} onClick={() => onAddVariant(item)}>{t('location.addPointVariant')}</button>}
              </div>
            ))}
          </div>
        </div>
      </div>
      {pageCount > 1 && <Pagination page={page} totalPages={pageCount} total={total} pageSize={40} loading={loading} onPage={setPage} />}
    </Panel>
  );
}
