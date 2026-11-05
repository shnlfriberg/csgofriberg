import { useRadarGestures, rectangleBetween } from './useRadarGestures';
import { useEffect, useState, type CSSProperties } from 'react';
import { Minus, Plus, RotateCcw, MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Guess, MapDefinition } from './types';

export interface RadarSelection {
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
}

export interface RadarMarker extends Guess {
  id: string;
  label: string;
  ariaLabel?: string;
  selected?: boolean;
  pending?: boolean;
  color?: string;
  title?: string;
  captureStatus?: 'empty' | 'awaiting-question' | 'complete';
}
export default function Radar({
  map,
  floorId,
  guess,
  answer,
  onChange,
  guessLabel,
  markers = [],
  onMarkerSelect,
  hint,
  selection,
  onSelectArea,
}: {
  map: MapDefinition;
  floorId: string;
  guess?: Guess | null;
  answer?: Guess | null;
  onChange?: (guess: Guess) => void;
  guessLabel?: string;
  markers?: RadarMarker[];
  onMarkerSelect?: (id: string) => void;
  hint?: string;
  selection?: RadarSelection | null;
  onSelectArea?: (selection: RadarSelection) => void;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => setFailed(false), [map.id, map.version]);
  const { area, view, viewRef, pointers, down, drawing, preview, setPreview, selecting, pointAt, update, zoom, move, release } = useRadarGestures({ map, floorId, onChange, onSelectArea, failed });
  const pin =
    guess?.mapId === map.id && guess.floorId === floorId ? guess : null;
  const target =
    answer?.mapId === map.id && answer.floorId === floorId ? answer : null;
  const radar = map.floors.find((floor) => floor.id === floorId)?.radarUrl;
  const visibleSelection = preview || selection;
  return (
    <div className="location-radar">
      <div className="location-radar-tools">
        <span>
          <MapPin size={15} />
          {map.name}
        </span>
        <div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={t('location.zoomOut')}
            onClick={() => zoom(1 / 1.35)}
          >
            <Minus size={16} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={t('location.zoomIn')}
            onClick={() => zoom(1.35)}
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={t('location.reset')}
            onClick={() => update({ zoom: 1, x: 0, y: 0 })}
          >
            <RotateCcw size={16} />
          </button>
        </div>
      </div>
      <div
        className="location-radar-area"
        ref={area}
        style={{ aspectRatio: `${map.width}/${map.height}` }}
        role="group"
        tabIndex={0}
        aria-label={t(selecting ? 'location.selectQuestionArea' : 'location.choosePosition')}
        onPointerDown={(e) => {
          if (onSelectArea && e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (onSelectArea) {
            const point = pointAt(e);
            if (pointers.current.size === 1 && point && !failed) {
              drawing.current = { pointerId: e.pointerId, start: point };
              setPreview(rectangleBetween(point, point));
            } else {
              drawing.current = null;
              setPreview(null);
            }
            return;
          }
          if (pointers.current.size > 1) down.current.moved = true;
          else down.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onPointerMove={move}
        onPointerUp={(e) => release(e)}
        onPointerCancel={(e) => release(e, true)}
        onLostPointerCapture={(e) => {
          if (drawing.current?.pointerId === e.pointerId) release(e, true);
        }}
        onKeyDown={(e) => {
          if (selecting && e.key === 'Escape') {
            drawing.current = null;
            pointers.current.clear();
            setPreview(null);
            return;
          }
          if (
            !onChange ||
            !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
          )
            return;
          e.preventDefault();
          const point = pin || { u: 0.5, v: 0.5 };
          const step = e.shiftKey ? 10 : 1;
          onChange({
            mapId: map.id,
            floorId,
            u: Math.max(
              0,
              Math.min(
                1,
                point.u +
                  (e.key === 'ArrowLeft'
                    ? -step
                    : e.key === 'ArrowRight'
                      ? step
                      : 0) /
                    map.width
              )
            ),
            v: Math.max(
              0,
              Math.min(
                1,
                point.v +
                  (e.key === 'ArrowUp'
                    ? -step
                    : e.key === 'ArrowDown'
                      ? step
                      : 0) /
                    map.height
              )
            ),
          });
        }}
      >
        <div
          className="location-radar-canvas"
          style={{
            transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})`,
          }}
        >
          {radar && (
            <img
              key={`${radar}:${retry}`}
              src={radar}
              alt={map.name}
              draggable={false}
              onError={() => setFailed(true)}
              onLoad={() => setFailed(false)}
            />
          )}
          {visibleSelection && (
            <svg className="location-radar-selection" viewBox={`0 0 ${map.width} ${map.height}`}
              aria-label={t('location.selectedQuestionArea')}>
              <rect
                x={visibleSelection.minU * map.width} y={visibleSelection.minV * map.height}
                width={(visibleSelection.maxU - visibleSelection.minU) * map.width}
                height={(visibleSelection.maxV - visibleSelection.minV) * map.height}
              />
            </svg>
          )}
          {pin && target && (
            <svg
              className="location-pin-line"
              viewBox={`0 0 ${map.width} ${map.height}`}
            >
              <line
                x1={pin.u * map.width}
                y1={pin.v * map.height}
                x2={target.u * map.width}
                y2={target.v * map.height}
              />
            </svg>
          )}
          {pin && (
            <span
              className="location-pin guess"
              aria-label={guessLabel || t('location.yourGuess')}
              style={{
                left: `${pin.u * 100}%`,
                top: `${pin.v * 100}%`,
                transform: `translate(-50%,-50%) scale(${1 / view.zoom})`,
              }}
            />
          )}
          {target && (
            <span
              className="location-pin answer"
              aria-label={t('location.answer')}
              style={{
                left: `${target.u * 100}%`,
                top: `${target.v * 100}%`,
                transform: `translate(-50%,-50%) scale(${1 / view.zoom})`,
              }}
            />
          )}
          {markers
            .filter(
              (marker) => marker.mapId === map.id && marker.floorId === floorId
            )
            .map((marker) => (
              <button
                type="button"
                key={marker.id}
                className={`location-capture-pin${marker.selected ? ' selected' : ''}${marker.pending ? ' pending' : ''}${marker.captureStatus ? ` capture-${marker.captureStatus}` : ''}`}
                title={marker.title}
                aria-description={marker.title}
                aria-label={marker.ariaLabel || t('location.captureMarker', {
                  number: marker.label,
                })}
                aria-pressed={Boolean(marker.selected)}
                style={{
                  left: `${marker.u * 100}%`,
                  top: `${marker.v * 100}%`,
                  transform: `translate(-50%,-50%) scale(${1 / view.zoom})`,
                  '--capture-batch-color': marker.color,
                } as CSSProperties}
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onMarkerSelect?.(marker.id);
                }}
              >
                {marker.label}
              </button>
            ))}
        </div>
        {(!radar || failed) && (
          <div className="location-image-error">
            <span>{t('location.imageFailed')}</span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setFailed(false);
                setRetry((v) => v + 1);
              }}
            >
              {t('location.retry')}
            </button>
          </div>
        )}
      </div>
      <p className="muted">{hint || t(pin ? 'location.pinned' : 'location.pinHint')}</p>
    </div>
  );
}
