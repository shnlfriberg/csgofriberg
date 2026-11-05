import { useEffect, useRef, useState } from 'react';
import { MapPin, Maximize2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Radar from './Radar';
import type { Difficulty, Guess, MapDefinition, RoundResult } from './types';

export function DifficultySelect({
  value,
  onChange,
  disabled,
}: {
  value: Difficulty;
  onChange: (value: Difficulty) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="location-difficulties">
      {(['easy', 'normal', 'hard'] as const).map((difficulty) => (
        <button
          type="button"
          key={difficulty}
          disabled={disabled}
          onClick={() => onChange(difficulty)}
          className={`location-difficulty ${value === difficulty ? 'selected' : ''}`}
          aria-pressed={value === difficulty}
        >
          <strong>{t(`location.${difficulty}`)}</strong>
          <span>
            {t(
              `location.mix${difficulty[0].toUpperCase()}${difficulty.slice(1)}`
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
export function Photo({ url }: { url: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
    else dialog.current?.close();
  }, [expanded]);
  useEffect(() => {
    setFailed(false);
    setExpanded(false);
  }, [url]);
  return (
    <>
      <figure className="location-photo">
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
            alt={t('location.title')}
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
        <img src={url} alt={t('location.title')} />
      </dialog>
    </>
  );
}
export function QuestionPanel({
  imageUrl,
  maps,
  onSubmit,
  disabled = false,
  bannedMapIds = [],
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
  useEffect(() => {
    setMapId(null);
    setFloorId(null);
    setGuess(null);
  }, [imageUrl]);
  const selected = maps.find((map) => map.id === mapId && !bannedMapIds.includes(map.id));
  return (
    <div className="location-game-grid">
      <section className="location-scene">
        <div className="location-step">
          <span>01</span>
          <h2>{t('location.chooseMap')}</h2>
        </div>
        <Photo url={imageUrl} />
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
              onClick={() => {
                setMapId(map.id);
                setFloorId(map.floors.length === 1 ? map.floors[0].id : null);
                setGuess(null);
              }}
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
      <section className="location-guess">
        <div className="location-step">
          <span>02</span>
          <h2>{t('location.choosePosition')}</h2>
        </div>
        {selected ? (
          <>
            {selected.floors.length > 1 && (
              <div
                className="location-floor-options"
                aria-label={t('location.chooseFloor')}
              >
                {selected.floors.map((floor) => (
                  <button
                    type="button"
                    key={floor.id}
                    className={`btn ${floorId === floor.id ? '' : 'btn-ghost'}`}
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
            {floorId ? (
              <Radar
                map={selected}
                floorId={floorId}
                guess={guess}
                onChange={disabled ? undefined : setGuess}
              />
            ) : (
              <div className="location-radar-placeholder">
                <MapPin size={42} />
                <p>{t('location.chooseFloor')}</p>
              </div>
            )}
          </>
        ) : (
          <div className="location-radar-placeholder">
            <MapPin size={42} />
            <p>{t('location.chooseMap')}</p>
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
}
export function RoundReview({
  result,
  playerName,
}: {
  result: RoundResult;
  playerName?: string;
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
        <div>
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
          </span>
          {result.mapCorrect && !result.floorCorrect && (
            <p>{t('location.wrongFloor')}</p>
          )}
        </div>
        <strong className="location-round-score">
          {result.score.toLocaleString()}
          <small>/ 5,000</small>
        </strong>
      </div>
      <div className="location-review-grid">
        <Photo url={result.imageUrl} />
        <div>
          <div className="location-floor-options">
            {result.map.floors.map((item) => (
              <button
                className={`btn ${floor === item.id ? '' : 'btn-ghost'}`}
                key={item.id}
                onClick={() => setFloor(item.id)}
              >
                {t(`location.floor.${item.id}`, { defaultValue: item.name })}
              </button>
            ))}
          </div>
          <Radar
            map={result.map}
            floorId={floor}
            guess={result.mapCorrect ? result.guess : null}
            answer={result.answer}
            guessLabel={playerName}
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
          </div>
          <p>
            {t('location.distance')}:{' '}
            {result.distanceRatio === null
              ? '—'
              : `${(result.distanceRatio * 100).toFixed(2)}%`}
          </p>
          {!result.mapCorrect && result.guessedMap && result.guess && (
            <details>
              <summary>
                {playerName || t('location.yourGuess')} ·{' '}
                {result.guessedMap.name}
              </summary>
              <Radar
                map={result.guessedMap}
                floorId={result.guess.floorId}
                guess={result.guess}
                guessLabel={playerName}
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
}: {
  results: RoundResult[];
  score: number;
  playerName?: string;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="location-final">
        <span className="location-eyebrow">{t('location.result')}</span>
        <h1>
          {score.toLocaleString()}
          <small>/ 25,000</small>
        </h1>
        <div className="location-result-bars">
          {results.map((result) => (
            <button
              className={selected === result.round - 1 ? 'selected' : ''}
              key={result.round}
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
      </div>
      {results[selected] && (
        <RoundReview result={results[selected]} playerName={playerName} />
      )}
    </>
  );
}
