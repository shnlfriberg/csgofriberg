import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, GripHorizontal, MapPin, Maximize2, PictureInPicture2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { difficultyColor, difficultyIcon } from '../utils/difficulty';
import Radar from './Radar';
import type { Difficulty, Guess, MapDefinition, RoundResult } from './types';

/** Same breakpoint as the stacked (single column) game layout in location.css. */
const STACKED_LAYOUT = '(max-width: 900px)';
const PIP_PREFERENCE_KEY = 'location:photo-pip';
const PIP_POSITION_KEY = 'location:photo-pip-position';

function motionReduced(): boolean {
  return document.documentElement.dataset.motion === 'reduced' ||
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** Per-viewer convenience: whether the question screenshot follows the player as a mini window. */
function usePhotoPipPreference(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(PIP_PREFERENCE_KEY) !== 'off'; } catch { return true; }
  });
  const update = (next: boolean) => {
    setEnabled(next);
    try { localStorage.setItem(PIP_PREFERENCE_KEY, next ? 'on' : 'off'); } catch { /* Storage is optional. */ }
  };
  return [enabled, update];
}

const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
/** Reuse the main-mode difficulty icons/colours so both lobbies read as one family. */
const MAIN_DIFFICULTY_STYLE: Record<Difficulty, string> = { easy: 'beginner', normal: 'easy', hard: 'normal' };

export function DifficultySelect({
  value,
  onChange,
  disabled,
  variant = 'cards',
}: {
  value: Difficulty;
  onChange: (value: Difficulty) => void;
  disabled?: boolean;
  /** cards: lobby option cards like single/daily; pills: compact option row like multiplayer. */
  variant?: 'cards' | 'pills';
}) {
  const { t } = useTranslation();
  const mix = (difficulty: Difficulty) =>
    t(`location.mix${difficulty[0].toUpperCase()}${difficulty.slice(1)}`);
  if (variant === 'pills') {
    return (
      <div className="option-row location-difficulty-row" role="group" aria-label={t('location.difficultyLabel')}>
        <span className="opt-label">{t('location.difficultyLabel')}</span>
        {DIFFICULTIES.map((difficulty) => (
          <button
            type="button"
            key={difficulty}
            disabled={disabled}
            onClick={() => onChange(difficulty)}
            className={`opt-btn ${value === difficulty ? 'active' : ''}`}
            aria-pressed={value === difficulty}
            title={mix(difficulty)}
          >
            {t(`location.${difficulty}`)}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="single-difficulty-grid location-difficulties" role="group" aria-label={t('location.difficultyLabel')}>
      {DIFFICULTIES.map((difficulty) => {
        const active = value === difficulty;
        const Icon = difficultyIcon(MAIN_DIFFICULTY_STYLE[difficulty]);
        return (
          <button
            type="button"
            key={difficulty}
            disabled={disabled}
            onClick={() => onChange(difficulty)}
            className={`single-difficulty-option${active ? ' active' : ''}`}
            style={{ ['--diff-color' as string]: difficultyColor(MAIN_DIFFICULTY_STYLE[difficulty]) }}
            aria-pressed={active}
          >
            <span className="single-difficulty-icon"><Icon size={20} /></span>
            <span className="single-difficulty-copy">
              <strong>{t(`location.${difficulty}`)}</strong>
              <small>{mix(difficulty)}</small>
            </span>
            <span className="single-difficulty-check" aria-hidden="true">{active && <Check size={17} />}</span>
          </button>
        );
      })}
    </div>
  );
}

type PipPosition = { x: number; y: number };
function storedPipPosition(): PipPosition | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PIP_POSITION_KEY) || 'null');
    return Number.isFinite(value?.x) && Number.isFinite(value?.y) ? { x: value.x, y: value.y } : null;
  } catch {
    return null;
  }
}

