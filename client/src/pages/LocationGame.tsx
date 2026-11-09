import { Link } from 'react-router-dom';
import { MapPin, ArrowLeft, Flag, Play, Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import GameRules from '../components/GameRules';
import {
  DifficultySelect,
  QuestionPanel,
  Results,
  RoundReview,
} from '../location/Components';
import DailyLeaderboard from '../location/DailyLeaderboard';
import MapBanSelect from '../location/MapBanSelect';
import { useLocationGame } from '../location/useLocationGame';
import '../styles/location.css';

export default function LocationGame({ mode }: { mode: 'random' | 'daily' }) {
  const { t } = useTranslation();
  const modeTitle = t(
    mode === 'daily' ? 'location.mapDaily' : 'location.mapInfinite'
  );
  const {
    difficulty,
    setDifficulty,
    bannedMapIds,
    setBannedMapIds,
    game,
    review,
    setReview,
    busy,
    restoring,
    error,
    pending,
    date,
    daily,
    board,
    initialized,
    start,
    send,
    answer,
    abandon,
    playAgain,
    submitDaily,
    synchronize,
  } = useLocationGame(mode);
  // Same shell as the main game pages: progress lives in the shared status bar under the header.
  const statusBar = game ? (
    <>
      <Target size={14} aria-hidden="true" />
      <strong className="location-status-round">{t('location.round', { round: game.round })}</strong>
      <span className="location-round-dots" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((n) => (
          <span
            className={
              n <= game.answered
                ? 'done'
                : n === game.round
                  ? 'active'
                  : ''
            }
            key={n}
          >
            {n}
          </span>
        ))}
      </span>
      <span className="location-status-meta">
        {t(`location.${game.difficulty}`)}
        {game.totalScore !== null &&
          ` · ${game.totalScore.toLocaleString()}`}
      </span>
      {game.status !== 'finished' && (
        <button
          className="btn btn-ghost btn-sm location-abandon"
          disabled={busy || Boolean(pending)}
          onClick={() => void abandon()}
        >
          <Flag size={14} aria-hidden="true" />
          {t('location.abandon')}
        </button>
      )}
    </>
  ) : undefined;
  return (
    <Page
      title={modeTitle}
      className={`location-page location-play-page location-${mode}-page`}
      icon={<MapPin size={18} />}
      statusBar={statusBar}
      actions={
        <Link className="btn btn-ghost btn-sm" to="/entertainment/location">
          <ArrowLeft size={16} aria-hidden="true" />
          <span className="btn-text">{t('location.title')}</span>
        </Link>
      }
    >
      {error && (
        <div className="location-alert" role="alert">
          <span>{error}</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void synchronize()}
          >
            {t(game || (mode === 'daily' && !date) ? 'location.retry' : 'common.close')}
          </button>
        </div>
      )}
      {mode === 'daily' && (
        <DifficultySelect
          value={difficulty}
          onChange={setDifficulty}
          variant="pills"
          disabled={!initialized || (busy && !restoring) || Boolean(pending)}
        />
      )}
      {!game && restoring && (
        <p className="muted location-restoring" role="status">{t('common.loading')}</p>
      )}
      {!game && !restoring && (
        <>
          <section className="location-lobby">
            <p className="muted single-lobby-subtitle">{t(`location.${mode}Description`)}</p>
            {mode === 'random' && <DifficultySelect
              value={difficulty}
              onChange={setDifficulty}
              disabled={busy}
            />}
            {mode === 'daily' && (
              <p className="location-rules-note">{t('location.dailyNotice')}</p>
            )}
            {mode === 'random' && <MapBanSelect value={bannedMapIds} onChange={setBannedMapIds} disabled={busy || !initialized} />}
            <div className="single-lobby-action">
              <button
                className="btn btn-lg btn-green location-start"
                disabled={
                  busy ||
                  !initialized ||
                  (mode === 'daily' && (!date || daily?.available === false))
                }
                onClick={() => void start()}
              >
                <Play size={17} aria-hidden="true" />
                {t('location.start')}
              </button>
            </div>
            {daily?.available === false && (
              <p className="muted location-empty">{t('location.emptyDescription')}</p>
            )}
          </section>
        </>
      )}
      {game && (
        <>
          {pending && !busy && (
            <div className="location-alert" role="status">
              <span>{t('location.pendingAnswer')}</span>
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void send(pending)}
              >
                {t('location.retry')}
              </button>
            </div>
          )}
          {game.status === 'finished' ? (
            mode === 'daily' ? (
              <div className="location-daily-finished-layout">
                <section className="location-finished-results">
                  <Results
                    results={game.results}
                    score={game.totalScore || 0}
                    actions={
                      <Link className="btn btn-ghost" to="/entertainment">
                        {t('location.back')}
                      </Link>
                    }
                  />
                </section>
                <DailyLeaderboard board={board} difficulty={difficulty} />
              </div>
            ) : (
              <Results
                results={game.results}
                score={game.totalScore || 0}
                actions={
                  <>
                    <button
                      className="btn btn-green location-start"
                      disabled={busy}
                      onClick={() => void playAgain()}
                    >
                      {t('location.playAgain')}
                    </button>
                    <Link className="btn btn-ghost" to="/entertainment">
                      {t('location.back')}
                    </Link>
                  </>
                }
              />
            )
          ) : game.status === 'ready' ? (
            <div className="location-final">
              <h2>{t('location.readyToSubmit')}</h2>
              <p>{t('location.dailyNotice')}</p>
              <div className="location-own-answers">
                {game.guesses.map((guess, index) => (
                  <span key={index}>
                    {index + 1} ·{' '}
                    {game.maps.find((map) => map.id === guess.mapId)?.name} ·{' '}
                    {t(`location.floor.${guess.floorId}`, {
                      defaultValue: guess.floorId,
                    })}
                  </span>
                ))}
              </div>
              <button
                className="btn btn-lg btn-green location-start"
                disabled={busy || Boolean(pending)}
                onClick={() => void submitDaily()}
              >
                {t('location.submitDaily')}
              </button>
            </div>
          ) : review !== null && game.results[review] ? (
            <RoundReview
              result={game.results[review]}
              action={
                <button
                  className="btn location-start"
                  onClick={() => setReview(null)}
                >
                  {t('location.next')}
                </button>
              }
            />
          ) : (
            game.question && (
              <QuestionPanel
                imageUrl={game.question.imageUrl}
                maps={game.maps}
                bannedMapIds={mode === 'random' ? game.bannedMapIds : undefined}
                disabled={busy || Boolean(pending)}
                onSubmit={answer}
              />
            )
          )}
        </>
      )}
      <div className="location-rules-entry">
        <GameRules variant="location" />
      </div>
    </Page>
  );
}
