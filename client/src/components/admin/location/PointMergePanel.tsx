import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MergePoint, MergePointsInput } from '@friberg/location-core';
import type { Guess, MapDefinition } from '../../../location/types';
import Radar from '../../../location/Radar';
import { message } from '../../../location/api';
import { locationAdmin } from './api';
import { useAdminTask } from './useAdminTask';

export default function PointMergePanel({ map, floorId, onChanged }: {
  map: MapDefinition; floorId: string; onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<MergePoint[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [targetStep, setTargetStep] = useState(false);
  const [target, setTarget] = useState<Guess | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [request, setRequest] = useState<MergePointsInput | null>(null);
  const task = useAdminTask();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError(''); task.setError(''); setItems([]); setSelected([]); setTarget(null); setTargetStep(false); setRequest(null);
    void locationAdmin.mergeCandidates(map.id, floorId, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (data.mapVersion !== map.version) throw new Error(t('location.mergeMapChanged'));
      setItems(data.items);
    }).catch(error => { if (!controller.signal.aborted) setLoadError(message(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [map.id, map.version, floorId, revision, t]);
  const chosen = selected.map(id => items.find(p => p.capturePointId === id)!).filter(Boolean);
  const questions = chosen.reduce((n, p) => n + p.questions, 0);
  const images = chosen.reduce((n, p) => n + p.images, 0);
  const toggle = (id: string) => {
    if (task.isBusy() || request) return;
    const point = items.find(p => p.capturePointId === id);
    if (!point?.eligible) return;
    if (targetStep) { setTarget({ mapId: map.id, floorId, u: point.u, v: point.v }); return; }
    setSelected(old => old.includes(id) ? old.filter(value => value !== id) : old.length < 100 ? [...old, id] : old);
  };
  const merge = () => task.run(async () => {
    if (!target || selected.length < 2) return;
    const input = request || { ...target, mapVersion: map.version, operationId: crypto.randomUUID(),
      points: chosen.map(({ capturePointId, fingerprint }) => ({ capturePointId, fingerprint })) };
    setRequest(input);
    const result = await locationAdmin.mergePoints(input);
    if (!mounted.current) return;
    setRevision(value => value + 1);
    task.setNotice(t('location.mergeDone', { count: result.points, questions: result.questions, images: result.images }));
    await onChanged();
  });
  return <section className="location-point-merge" aria-label={t('location.mergeTitle')}>
    <h3>{t('location.mergeTitle')}</h3>
    <p>{t('location.mergeHelp')}</p>
    <p className="muted">{t('location.mergeHistoryHelp')}</p>
    <div className="location-admin-actions">
      <button className="btn btn-ghost" disabled={task.busy || loading} onClick={() => setRevision(value => value + 1)}>{t('location.mergeReload')}</button>
      {!targetStep ? <button className="btn" disabled={loading || selected.length < 2 || images > 100}
        onClick={() => { setTargetStep(true); setTarget(null); }}>{t('location.mergeChooseTarget')}</button>
        : <button className="btn btn-ghost" disabled={task.busy || !!request} onClick={() => { setTargetStep(false); setTarget(null); }}>{t('location.mergeReselect')}</button>}
    </div>
    {loading && <p role="status">{t('location.loadingAdmin')}</p>}
    {loadError && <p role="alert">{loadError}</p>}
    {task.error && <p role="alert">{task.error} {t('location.mergeRetryHelp')}</p>}
    {task.notice && <p role="status">{task.notice}</p>}
    {!loading && !loadError && <>
      <p role="status">{t('location.mergeSummary', { count: selected.length, questions, images })}</p>
      {images > 100 && <p role="alert">{t('location.mergeImageLimit')}</p>}
      <div className="location-point-merge-grid">
        <Radar map={map} floorId={floorId} guess={target} guessLabel={t('location.mergeTarget')}
          markers={items.map((p, index) => ({ ...p, id: p.capturePointId, label: String(index + 1),
            ariaLabel: t('location.mergePointLabel', { number: index + 1, id: p.capturePointId }),
            selected: selected.includes(p.capturePointId), color: p.eligible ? undefined : '#888',
            title: p.capturePointId })).filter(p => !targetStep || p.selected)}
          onMarkerSelect={!request && !task.busy ? toggle : undefined}
          onChange={targetStep && !request && !task.busy ? setTarget : undefined}
          hint={t(targetStep ? 'location.mergeTargetHelp' : 'location.mergeSelectHelp')} />
        <div className="location-merge-point-list">
          {items.map((point, index) => (!targetStep || selected.includes(point.capturePointId)) && <label className="location-merge-point" key={point.capturePointId}>
            <input type="checkbox" checked={selected.includes(point.capturePointId)}
              disabled={!point.eligible || targetStep || task.busy || !!request || (!selected.includes(point.capturePointId) && selected.length >= 100)}
              onChange={() => toggle(point.capturePointId)} />
            <span><strong>#{index + 1} · {point.capturePointId}</strong>
              <small>{t('location.mergePointCounts', { questions: point.questions, images: point.images })}</small>
              {!point.eligible && <small>{t('location.mergeMapChanged')}</small>}
              {selected.includes(point.capturePointId) && <span className="location-merge-thumbnails">{point.thumbnails.map((url, i) => <img key={`${url}:${i}`} src={url} alt="" loading="lazy" />)}</span>}
            </span>
          </label>)}
          {!items.length && <p>{t('location.noQuestions')}</p>}
        </div>
      </div>
      {targetStep && <div className="location-alert">
        <p>{target ? t('location.mergeTargetCoordinates', { u: target.u.toFixed(4), v: target.v.toFixed(4) }) : t('location.mergeTargetHelp')}</p>
        <p>{t('location.mergeConfirmHelp')}</p>
        <button className="btn" disabled={!target || task.busy || images > 100} onClick={() => void merge()}>
          {t(task.busy ? 'location.mergeSaving' : request ? 'location.mergeRetry' : 'location.mergeConfirm')}
        </button>
      </div>}
    </>}
  </section>;
}