/** Floating, draggable copy of the question screenshot, shown while the original is scrolled away. */
function PhotoPip({ url, onExpand, onClose }: { url: string; onExpand: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);
  const [position, setPosition] = useState<PipPosition | null>(storedPipPosition);
  const clamp = (x: number, y: number): PipPosition => {
    const width = box.current?.offsetWidth ?? 160;
    const height = box.current?.offsetHeight ?? 180;
    return {
      x: Math.round(Math.min(Math.max(4, x), window.innerWidth - width - 4)),
      y: Math.round(Math.min(Math.max(4, y), window.innerHeight - height - 4)),
    };
  };
  useEffect(() => {
    const keepVisible = () => setPosition((current) => current && clamp(current.x, current.y));
    keepVisible();
    window.addEventListener('resize', keepVisible);
    return () => window.removeEventListener('resize', keepVisible);
  }, []);
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !box.current) return;
    const rect = box.current.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  // Move the element directly while dragging; commit to React state once at the end.
  const live = useRef<PipPosition | null>(position);
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const next = clamp(event.clientX - drag.current.dx, event.clientY - drag.current.dy);
    live.current = next;
    const element = box.current;
    if (element) {
      element.style.left = `${next.x}px`;
      element.style.top = `${next.y}px`;
      element.style.right = 'auto';
    }
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    const next = live.current;
    if (!next) return;
    setPosition(next);
    try { sessionStorage.setItem(PIP_POSITION_KEY, JSON.stringify(next)); } catch { /* optional */ }
  };
  return createPortal(
    <div
      className="location-pip"
      ref={box}
      role="complementary"
      aria-label={t('location.photoPip')}
      style={position ? { left: position.x, top: position.y, right: 'auto' } : undefined}
    >
      <div
        className="location-pip-bar"
        title={t('location.photoPipMove')}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <GripHorizontal size={14} aria-hidden="true" />
        <span>{t('location.questionPhoto')}</span>
        <button
          type="button"
          aria-label={t('location.photoPipHide')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <button type="button" className="location-pip-image" aria-label={t('location.enlarge')} onClick={onExpand}>
        <img src={url} alt="" draggable={false} />
      </button>
    </div>,
    document.body
  );
}

