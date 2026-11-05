import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MapDefinition, Question } from '../../../location/types';
import { locationAdmin, type BatchPublishResponse, type QuestionPage } from './api';
import { useAdminTask } from './useAdminTask';
import type { RadarSelection } from '../../../location/Radar';
import QuestionAreaFilter from './QuestionAreaFilter';
import PointMergePanel from './PointMergePanel';

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
  return (
    <>
      <p className="muted">{t('location.samePointDrawHelp')}</p>
      <div className="location-bulk-publish">
        <button type="button" className="btn" disabled={task.busy || !pendingCount}
          onClick={() => void publishAll()}>
          {t(task.busy ? 'location.batchPublishing' : 'location.batchPublish', { count: pendingCount })}
        </button>
        <p className="muted">{t('location.batchPublishHelp')}</p>
        {results.length > 0 && <p role="status">{t('location.batchPublishResult', {
          published, failed: failures.length,
        })}</p>}
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
      <div className="location-admin-actions">
        <button className="btn" disabled={task.busy} onClick={onNew}>
          {t('location.newQuestion')}
        </button>
        <input
          className="input"
          aria-label={t('location.searchQuestions')}
          placeholder={t('location.searchQuestions')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="input"
          aria-label={t('location.mapName')}
          value={mapId}
          onChange={(e) => {
            const next = maps.find((map) => map.id === e.target.value);
            setMapId(e.target.value);
            setFloorId(next?.floors.length === 1 ? next.floors[0].id : '');
            setArea(null);
          }}
        >
          <option value="">{t('location.allMaps')}</option>
          {maps.map((map) => (
            <option key={map.id} value={map.id}>
              {map.name}
            </option>
          ))}
        </select>
        <select className="input" aria-label={t('location.submissionFloor')}
          value={selectedFloor} disabled={!selectedMap}
          onChange={(event) => { setFloorId(event.target.value); setArea(null); }}>
          <option value="">{t('location.allQuestionFloors')}</option>
          {selectedMap?.floors.map((floor) => <option key={floor.id} value={floor.id}>
            {t(`location.floor.${floor.id}`, { defaultValue: floor.name })}
          </option>)}
        </select>
        <select
          className="input"
          aria-label={t('location.questionStatus')}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">{t('location.allStatuses')}</option>
          {['draft', 'review', 'published', 'disabled'].map((item) => (
            <option key={item} value={item}>
              {t(
                item === 'review' ? 'location.reviewStatus' : `location.${item}`
              )}
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label={t('location.questionTier')}
          value={tier}
          onChange={(e) => setTier(e.target.value)}
        >
          <option value="">{t('location.allTiers')}</option>
          {['easy', 'medium', 'hard'].map((item) => (
            <option key={item} value={item}>
              {t(`location.${item}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="location-admin-actions">
        <button className="btn btn-ghost" disabled={!selectedMap || !selectedFloor} aria-pressed={merging}
          onClick={() => setMerging(value => !value)}>{t(merging ? 'location.mergeClose' : 'location.mergeTitle')}</button>
        <span className="muted">{t('location.mergeEntryHelp')}</span>
      </div>
      {merging && selectedMap && selectedFloor && <PointMergePanel
        key={`${selectedMap.id}:${selectedMap.version}:${selectedFloor}`}
        map={selectedMap} floorId={selectedFloor} onChanged={onChanged} />}
      {selectedMap && selectedFloor ? <QuestionAreaFilter
        key={`${selectedMap.id}:${selectedMap.version}:${selectedFloor}`}
        map={selectedMap} floorId={selectedFloor} selection={selectedArea}
        onChange={(next) => setArea(next ? { ...next, mapId, floorId: selectedFloor, mapVersion: selectedMap.version } : null)}
      /> : <p className="muted">{t('location.questionAreaChooseFloor')}</p>}
      <p role="status">{t('location.questionFilterCount', { count: total, total: serverPaged ? remote?.totalAll ?? total : questions.length })}</p>
      {loading && <p role="status">{t('location.loadingAdmin')}</p>}
      {queryError && <p role="alert">{queryError}</p>}
      {pageCount > 1 && <div className="location-admin-actions">
        <button className="btn btn-ghost" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>{t('location.previousPage')}</button>
        <span>{page} / {pageCount}</span>
        <button className="btn btn-ghost" disabled={page >= pageCount || loading} onClick={() => setPage(p => p + 1)}>{t('location.nextPage')}</button>
      </div>}
      {!items.length && !loading && (
        <p className="location-admin-empty">{t('location.noQuestions')}</p>
      )}
      <div className="location-admin-question-list">
        {items.map((item) => (
          <div className="location-question-card" key={item.id}>
          <button disabled={task.busy} onClick={() => onEdit(item)}>
            <img
              loading="lazy"
              src={item.thumbnailUrl}
              alt={item.capturePointId}
            />
            <span>
              {maps.find((map) => map.id === item.mapId)?.name} ·{' '}
              {t(`location.${item.tier}`)}
            </span>
            <span>{item.capturePointId}</span>
            <span>{t('location.samePointQuestions', { count: pointCounts[JSON.stringify([item.mapId, item.capturePointId])] || 1 })}</span>
            <span>
              {t(
                item.status === 'review'
                  ? 'location.reviewStatus'
                  : `location.${item.status}`
              )}{' '}
              · v{item.version}
            </span>
            {maps.find((map) => map.id === item.mapId)?.version !==
              item.mapVersion && (
              <span className="location-error">
                {t('location.captureMapChanged')}
              </span>
            )}
          </button>
          {onAddVariant && <button className="btn btn-ghost" disabled={task.busy} onClick={() => onAddVariant(item)}>{t('location.addPointVariant')}</button>}
          </div>
        ))}
      </div>
    </>
  );
}
