import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPin, UploadCloud } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import CaptureImagePreview from '../components/admin/location/CaptureImagePreview';
import Radar from '../location/Radar';
import { api, message } from '../location/api';
import { useSubmissionBatch } from '../location/useSubmissionBatch';
import type { MapDefinition, SubmissionPage } from '../location/types';
import '../styles/location.css';

export default function LocationSubmission() {
  const { t } = useTranslation();
  const [maps, setMaps] = useState<MapDefinition[]>([]);
  const [mapId, setMapId] = useState('');
  const [floorId, setFloorId] = useState('');
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [mapsRevision, setMapsRevision] = useState(0);
  const [pending, setPending] = useState<SubmissionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [mapsLoading, setMapsLoading] = useState(true);
  const batch = useSubmissionBatch(() => { setPage(1); setRevision(value => value + 1); });
  const map = maps.find(item => item.id === mapId);
  useEffect(() => {
    if (map && !map.floors.some(floor => floor.id === floorId && floor.radarUrl)) {
      setFloorId(map.floors.find(floor => floor.radarUrl)?.id || '');
    }
  }, [map, floorId]);
  const visiblePoints = batch.points.filter(point => point.mapId === mapId && point.floorId === floorId);
  const selected = visiblePoints.find(point => point.id === batch.selectedId);
  const selectedImage = batch.selectedImage;
  const file = selectedImage?.file;
  const pointLabel = (id: string) => {
    const point = batch.points.find(item => item.id === id);
    return point ? '#' + point.order + ' · ' + (maps.find(item => item.id === point.mapId)?.name || point.mapId) + ' · ' + t('location.floor.' + point.floorId, { defaultValue: point.floorId }) : t('location.submissionAssignPoint');
  };
  useEffect(() => {
    let alive = true; setMapsLoading(true);
    void api.get<MapDefinition[]>('/location/maps').then(({ data }) => {
      if (!alive) return;
      const available = data.filter(item => item.enabled && item.floors.some(f => f.radarUrl));
      setMaps(available);
      setMapId(previous => available.some(item => item.id === previous) ? previous : available[0]?.id || '');
      setFloorId(previous => previous || available[0]?.floors.find(f => f.radarUrl)?.id || '');
    }).catch(e => alive && setError(message(e))).finally(() => alive && setMapsLoading(false));
    return () => { alive = false; };
  }, [mapsRevision]);
  useEffect(() => {
    let alive = true; setLoading(true);
    void api.get<SubmissionPage>('/location/submissions', { params: { page } })
      .then(({ data }) => { if (alive) setPending(data); })
      .catch(e => alive && setError(message(e))).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [page, revision]);
  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const inspect = (id: string) => {
    batch.setImageId(id);
    const row = batch.images.find(item => item.id === id);
    const point = batch.points.find(item => item.id === row?.pointId);
    if (point) { setMapId(point.mapId); setFloorId(point.floorId); batch.selectPoint(point.id); }
  };
  const changeView = (nextMap: string, nextFloor: string) => {
    setMapId(nextMap); setFloorId(nextFloor);
    batch.setSelectedId(''); batch.setMarking(true);
  };
  const assignImage = (id: string, pointId: string) => {
    batch.updateImage(id, { pointId });
    const point = batch.points.find(item => item.id === pointId);
    if (point) { setMapId(point.mapId); setFloorId(point.floorId); batch.selectPoint(point.id); }
  };
  return <Page title={t('location.submissionTitle')} icon={<UploadCloud size={17} />} className="location-page location-submission-page"
    actions={<Link className="btn btn-ghost btn-sm" to="/entertainment/location">{t('location.title')}</Link>}>
    <header className="submission-heading"><h1>{t('location.submissionTitle')}</h1><p>{t('location.submissionIntro')}</p></header>
    <div className="submission-layout">
      <div className="submission-editor">
        <section className="card submission-workflow"><h2>{t('location.submissionBatchTitle')}</h2>
          <ol>{[1, 2, 3].map(step => <li key={step}>{t('location.submissionStep' + step)}</li>)}</ol>
          <p className="muted">{t('location.submissionBatchLimits')}</p>
          <p className="muted">{t('location.submissionDraftHelp')}</p>
        </section>
        {(error || batch.error) && <div className="location-alert" role="alert">{error || batch.error}</div>}
        {batch.notice && <p className="location-alert" role="status">{batch.notice}</p>}
        <form onSubmit={event => { event.preventDefault(); void batch.submit(); }}>
          <fieldset className="submission-fields" disabled={batch.busy}>
            <section className="card submission-position-panel"><h2><MapPin size={19} />{t('location.submissionPosition')}</h2>
              <div className="submission-selects"><label>{t('location.mapName')}<select className="input" value={mapId} onChange={e => {
                changeView(e.target.value, maps.find(m => m.id === e.target.value)?.floors.find(f => f.radarUrl)?.id || '');
              }}>{maps.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
                <label>{t('location.submissionFloor')}<select className="input" value={floorId} onChange={e => changeView(mapId, e.target.value)}>
                  {map?.floors.filter(f => f.radarUrl).map(f => <option key={f.id} value={f.id}>{t('location.floor.' + f.id, { defaultValue: f.name })}</option>)}
                </select></label></div>
              <p className="submission-pin-warning">{t('location.submissionRule3')}</p>
              <div className="submission-point-tools">
                <button type="button" className={'btn ' + (batch.marking ? '' : 'btn-ghost')} aria-pressed={batch.marking} onClick={() => batch.setMarking(true)}>{t('location.captureMarking')}</button>
                <button type="button" className={'btn ' + (!batch.marking ? '' : 'btn-ghost')} aria-pressed={!batch.marking} disabled={!selected || batch.pointLocked(selected.id)} onClick={() => batch.setMarking(false)}>{t('location.submissionMovePoint')}</button>
                <button type="button" className="btn btn-ghost" disabled={!selected || batch.images.some(row => row.pointId === selected.id)} onClick={batch.removePoint}>{t('location.submissionRemovePoint')}</button>
                <button type="button" className="btn btn-ghost" onClick={() => { setError(''); setMapsRevision(n => n + 1); }}>{t('location.submissionReloadMaps')}</button>
              </div>
              <p className="muted">{t('location.submissionMarkHelp')}</p>
              {map ? <Radar map={map} floorId={floorId}
                guess={!batch.marking ? selected : null}
                markers={visiblePoints.map(point => ({ ...point, label: String(point.order), selected: point.id === selected?.id,
                  title: pointLabel(point.id), ariaLabel: t('location.submissionPointNumber', { number: point.order }) }))}
                onMarkerSelect={batch.busy ? undefined : batch.selectPoint}
                onChange={batch.busy || (!batch.marking && (!selected || batch.pointLocked(selected.id))) ? undefined : value => batch.place(value, map)}
                hint={t(batch.marking ? 'location.submissionMarkHelp' : 'location.submissionMoveHelp')} /> : <p>{t(mapsLoading ? 'common.loading' : 'location.submissionNoMaps')}</p>}
              <div className="submission-point-list" aria-label={t('location.submissionPointList')}>
                {visiblePoints.map(point => <button type="button" key={point.id} className={'btn btn-sm ' + (selected?.id === point.id ? '' : 'btn-ghost')}
                  aria-pressed={selected?.id === point.id} onClick={() => batch.selectPoint(point.id)}>
                  {t('location.submissionPointImages', { number: point.order, count: batch.images.filter(row => row.pointId === point.id).length })}
                </button>)}
              </div>
              {selected && <p role="status">{t('location.submissionSelectedPoint', { number: selected.order })}</p>}
              {selected && selected.mapVersion !== map?.version && <p className="location-alert">{t('location.submissionStalePoint')}</p>}
            </section>
            <section className="card"><h2>{t('location.submissionImage')}</h2>
              <label className="submission-upload" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); batch.queue(Array.from(e.dataTransfer.files)); }}>
                <UploadCloud size={25} /><span>{t('location.submissionChooseImage')}</span>
                <input aria-label={t('location.submissionChooseImage')} type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={e => { batch.queue(Array.from(e.target.files || [])); e.target.value = ''; }} />
              </label>
              <p className="muted">{t('location.submissionManyImagesHelp')}</p>
              <p className="muted">{t('location.submissionCropHelp')}</p>
              <div className="submission-image-list" aria-label={t('location.submissionQueue')}>
                {batch.images.map(row => <article key={row.id} className={row.id === batch.imageId ? 'is-selected' : ''}>
                  <button type="button" className="btn btn-ghost submission-image-name" aria-pressed={row.id === batch.imageId} onClick={() => inspect(row.id)}>{row.name}</button>
                  <span>{pointLabel(row.pointId)}</span><span>{t('location.submissionStatus_' + row.status)}</span>
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={t('location.submissionRemoveImage', { name: row.name })} onClick={() => batch.removeImage(row.id)}>{t('location.submissionRemoveFromQueue')}</button>
                  {row.error && <p className="location-alert" role="alert">{row.error}</p>}
                </article>)}
              </div>
              {selectedImage && <div className="submission-image-detail">
                <h3>{selectedImage.name}</h3>
                <label>{t('location.submissionImagePoint')}<select className="input" value={selectedImage.pointId}
                  disabled={!selectedImage.file || selectedImage.locked} onChange={e => assignImage(selectedImage.id, e.target.value)}>
                  <option value="">{t('location.submissionAssignPoint')}</option>
                  {batch.points.map(point => <option key={point.id} value={point.id}>{pointLabel(point.id)}</option>)}
                </select></label>
                {preview && <div className="submission-preview"><CaptureImagePreview key={preview} url={preview} alt={t('location.submissionCropPreview')} /></div>}
                <label className="submission-note">{t('location.submissionNote')}<textarea className="input" maxLength={500} rows={2}
                  disabled={!selectedImage.file || selectedImage.locked} value={selectedImage.note} onChange={e => batch.updateImage(selectedImage.id, { note: e.target.value })} /></label>
                {selectedImage.locked && <p className="muted">{t('location.submissionRetryLocked')}</p>}
              </div>}
            </section>
            <p className="muted">{t('location.submissionReviewHelp')}</p>
            <p>{t('location.submissionQueueSummary', { points: batch.points.length, count: batch.remaining })}</p>
            {batch.busy && <p role="status">{t('location.submissionBatchProgress', batch.progress)}</p>}
            <button className="btn" type="submit" disabled={!batch.canSubmit || batch.busy || !maps.length}>{t('location.submissionSubmit')}</button>
          </fieldset>
        </form>
        <section className="card submission-pending"><h2>{t('location.submissionMine')}</h2>
          <p className="muted">{t('location.submissionTrackingHelp')}</p>
          {loading ? <p role="status">{t('common.loading')}</p> : !pending?.items.length ? <p>{t('location.submissionEmpty')}</p> : pending.items.map(item => <article key={item.id}>
            <img src={item.thumbnailUrl} alt={t('location.submissionPending')} /><div><strong>{maps.find(m => m.id === item.mapId)?.name || item.mapId}</strong><p>{t('location.submissionPending')} · {new Date(item.createdAt).toLocaleString()}</p></div>
          </article>)}
          {pending && pending.total > pending.pageSize && <div className="submission-pagination"><button className="btn btn-ghost" disabled={page === 1 || loading} onClick={() => setPage(n => n - 1)}>{t('common.previousPage')}</button><span>{page}</span><button className="btn btn-ghost" disabled={page * pending.pageSize >= pending.total || loading} onClick={() => setPage(n => n + 1)}>{t('common.nextPage')}</button></div>}
          <Link to="/stats?variant=location">{t('location.submissionStatsLink')}</Link>
          <span aria-hidden="true"> · </span><Link to="/leaderboard?mode=location-contributions">{t('location.contributorBoard')}</Link>
        </section>
      </div>
      <aside className="card submission-guidelines" tabIndex={0} aria-label={t('location.submissionRules')}><h2>{t('location.submissionRules')}</h2><ol>{[1, 2, 3, 4, 5, 6, 7].map(n => <li key={n}>{t('location.submissionRule' + n)}</li>)}</ol></aside>
    </div>
  </Page>;
}