export function Photo({ url, pip = false, onPipClose }: { url: string; pip?: boolean; onPipClose?: () => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [offscreen, setOffscreen] = useState(false);
  const figure = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
    else dialog.current?.close();
  }, [expanded]);
  useEffect(() => {
    setFailed(false);
    setExpanded(false);
  }, [url]);
  useEffect(() => {
    setOffscreen(false);
    const element = figure.current;
    if (!pip || !element || typeof IntersectionObserver === 'undefined') return;
    // Viewport intersection also honours the .page-scroll clipping, so this tracks in-app scrolling.
    const observer = new IntersectionObserver(
      ([entry]) => setOffscreen(entry.intersectionRatio < 0.2),
      { threshold: [0, 0.2, 0.6] }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [pip]);
  return (
    <>
      <figure className="location-photo" ref={figure}>
        {failed ? (
          <div className="location-image-error">
            <p>{t('location.imageFailed')}</p>
            <button
              className="btn"
              onClick={() => {
                setFailed(false);
                setRetry((n) => n + 1);
              }}
            >
              {t('location.retry')}
            </button>
          </div>
        ) : (
          <img
            key={`${url}:${retry}`}
            src={url}
            alt={t('location.questionPhoto')}
            decoding="async"
            fetchPriority="high"
            onError={() => setFailed(true)}
          />
        )}
        <button
          type="button"
          className="location-photo-expand btn"
          aria-label={t('location.enlarge')}
          onClick={() => setExpanded(true)}
        >
          <Maximize2 size={17} />
        </button>
      </figure>
      {pip && offscreen && !failed && !expanded && (
        <PhotoPip url={url} onExpand={() => setExpanded(true)} onClose={() => onPipClose?.()} />
      )}
      <dialog
        ref={dialog}
        className="location-photo-dialog"
        onCancel={() => setExpanded(false)}
        onClose={() => setExpanded(false)}
      >
        <button
          className="btn location-dialog-close"
          onClick={() => setExpanded(false)}
          aria-label={t('common.close')}
        >
          <X />
        </button>
        {/* The enlarged copy is decoded only when the dialog is opened. */}
        {expanded && <img src={url} alt={t('location.questionPhoto')} decoding="async" />}
      </dialog>
    </>
  );
}
const NO_BANS: string[] = [];
/** Memoized: multiplayer room patches must not re-render the radar unless its inputs change. */
export const QuestionPanel = memo(function QuestionPanel({
  imageUrl,
  maps,
  onSubmit,
  disabled = false,
  bannedMapIds = NO_BANS,
}: {
  imageUrl: string;
  maps: MapDefinition[];
  onSubmit: (guess: Guess) => void;
  disabled?: boolean;
  bannedMapIds?: string[];
}) {
  const { t } = useTranslation();
  const [mapId, setMapId] = useState<string | null>(null);
  const [floorId, setFloorId] = useState<string | null>(null);
  const [guess, setGuess] = useState<Guess | null>(null);
  const [pipEnabled, setPipEnabled] = usePhotoPipPreference();
  const guessSection = useRef<HTMLElement>(null);
  useEffect(() => {
    setMapId(null);
    setFloorId(null);
    setGuess(null);
  }, [imageUrl]);
  const selected = maps.find((map) => map.id === mapId && !bannedMapIds.includes(map.id));
  const chooseMap = (map: MapDefinition) => {
    setMapId(map.id);
    setFloorId(map.floors.length === 1 ? map.floors[0].id : null);
    setGuess(null);
    // Stacked layout: bring the radar into view; the screenshot follows in its mini window.
    if (window.matchMedia?.(STACKED_LAYOUT).matches) {
      window.requestAnimationFrame(() => guessSection.current?.scrollIntoView?.({
        block: 'start',
        behavior: motionReduced() ? 'auto' : 'smooth',
      }));
    }
  };
  return (
    <div className="location-game-grid">
      <section className="location-photo-pane">
        <div className="location-step location-photo-heading">
          <h2>{t('location.questionPhoto')}</h2>
        </div>
        <Photo url={imageUrl} pip={pipEnabled} onPipClose={() => setPipEnabled(false)} />
      </section>
      <section className="location-scene">
        <div className="location-step">
          <span>01</span>
          <h2>{t('location.chooseMap')}</h2>
        </div>
        <div className="location-map-options">
          {maps.map((map) => {
            const banned = bannedMapIds.includes(map.id);
            const label = t(`location.mapNames.${map.id}`, { defaultValue: map.name });
            return (
            <button
              type="button"
              className={`location-map-option ${mapId === map.id ? 'selected' : ''}${banned ? ' location-map-banned' : ''}`}
              key={map.id}
              disabled={disabled || banned}
              aria-label={label === map.name ? label : `${label} ${map.name}`}
              aria-pressed={mapId === map.id}
              title={banned ? t('location.banned') : undefined}
              onClick={() => chooseMap(map)}
            >
              <span className="location-map-option-label">
                <span className="location-map-option-name">{label}</span>
                {label !== map.name && <span className="location-map-option-alias">{map.name}</span>}
                {banned && <small>{t('location.banned')}</small>}
              </span>
            </button>
            );
          })}
        </div>
      </section>
      <section className="location-guess" ref={guessSection}>
        <div className="location-step">
          <span>02</span>
          <h2>{t('location.choosePosition')}</h2>
          {selected && selected.floors.length > 1 && (
            <div
              className="location-floor-options"
              role="group"
              aria-label={t('location.chooseFloor')}
            >
              {selected.floors.map((floor) => (
                <button
                  type="button"
                  key={floor.id}
                  className={`btn btn-sm ${floorId === floor.id ? '' : 'btn-ghost'}`}
                  disabled={disabled}
                  aria-pressed={floorId === floor.id}
                  onClick={() => {
                    setFloorId(floor.id);
                    setGuess(null);
                  }}
                >
                  {t(`location.floor.${floor.id}`, {
                    defaultValue: floor.name,
                  })}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm location-pip-toggle"
            aria-pressed={pipEnabled}
            title={t(pipEnabled ? 'location.photoPipHide' : 'location.photoPipShow')}
            onClick={() => setPipEnabled(!pipEnabled)}
          >
            <PictureInPicture2 size={15} aria-hidden="true" />
            <span>{t('location.photoPip')}</span>
          </button>
        </div>
        {selected && floorId ? (
          <Radar
            map={selected}
            floorId={floorId}
            guess={guess}
            onChange={disabled ? undefined : setGuess}
          />
        ) : (
          <div className="location-radar-placeholder">
            <MapPin size={36} />
            <p>{t(selected ? 'location.chooseFloor' : 'location.chooseMap')}</p>
          </div>
        )}
        <button
          className="btn location-submit"
          disabled={disabled || !guess || bannedMapIds.includes(guess.mapId)}
          onClick={() => guess && !bannedMapIds.includes(guess.mapId) && onSubmit(guess)}
        >
          {t('location.confirmGuess')}
        </button>
      </section>
    </div>
  );
});
export function RoundReview({
  result,
  playerName,
  action,
}: {
  result: RoundResult;
  playerName?: string;
  /** Primary follow-up (e.g. next round), kept beside the score so it never needs scrolling. */
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const [floor, setFloor] = useState(result.answer.floorId);
  useEffect(
    () => setFloor(result.answer.floorId),
    [result.round, result.answer.floorId]
  );
  return (
    <section className="location-round-review">
      <div className="location-result-heading">
        <div className="location-result-title">
          <span className="location-eyebrow">
            {t('location.round', { round: result.round })}
          </span>
          <h2>{result.map.name}</h2>
          <span
            className={
              result.mapCorrect ? 'location-success' : 'location-error'
            }
          >
            {t(result.mapCorrect ? 'location.correctMap' : 'location.wrongMap')}
            {result.mapCorrect && !result.floorCorrect && ` · ${t('location.wrongFloor')}`}
          </span>
        </div>
        <strong className="location-round-score">
          {result.score.toLocaleString()}
          <small>/ {(5000).toLocaleString()}</small>
        </strong>
        {action && <div className="location-review-action">{action}</div>}
      </div>
      <div className="location-review-grid">
        <Photo url={result.imageUrl} />
        <div className="location-review-map">
          {result.map.floors.length > 1 && (
            <div className="location-floor-options">
              {result.map.floors.map((item) => (
                <button
                  className={`btn btn-sm ${floor === item.id ? '' : 'btn-ghost'}`}
                  key={item.id}
                  onClick={() => setFloor(item.id)}
                >
                  {t(`location.floor.${item.id}`, { defaultValue: item.name })}
                </button>
              ))}
            </div>
          )}
          <Radar
            map={result.map}
            floorId={floor}
            guess={result.mapCorrect ? result.guess : null}
            answer={result.answer}
            guessLabel={playerName}
            showHint={false}
          />
          <div className="location-pin-legend">
            <span>
              <i className="answer" />
              {t('location.answer')}
            </span>
            <span>
              <i className="guess" />
              {playerName || t('location.yourGuess')}
            </span>
            <span className="location-distance">
              {t('location.distance')}:{' '}
              {result.distanceRatio === null
                ? '—'
                : `${(result.distanceRatio * 100).toFixed(2)}%`}
            </span>
          </div>
          {!result.mapCorrect && result.guessedMap && result.guess && (
            <details className="location-guessed-map">
              <summary>
                {playerName || t('location.yourGuess')} ·{' '}
                {result.guessedMap.name}
              </summary>
              <Radar
                map={result.guessedMap}
                floorId={result.guess.floorId}
                guess={result.guess}
                guessLabel={playerName}
                showHint={false}
              />
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
export function Results({
  results,
  score,
  playerName,
  actions,
}: {
  results: RoundResult[];
  score: number;
  playerName?: string;
  /** Extra follow-up buttons shown with the score summary (play again, back…). */
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="location-final location-summary">
        <div className="location-summary-score">
          <span className="location-eyebrow">{t('location.result')}</span>
          <h1>
            {score.toLocaleString()}
            <small>/ {(25000).toLocaleString()}</small>
          </h1>
        </div>
        <div className="location-result-bars">
          {results.map((result) => (
            <button
              className={selected === result.round - 1 ? 'selected' : ''}
              key={result.round}
              aria-pressed={selected === result.round - 1}
              onClick={() => setSelected(result.round - 1)}
            >
              <span>{result.round}</span>
              <i
                style={
                  {
                    '--score-height': `${Math.max(3, (result.score / 5000) * 100)}%`,
                  } as React.CSSProperties
                }
              />
              <strong>{result.score.toLocaleString()}</strong>
            </button>
          ))}
        </div>
        <div className="location-summary-actions">
          <button
            className="btn btn-ghost"
            onClick={() =>
              void navigator.clipboard
                .writeText(
                  `${t('common.brand')} · ${t('location.title')}\n${score}/25000\n${results.map((r) => `${r.round}: ${r.score}`).join(' · ')}\n${window.location.origin}/entertainment`
                )
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          >
            {t(copied ? 'location.copied' : 'location.copy')}
          </button>
          {actions}
        </div>
      </div>
      {results[selected] && (
        <RoundReview result={results[selected]} playerName={playerName} />
      )}
    </>
  );
}
