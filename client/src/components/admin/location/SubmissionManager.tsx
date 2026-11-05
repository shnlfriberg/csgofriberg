import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../../ConfirmDialog';
import { api, message } from '../../../location/api';
import { Photo } from '../../../location/Components';
import Radar from '../../../location/Radar';
import type { Guess, LocationSubmission, MapDefinition, SubmissionPage, Tier } from '../../../location/types';
import type { MergePoint } from '@friberg/location-core';
import { locationAdmin } from './api';

export default function SubmissionManager({ maps, onChanged }: { maps: MapDefinition[]; onChanged: () => Promise<void> }) {
  const { t } = useTranslation(); const confirm = useConfirm();
  const [page, setPage] = useState(1); const [revision, setRevision] = useState(0);
  const [data, setData] = useState<SubmissionPage | null>(null); const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<LocationSubmission | null>(null);
  const [pin, setPin] = useState<Guess | null>(null); const [tier, setTier] = useState<Tier | ''>('');
  const [verified, setVerified] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [showPoints, setShowPoints] = useState(false);
  const [joinPoint, setJoinPoint] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [points, setPoints] = useState<{ key: string; items: MergePoint[] } | null>(null);
  const [pointsLoading, setPointsLoading] = useState(false);
  const [pointsError, setPointsError] = useState('');
  const [pointsRevision, setPointsRevision] = useState(0);
  const reviewLock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const map = maps.find(m => m.id === pin?.mapId);
  const pointsKey = JSON.stringify([selected?.id, map?.id, map?.version, pin?.floorId]);
  const needsPoints = !!selected && (showPoints || joinPoint);
  const candidates = points?.key === pointsKey ? points.items : [];
  const target = candidates.find(p => p.capturePointId === targetId && p.eligible);
  const answer = joinPoint ? target || null : pin;
  useEffect(() => {
    if (!needsPoints || !map || !pin) return;
    const controller = new AbortController();
    setPointsLoading(true); setPointsError(''); setTargetId(''); setVerified(false); setPoints(null);
    void locationAdmin.submissionPoints(map.id, pin.floorId, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (data.mapVersion !== map.version) throw new Error('LOCATION_CAPTURE_MAP_CHANGED');
      setPoints({ key: pointsKey, items: data.items });
    }).catch(e => { if (!controller.signal.aborted) setPointsError(message(e)); })
      .finally(() => { if (!controller.signal.aborted) setPointsLoading(false); });
    return () => controller.abort();
  }, [needsPoints, pointsKey, pointsRevision]);
  const choosePoint = (id: string) => {
    if (busy || !joinPoint || !candidates.some(p => p.capturePointId === id && p.eligible)) return;
    setTargetId(id); setVerified(false);
  };
  useEffect(() => {
    let current = true; setLoading(true); setError('');
    void api.get<SubmissionPage>('/admin/location/submissions', { params: { page } }).then(({ data }) => {
      if (!current) return;
      if (!data.items.length && page > 1) { setPage(n => n - 1); return; }
      setData(data);
    }).catch(e => current && setError(message(e))).finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [page, revision]);
  const open = (item: LocationSubmission) => { setSelected(item); setPin({ mapId: item.mapId, floorId: item.floorId, u: item.u, v: item.v }); setTier(''); setVerified(false); setNotice(''); setError(''); setJoinPoint(false); setTargetId(''); };
  const review = async (decision: 'approve' | 'reject') => {
    if (!selected || busy || reviewLock.current || (decision === 'approve' && (!answer || (joinPoint && (pointsLoading || !!pointsError))))) return;
    if (decision === 'reject' && !await confirm({ title: t('location.submissionReject'), message: t('location.submissionRejectConfirm'), confirmLabel: t('location.submissionReject'), tone: 'danger' })) return;
    if (!alive.current) return;
    if (reviewLock.current) return;
    reviewLock.current = true;
    setBusy(true); setError('');
    try {
      await api.post(`/admin/location/submissions/${selected.id}/review`, decision === 'reject' ? { decision } : {
        decision, mapId: answer!.mapId, floorId: answer!.floorId, u: answer!.u, v: answer!.v,
        tier, mapVersion: map?.version, verified,
        ...(joinPoint && target ? { existingPoint: { capturePointId: target.capturePointId, fingerprint: target.fingerprint } } : {}),
      });
      if (!alive.current) return;
      setSelected(null); setRevision(n => n + 1); setNotice(t(decision === 'approve' ? 'location.submissionApproved' : 'location.submissionRejected'));
      await onChanged();
    } catch (e) {
      if (alive.current) {
        setError(message(e));
        if (joinPoint) { setTargetId(''); setVerified(false); setPointsRevision(n => n + 1); }
        if ((e as { response?: { data?: { code?: string } } }).response?.data?.code === 'LOCATION_CAPTURE_MAP_CHANGED') {
          setVerified(false);
          await onChanged().catch(() => undefined);
        }
      }
    }
    finally { reviewLock.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="submission-review"><h3>{t('location.submissions')}</h3><p className="muted">{t('location.submissionAdminHelp')}</p>
    <button className="btn btn-ghost btn-sm" disabled={busy || loading} onClick={() => setRevision(n => n + 1)}>{t('location.submissionRefresh')}</button>
    {error && <div className="location-alert" role="alert">{error}<button className="btn btn-ghost" disabled={busy} onClick={() => setRevision(n => n + 1)}>{t('location.retry')}</button></div>}
    {notice && <p role="status">{notice}</p>}
    {selected ? <div className="submission-review-editor">
      <header><h4>{selected.submitterName}</h4><p>{new Date(selected.createdAt).toLocaleString()}</p><p>{selected.note}</p></header>
      <fieldset disabled={busy} className="submission-fields"><div className="submission-review-images"><Photo url={selected.imageUrl} />
        <div><div className="submission-selects"><label>{t('location.mapName')}<select className="input" value={pin?.mapId || ''} onChange={e => {
          const next = maps.find(m => m.id === e.target.value); if (next) { setPin({ mapId: next.id, floorId: next.floors[0].id, u: .5, v: .5 }); setTargetId(''); setVerified(false); }
        }}>{maps.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label>{t('location.submissionFloor')}<select className="input" value={pin?.floorId || ''} onChange={e => { if (pin) setPin({ ...pin, floorId: e.target.value }); setTargetId(''); setVerified(false); }}>{map?.floors.map(f => <option key={f.id} value={f.id}>{t(`location.floor.${f.id}`, { defaultValue: f.name })}</option>)}</select></label></div>
          <div className="submission-existing-controls">
            <label><input type="checkbox" checked={showPoints} onChange={e => setShowPoints(e.target.checked)} />{t('location.submissionShowPoints')}</label>
            <label><input type="checkbox" checked={joinPoint} onChange={e => {
              setJoinPoint(e.target.checked); setTargetId(''); setVerified(false); if (e.target.checked) setShowPoints(true);
            }} />{t('location.submissionJoinPoint')}</label>
            <p className="muted">{t(joinPoint ? 'location.submissionJoinHelp' : 'location.submissionShowHelp')}</p>
            {needsPoints && <button type="button" className="btn btn-ghost btn-sm" disabled={pointsLoading} onClick={() => { setTargetId(''); setVerified(false); setPointsRevision(n => n + 1); }}>{t('location.mergeReload')}</button>}
            {needsPoints && pointsLoading && <p role="status">{t('location.loadingAdmin')}</p>}
            {needsPoints && pointsError && <p role="alert">{pointsError}</p>}
            {needsPoints && !pointsLoading && !pointsError && !candidates.length && <p>{t('location.submissionNoPoints')}</p>}
            {joinPoint && <label>{t('location.submissionTargetPoint')}<select className="input" value={target?.capturePointId || ''} disabled={pointsLoading || !!pointsError} onChange={e => { setTargetId(e.target.value); setVerified(false); }}>
              <option value="">{t('location.submissionChoosePoint')}</option>
              {candidates.map((p, i) => <option key={p.capturePointId} value={p.capturePointId} disabled={!p.eligible}>#{i + 1} · {p.capturePointId} · {t('location.samePointQuestions', { count: p.questions })}{p.eligible ? '' : ` · ${t('location.captureMapChanged')}`}</option>)}
            </select></label>}
          </div>
          {map && <Radar map={map} floorId={pin?.floorId || ''} guess={answer}
            guessLabel={joinPoint ? t('location.submissionTargetPoint') : undefined}
            markers={showPoints ? candidates.map((p, i) => ({ ...p, id: p.capturePointId, label: String(i + 1),
              ariaLabel: t('location.submissionExistingMarker', { number: i + 1, id: p.capturePointId }), selected: joinPoint && targetId === p.capturePointId,
              color: p.eligible ? undefined : '#888', title: p.capturePointId })) : []}
            onMarkerSelect={!busy && joinPoint ? choosePoint : undefined}
            onChange={busy || joinPoint ? undefined : value => { setPin(value); setVerified(false); }}
            hint={t(joinPoint ? 'location.submissionJoinHelp' : 'location.submissionPinHelp')} />}
          {joinPoint && target && <div className="submission-existing-target" role="status">
            <strong>{t('location.submissionJoinedPoint', { id: target.capturePointId })}</strong>
            <span> u={target.u.toFixed(4)} · v={target.v.toFixed(4)}</span>
            <div className="location-merge-thumbnails">{target.thumbnails.map((url, i) => <Photo key={`${url}:${i}`} url={url} />)}</div>
          </div>}
        </div></div>
        <p className="submission-pin-warning">{t('location.submissionRule3')}</p>
        {map && (selected.mapVersion !== map.version || selected.mapId !== map.id) && <p role="status">{t('location.submissionMapChanged')}</p>}
        <label>{t('location.submissionTier')}<select className="input" value={tier} onChange={e => setTier(e.target.value as Tier | '')}><option value="">{t('location.captureChooseTier')}</option>{(['easy', 'medium', 'hard'] as const).map(value => <option key={value} value={value}>{t(`location.${value}`)}</option>)}</select></label>
        <label className="submission-verification"><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />{t('location.submissionVerify')}</label>
        <div className="submission-actions"><button className="btn" disabled={!map?.enabled || !tier || !verified || !answer || (joinPoint && (pointsLoading || !!pointsError))} onClick={() => void review('approve')}>{t('location.submissionApprove')}</button><button className="btn btn-danger" onClick={() => void review('reject')}>{t('location.submissionReject')}</button><button className="btn btn-ghost" onClick={() => setSelected(null)}>{t('location.submissionBack')}</button></div>
      </fieldset>
    </div> : <>
      {loading ? <p role="status">{t('common.loading')}</p> : !data?.items.length ? <p>{t('location.submissionEmpty')}</p> : <div className="submission-queue">{data.items.map(item => <article className="card" key={item.id}>
        <img src={item.thumbnailUrl} alt={t('location.submissionPending')} /><strong>{item.submitterName}</strong><span>{maps.find(m => m.id === item.mapId)?.name || item.mapId} · {item.floorId}</span><p>{item.note}</p><button className="btn" onClick={() => open(item)}>{t('location.submissionReview')}</button>
      </article>)}</div>}
      <div className="submission-pagination"><button className="btn btn-ghost" disabled={page === 1 || loading} onClick={() => setPage(n => n - 1)}>{t('common.previousPage')}</button><span>{page} · {data?.total ?? 0}</span><button className="btn btn-ghost" disabled={!data || page * data.pageSize >= data.total || loading} onClick={() => setPage(n => n + 1)}>{t('common.nextPage')}</button></div>
    </>}
  </section>;
}
