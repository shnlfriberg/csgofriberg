import type { CSSProperties } from 'react';
import type { CaptureDraft, MapDefinition, Question } from '../../location/types';
import { captureImages } from '@friberg/location-core';
import Radar from '../../location/Radar';
import CaptureImagePreview from './location/CaptureImagePreview';
import { useBatchCapture } from './location/useBatchCapture';
import { batchColors } from './location/batchColors';

export default function LocationBatchCapture({
  maps,
  onEdit,
  revision = 0,
  questions = [],
  questionPoints,
  active = true,
}: {
  maps: MapDefinition[];
  onEdit: (draft: CaptureDraft, imageId: string) => void;
  revision?: number;
  questions?: Question[];
  questionPoints?: Array<{ mapId: string; capturePointId: string; count: number }>;
  active?: boolean;
}) {
  const {
    t,
    drafts,
    pending,
    batchName,
    setBatchName,
    mapId,
    setMapId,
    map,
    floorId,
    setFloorId,
    batchFilter,
    setBatchFilter,
    marking,
    setMarking,
    selectedId,
    setSelectedId,
    images,
    setImages,
    mapPanel,
    busy,
    error,
    notice,
    run,
    load,
    visible,
    local,
    selected,
    selectedLocal,
    selectedImage,
    batches,
    selectPoint,
    addPoint,
    savePoints,
    queueFiles,
    saveImages,
    exportPlan,
    selectedImageId,
    setSelectedImageId,
    removeImage,
    removeSelected,
    newBatch,
  } = useBatchCapture(maps, revision, active);
  const pointImages = selected ? captureImages(selected) : [];
  const activeImage = pointImages.find((image) => image.id === selectedImageId) || pointImages[0];
  const colors = batchColors(batches.map(([id]) => id));
  const statusLabels = {
    empty: t('location.captureEmptyPoint'),
    'awaiting-question': t('location.capturePendingPoint'),
    complete: t('location.captureCompletedPoint'),
  };
  const unsavedIds = new Set(pending.map((point) => point.id));
  const savedPoints = new Map(drafts.map((point) => [point.id, point]));
  const questionCounts = new Map<string, number>();
  for (const question of questions) {
    if (question.mapId !== mapId) continue;
    questionCounts.set(question.capturePointId, (questionCounts.get(question.capturePointId) || 0) + 1);
  }
  for (const point of questionPoints || []) if (point.mapId === mapId) questionCounts.set(point.capturePointId, point.count);
  const points = [...visible, ...local].map((point) => {
    const saved = savedPoints.get(point.id);
    const imageCount = saved ? captureImages(saved).length : 0;
    const questionCount = questionCounts.get(point.capturePointId) || 0;
    const captureStatus = imageCount > 0 ? 'awaiting-question' as const
      : questionCount > 0 ? 'complete' as const : 'empty' as const;
    const statusLabel = statusLabels[captureStatus];
    return {
      ...point,
      label: String(point.order),
      color: colors.get(point.batchId),
      selected: point.id === selectedId,
      pending: unsavedIds.has(point.id),
      imageCount,
      questionCount,
      captureStatus,
      statusLabel,
      title: `${point.batchName} · ${point.batchId.slice(0, 8)} · #${point.order} · ${point.capturePointId} · ${statusLabel}`,
    };
  });
  const filterBatch = (id: string) => {
    setBatchFilter(id);
    setSelectedId('');
    if (id) setMarking(false);
  };
  return (
    <section
      className="location-batch-capture"
      aria-label={t('location.batchCapture')}
    >
      <header>
        <h3>{t('location.batchCapture')}</h3>
        <p className="muted">{t('location.captureWorkflow')}</p>
        <p className="muted">{t('location.cropImageHelp')}</p>
      </header>
      {error && (
        <div className="location-alert" role="alert">
          {error}
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => void run(load)}
          >
            {t('location.retry')}
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="location-batch-controls">
        <label>
          {t('location.mapName')}
          <select
            className="input"
            value={mapId}
            disabled={busy}
            onChange={(e) => {
              const next = maps.find((m) => m.id === e.target.value)!;
              setMapId(next.id);
              setBatchFilter('');
              setFloorId(next.floors[0].id);
              setSelectedId('');
            }}
          >
            {maps.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('location.chooseFloor')}
          <select
            className="input"
            value={floorId}
            disabled={busy}
            onChange={(e) => {
              setFloorId(e.target.value);
              setSelectedId('');
            }}
          >
            {map?.floors.map((f) => (
              <option key={f.id} value={f.id}>
                {t(`location.floor.${f.id}`, { defaultValue: f.name })}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('location.captureBatchName')}
          <input
            className="input"
            value={batchName}
            maxLength={100}
            disabled={busy}
            onChange={(e) => setBatchName(e.target.value)}
          />
        </label>
        <label>
          {t('location.captureBatchFilter')}
          <select
            className="input"
            value={batchFilter}
            disabled={busy}
            onChange={(e) => filterBatch(e.target.value)}
          >
            <option value="">{t('location.captureAllBatches')}</option>
            {batches.map(([id, name]) => (
              <option key={id} value={id}>
                {name} · {id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="location-admin-actions">
        <button className="btn btn-ghost" disabled={busy} onClick={newBatch}>
          {t('location.newCaptureBatch')}
        </button>
        <button
          className={`btn ${marking ? '' : 'btn-ghost'}`}
          aria-pressed={marking}
          disabled={busy}
          onClick={() => {
            setMarking((value) => !value);
            setBatchFilter('');
          }}
        >
          {t('location.captureMarking')}
        </button>
        <button
          className="btn"
          disabled={busy || !pending.length}
          onClick={() => void savePoints()}
        >
          {t('location.captureSavePoints', { count: pending.length })}
        </button>
        <button
          className="btn btn-ghost"
          disabled={busy || (!visible.length && !local.length)}
          onClick={exportPlan}
        >
          {t('location.captureExport')}
        </button>
        <label className="btn btn-ghost">
          {t('location.captureBatchImages')}
          <input
            type="file"
            hidden
            multiple
            accept="image/png,image/jpeg,image/webp"
            aria-label={t('location.captureBatchImages')}
            disabled={busy || !drafts.length}
            onChange={(e) => {
              queueFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      <p className="muted">
        {t(marking ? 'location.captureMarkHelp' : 'location.captureSelectHelp')}
      </p>
      <div className="location-batch-layout" ref={mapPanel}>
        <div className="location-batch-map">
          <div className="location-batch-legend" role="group" aria-label={t('location.captureBatchLegend')}>
            <strong>{t('location.captureBatchLegend')}</strong>
            <button type="button" disabled={busy} aria-pressed={!batchFilter}
              onClick={() => filterBatch('')}>{t('location.captureAllBatches')}</button>
            {batches.map(([id, name]) => (
              <button type="button" key={id} disabled={busy}
                aria-pressed={batchFilter === id} onClick={() => filterBatch(id)}>
                <i className="location-batch-swatch" style={{ background: colors.get(id) }} aria-hidden="true" />
                {name} · {id.slice(0, 8)}
              </button>
            ))}
          </div>
          <div className="location-capture-status-legend" aria-label={t('location.captureStatusLegend')}>
            {(['empty', 'awaiting-question', 'complete'] as const).map((status) => (
              <span key={status}><i className={`location-capture-status-key capture-${status}`} aria-hidden="true" />{statusLabels[status]}</span>
            ))}
          </div>
          {map && (
            <Radar
              map={map}
              floorId={floorId}
              onChange={marking && !busy ? addPoint : undefined}
              markers={points}
              onMarkerSelect={busy ? undefined : selectPoint}
            />
          )}
        </div>
        <div className="location-batch-points">
          <h4>
            {t('location.capturePointList', {
              count: visible.length + local.length,
            })}
          </h4>
          <div className="location-batch-point-list">
            {points.map((p) => (
              <button
                type="button"
                key={p.id}
                className={`location-batch-point ${selectedId === p.id ? 'selected' : ''}`}
                style={{ '--capture-batch-color': p.color } as CSSProperties}
                title={p.title}
                disabled={busy}
                onClick={() => selectPoint(p.id)}
              >
                <strong>
                  #{p.order} · {p.capturePointId}
                </strong>
                <span className="location-batch-point-batch">
                  <i className="location-batch-swatch" style={{ background: p.color }} aria-hidden="true" />
                  {p.batchName} · {p.batchId.slice(0, 8)}
                </span>
                <span>
                  {p.statusLabel}
                  {' · '}{t('location.captureImageCount', { count: p.imageCount })}
                  {' · '}{t('location.captureQuestionCount', { count: p.questionCount })}
                  {p.pending &&
                    ` · ${t('location.captureUnsaved')}`}
                </span>
                <small>
                  u {p.u.toFixed(4)} · v {p.v.toFixed(4)}
                </small>
              </button>
            ))}
          </div>
          {(selected || selectedLocal) && (
            <div className="location-batch-selection">
              <strong>{(selected || selectedLocal)!.batchName} · {(selected || selectedLocal)!.batchId.slice(0, 8)}</strong>
              <strong>{(selected || selectedLocal)!.capturePointId}</strong>
              {selectedImage ? (
                <CaptureImagePreview
                  url={selectedImage.preview}
                  alt={(selected || selectedLocal)!.capturePointId}
                />
              ) : (
                activeImage && (
                  <img
                    src={activeImage.asset.thumbnailUrl}
                    alt={selected?.capturePointId || ''}
                  />
                )
              )}
              {selectedImage && (
                <small>
                  {t('location.captureUnsaved')} · {selectedImage.file.name}
                </small>
              )}
              {selected && (
                <>
                  {pointImages.length > 0 && (
                    <div className="location-capture-gallery" aria-label={t('location.capturePointImages')}>
                      {pointImages.map((image, index) => (
                        <div key={image.id}>
                          <button type="button" className={activeImage?.id === image.id ? 'selected' : ''}
                            aria-label={t('location.captureSelectImage', { number: index + 1 })}
                            aria-pressed={activeImage?.id === image.id}
                            onClick={() => setSelectedImageId(image.id)} disabled={busy}>
                            <img src={image.asset.thumbnailUrl} alt={t('location.captureSelectImage', { number: index + 1 })} />
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
                            onClick={() => void removeImage(image.id)}>{t('location.captureRemoveImage')}</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="muted">{t('location.captureSharedPointHelp')}</p>
                  {selected.mapVersion !==
                    maps.find((m) => m.id === selected.mapId)?.version && (
                    <p className="location-rules-note">
                      {t('location.captureMapChanged')}
                    </p>
                  )}
                  <label className="btn btn-ghost">
                    {t('location.captureAddImages')}
                    <input
                      type="file"
                      hidden
                      multiple
                      accept="image/png,image/jpeg,image/webp"
                      disabled={busy}
                      aria-label={t('location.captureAddImages')}
                      onChange={(e) => {
                        queueFiles(e.target.files, selected.id);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <button
                    className="btn"
                    disabled={busy || !activeImage}
                    onClick={() => activeImage && onEdit(selected, activeImage.id)}
                  >
                    {t('location.captureComplete')}
                  </button>
                </>
              )}
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void removeSelected()}
              >
                {t('location.captureRemove')}
              </button>
            </div>
          )}
        </div>
      </div>
      {!!images.length && (
        <section className="location-batch-images">
          <h4>{t('location.captureConfirmImages')}</h4>
          <p className="muted">{t('location.captureMatchHelp')}</p>
          <div className="location-admin-actions">
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                const targets = visible.filter((d) => !captureImages(d).length);
                setImages((previous) =>
                  previous.map((row, index) => ({
                    ...row,
                    target: targets[index]?.id || '',
                  }))
                );
              }}
            >
              {t('location.captureAssignOrder')}
            </button>
            <button
              className="btn"
              disabled={
                busy ||
                images.some(
                  (row) =>
                    !row.target || !drafts.some((d) => d.id === row.target)
                )
              }
              onClick={() => void saveImages()}
            >
              {t('location.captureSaveImages')}
            </button>
          </div>
          <div className="location-batch-image-grid">
            {images.map((row) => (
              <article key={row.id}>
                <CaptureImagePreview url={row.preview} alt={row.file.name} />
                <strong>{row.file.name}</strong>
                <label>
                  {t('location.captureImageTarget')}
                  <select
                    className="input"
                    value={row.target}
                    disabled={busy}
                    onChange={(e) =>
                      setImages((previous) =>
                        previous.map((item) =>
                          item.id === row.id
                            ? { ...item, target: e.target.value, error: '' }
                            : item
                        )
                      )
                    }
                  >
                    <option value="">{t('location.captureUnmatched')}</option>
                    {drafts.map((d) => (
                      <option key={d.id} value={d.id}>
                        {maps.find((m) => m.id === d.mapId)?.name} /{' '}
                        {t(`location.floor.${d.floorId}`, {
                          defaultValue: d.floorId,
                        })}{' '}
                        / {d.capturePointId}
                        {d.asset ? ` · ${t('location.replaceImage')}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {row.target && (
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => {
                      const d = drafts.find((item) => item.id === row.target);
                      if (d) {
                        setMapId(d.mapId);
                        setFloorId(d.floorId);
                        setBatchFilter('');
                        selectPoint(d.id);
                        mapPanel.current?.scrollIntoView({
                          block: 'center',
                          behavior: 'smooth',
                        });
                      }
                    }}
                  >
                    {t('location.captureShowPoint')}
                  </button>
                )}
                {row.error && <p role="alert">{row.error}</p>}
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => {
                    URL.revokeObjectURL(row.preview);
                    setImages((previous) =>
                      previous.filter((item) => item.id !== row.id)
                    );
                  }}
                >
                  {t('common.cancel')}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
