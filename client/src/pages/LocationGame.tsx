import { Link } from 'react-router-dom';
import { MapPin, ArrowLeft, History } from 'lucide-react';
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
    error,
    date,
    pending,
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
  return (
    <Page
      title={modeTitle}
      className={`location-page location-${mode}-page`}
      icon={<MapPin size={18} />}
      actions={
        <>
          <Link className="btn btn-ghost btn-sm" to="/entertainment/location" aria-label={t('location.title')}>
            <ArrowLeft size={16} />
          </Link>
          <Link
            className="btn btn-ghost btn-sm"
            to="/entertainment/location/history"
          >
            <History size={16} />
          </Link>
        </>
      }
    >
      {error && (
        <div className="location-alert" role="alert">
          {error}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void synchronize()}
          >
            {t('location.retry')}
          </button>
        </div>
      )}
      {!game && (
        <>
          <section className="location-lobby">
            <span className="location-eyebrow">
              CS2 // {date || 'LOCATION'}
            </span>
            <h1>{modeTitle}</h1>
            <p>{t(`location.${mode}Description`)}</p>
            <DifficultySelect
              value={difficulty}
              onChange={setDifficulty}
              disabled={busy}
            />
            {mode === 'daily' && (
              <p className="location-rules-note">{t('location.dailyNotice')}</p>
            )}
            {mode === 'random' && <MapBanSelect value={bannedMapIds} onChange={setBannedMapIds} disabled={busy || !initialized} />}
            <button
              className="btn location-start"
              disabled={
                busy ||
                !initialized ||
                (mode === 'daily' && daily?.available === false)
              }
              onClick={() => void start()}
            >
              {t('location.start')}
            </button>
            {daily?.available === false && (
              <p>{t('location.emptyDescription')}</p>
            )}
          </section>
        </>
      )}
      {game && (
        <>
          <div className="location-game-status">
            <strong>{t('location.round', { round: game.round })}</strong>
            <div className="location-round-dots">
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
            </div>
            <span>
              {t(`location.${game.difficulty}`)}
              {game.totalScore !== null &&
                ` · ${game.totalScore.toLocaleString()}`}
            </span>
          </div>
          {pending && (
            <div className="location-alert">
              <button
                className="btn"
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
                  />
                  <Link className="btn btn-ghost" to="/entertainment">
                    {t('location.back')}
                  </Link>
                </section>
                <DailyLeaderboard board={board} difficulty={difficulty} />
              </div>
            ) : (
              <>
                <Results results={game.results} score={game.totalScore || 0} />
                <button
                  className="btn location-start"
                  disabled={busy}
                  onClick={() => void playAgain()}
                >
                  {t('location.playAgain')}
                </button>
                <Link className="btn btn-ghost" to="/entertainment">
                  {t('location.back')}
                </Link>
              </>
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
                className="btn location-start"
                disabled={busy || Boolean(pending)}
                onClick={() => void submitDaily()}
              >
                {t('location.submitDaily')}
              </button>
            </div>
          ) : review !== null && game.results[review] ? (
            <>
              <RoundReview result={game.results[review]} />
              <button
                className="btn location-start"
                onClick={() => setReview(null)}
              >
                {t('location.next')}
              </button>
            </>
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
          {game.status !== 'finished' && (
            <button
              className="btn btn-ghost location-abandon"
              disabled={busy || Boolean(pending)}
              onClick={() => void abandon()}
            >
              {t('location.abandon')}
            </button>
          )}
        </>
      )}
      <div className="location-rules-entry">
        <GameRules variant="location" />
      </div>
    </Page>
  );
}
