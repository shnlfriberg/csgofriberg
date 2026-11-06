import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { locationAdmin } from './location/api';
import { Download, FolderPlus, Image as ImageIcon, ImageOff, ImagePlus, Images, MapPin, PencilLine, Save, Trash2 } from 'lucide-react';
import type { CaptureDraft, MapDefinition, Question } from '../../location/types';
import { captureImages } from '@friberg/location-core';
import Radar from '../../location/Radar';
import CaptureImagePreview from './location/CaptureImagePreview';
import { useBatchCapture } from './location/useBatchCapture';
import { batchColors } from './location/batchColors';

/**
 * Images of a point that were already turned into questions. Once a capture image becomes a
 * question it leaves the capture draft, so a "complete" point has no draft images of its own.
 */
function PointQuestionImages({ mapId, capturePointId, revision }: { mapId: string; capturePointId: string; revision: number }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Question[] | null>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    setActive(0);
    void locationAdmin.questions({ mapId, search: capturePointId, page: 1, pageSize: 12 }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems((page?.items || []).filter((item) => item.mapId === mapId && item.capturePointId === capturePointId));
      })
      .catch(() => { if (!controller.signal.aborted) setItems([]); });
    return () => controller.abort();
  }, [mapId, capturePointId, revision]);
  if (items === null) return <div className="location-capture-noimage"><span>{t('location.loadingAdmin')}</span></div>;
  if (!items.length) return <div className="location-capture-noimage"><ImageOff size={24} aria-hidden="true" /><span>{t('adminUi.captureNoImage')}</span></div>;
  const shown = items[Math.min(active, items.length - 1)];
  return (
    <div className="location-capture-question-images">
      <a href={shown.imageUrl} target="_blank" rel="noreferrer" title={t('adminUi.captureOpenImage')}>
        <img src={shown.imageUrl || shown.thumbnailUrl} alt={shown.capturePointId} />
      </a>
      <span className="location-capture-question-note">
        {t('adminUi.captureMovedToQuestions', { count: items.length })} · {t(`location.${shown.tier}`)} · {t(shown.status === 'review' ? 'location.reviewStatus' : `location.${shown.status}`)}
      </span>
      {items.length > 1 && (
        <div className="location-capture-gallery" aria-label={t('adminUi.captureQuestionImages')}>
          {items.map((item, index) => (
            <div key={item.id}>
              <button type="button" className={index === active ? 'selected' : ''} aria-pressed={index === active}
                aria-label={t('adminUi.captureQuestionImage', { number: index + 1 })} onClick={() => setActive(index)}>
                <img src={item.thumbnailUrl} alt="" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
  const current = selected || selectedLocal;
  const currentPoint = current ? points.find((point) => point.id === current.id) : undefined;
  const previewUrl = activeImage ? activeImage.asset.url || activeImage.asset.thumbnailUrl : '';
  return (
    <section
      className="location-batch-capture"
      aria-label={t('location.batchCapture')}
    >
      <header className="location-capture-head">
        <h3>{t('location.batchCapture')}</h3>
        <p>{t('location.captureWorkflow')}</p>
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
      {notice && <p role="status" className="location-capture-notice">{notice}</p>}
      <div className="location-capture-toolbar">
        <div className="location-batch-controls">
          <label>
            <span>{t('location.mapName')}</span>
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
            <span>{t('location.chooseFloor')}</span>
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
            <span>{t('location.captureBatchFilter')}</span>
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
        <div className="location-capture-tools">
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy || (!visible.length && !local.length)}
            onClick={exportPlan}
          >
            <Download size={15} aria-hidden="true" />{t('location.captureExport')}
          </button>
          <label className="btn btn-ghost btn-sm">
            <Images size={15} aria-hidden="true" />{t('location.captureBatchImages')}
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
      </div>
      <div className={`location-capture-marking${marking ? ' is-active' : ''}`}>
        <label className="location-capture-batch-name">
          <span>{t('location.captureBatchName')}</span>
          <input
            className="input"
            value={batchName}
            maxLength={100}
            disabled={busy}
            onChange={(e) => setBatchName(e.target.value)}
          />
        </label>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={newBatch}>
          <FolderPlus size={15} aria-hidden="true" />{t('location.newCaptureBatch')}
        </button>
        <button
          className={`btn btn-sm ${marking ? '' : 'btn-ghost'}`}
          aria-pressed={marking}
          disabled={busy}
          onClick={() => {
            setMarking((value) => !value);
            setBatchFilter('');
          }}
        >
          <MapPin size={15} aria-hidden="true" />{t('location.captureMarking')}
        </button>
        <button
          className="btn btn-sm"
          disabled={busy || !pending.length}
          onClick={() => void savePoints()}
        >
          <Save size={15} aria-hidden="true" />{t('location.captureSavePoints', { count: pending.length })}
        </button>
        <p className="location-capture-hint">
          {t(marking ? 'location.captureMarkHelp' : 'location.captureSelectHelp')}
        </p>
      </div>
      <div className="location-batch-layout" ref={mapPanel}>
        <div className="location-batch-map">
          <div className="location-capture-legends">
            <div className="location-batch-legend" role="group" aria-label={t('location.captureBatchLegend')}>
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
        <aside className="location-batch-side">
          <section className="location-batch-selection" aria-label={t('adminUi.capturePointDetail')} aria-live="polite">
            {!current ? (
              <div className="location-capture-placeholder">
                <ImageIcon size={28} aria-hidden="true" />
                <p>{t('adminUi.capturePickHint')}</p>
              </div>
            ) : (
              <>
                <header className="location-capture-detail-head">
                  <div>
                    <strong>#{currentPoint?.order ?? current.order} · {current.capturePointId}</strong>
                    <span className="location-batch-point-batch">
                      <i className="location-batch-swatch" style={{ background: currentPoint?.color }} aria-hidden="true" />
                      {current.batchName} · {current.batchId.slice(0, 8)}
                    </span>
                  </div>
                  {currentPoint && (
                    <span className={`location-capture-state capture-${currentPoint.captureStatus}`}>{currentPoint.statusLabel}</span>
                  )}
                </header>
                <div className="location-capture-preview">
                  {selectedImage ? (
                    <CaptureImagePreview url={selectedImage.preview} alt={current.capturePointId} />
                  ) : previewUrl ? (
                    <a href={previewUrl} target="_blank" rel="noreferrer" title={t('adminUi.captureOpenImage')}>
                      <img src={previewUrl} alt={selected?.capturePointId || ''} />
                    </a>
                  ) : selected && currentPoint && currentPoint.questionCount > 0 ? (
                    <PointQuestionImages mapId={selected.mapId} capturePointId={selected.capturePointId} revision={revision} />
                  ) : (
                    <div className="location-capture-noimage">
                      <ImageOff size={24} aria-hidden="true" />
                      <span>{t('adminUi.captureNoImage')}</span>
                    </div>
                  )}
                </div>
                {selectedImage && (
                  <small className="location-capture-meta">
                    {t('location.captureUnsaved')} · {selectedImage.file.name}
                  </small>
                )}
                {currentPoint && (
                  <small className="location-capture-meta">
                    {t('location.captureImageCount', { count: currentPoint.imageCount })}
                    {' · '}{t('location.captureQuestionCount', { count: currentPoint.questionCount })}
                    {' · '}u {current.u.toFixed(4)} · v {current.v.toFixed(4)}
                    {currentPoint.pending && ` · ${t('location.captureUnsaved')}`}
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
                            <button type="button" className="admin-action is-danger" disabled={busy}
                              onClick={() => void removeImage(image.id)}>{t('location.captureRemoveImage')}</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {selected.mapVersion !==
                      maps.find((m) => m.id === selected.mapId)?.version && (
                      <p className="location-rules-note">
                        {t('location.captureMapChanged')}
                      </p>
                    )}
                    <div className="location-capture-detail-actions">
                      <button
                        className="btn btn-sm"
                        disabled={busy || !activeImage}
                        onClick={() => activeImage && onEdit(selected, activeImage.id)}
                      >
                        <PencilLine size={15} aria-hidden="true" />{t('location.captureComplete')}
                      </button>
                      <label className="btn btn-ghost btn-sm">
                        <ImagePlus size={15} aria-hidden="true" />{t('location.captureAddImages')}
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
                    </div>
                    <p className="location-capture-meta">{t('location.captureSharedPointHelp')}</p>
                  </>
                )}
                <button
                  className="admin-action is-danger location-capture-remove"
                  disabled={busy}
                  onClick={() => void removeSelected()}
                >
                  <Trash2 size={14} aria-hidden="true" />{t('location.captureRemove')}
                </button>
              </>
            )}
          </section>
          <section className="location-batch-points">
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
                  aria-pressed={selectedId === p.id}
                  onClick={() => selectPoint(p.id)}
                >
                  <i className={`location-capture-status-key capture-${p.captureStatus}`} aria-hidden="true" />
                  <strong>#{p.order} · {p.capturePointId}</strong>
                  <span>
                    {p.statusLabel}
                    {' · '}{t('location.captureImageCount', { count: p.imageCount })}
                    {p.pending && ` · ${t('location.captureUnsaved')}`}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>
      {!!images.length && (
        <section className="location-batch-images">
          <h4>{t('location.captureConfirmImages')}</h4>
          <p className="muted">{t('location.captureMatchHelp')}</p>
          <p className="muted">{t('location.cropImageHelp')}</p>
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
