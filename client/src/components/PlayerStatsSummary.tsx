import { useTranslation } from 'react-i18next';
import type { PlayerPerformanceStats } from '../types';
import { difficultyLabel } from '../utils/difficulty';

function formatWinRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export default function PlayerStatsSummary({ stats }: { stats: PlayerPerformanceStats }) {
  const { t, i18n } = useTranslation();
  const { single, multi } = stats;

  return (
    <div className="player-stats-body">
      <section>
        <h3>{t('multi.singleStats')}</h3>
        <dl className="player-stats-list">
          <div><dt>{t('multi.games')}</dt><dd>{single.games}</dd></div>
          <div><dt>{t('multi.winsLosses')}</dt><dd>{single.wins} / {single.losses}</dd></div>
          <div><dt>{t('multi.winRate')}</dt><dd>{formatWinRate(single.winRate)}</dd></div>
          <div><dt>{t('multi.avgWinningGuesses')}</dt><dd>{single.avgGuesses?.toFixed(1) ?? '-'}</dd></div>
          <div><dt>{t('multi.fastest')}</dt><dd>{single.bestGuesses ?? '-'}</dd></div>
        </dl>
      </section>
      <section>
        <h3>{t('multi.multiStats')}</h3>
        <dl className="player-stats-list">
          <div><dt>{t('multi.games')}</dt><dd>{multi.games}</dd></div>
          <div><dt>{t('multi.winsLosses')}</dt><dd>{multi.wins} / {multi.losses}</dd></div>
          <div><dt>{t('multi.winRate')}</dt><dd>{formatWinRate(multi.winRate)}</dd></div>
          <div><dt>{t('multi.recentWinningGuessAverage')}</dt><dd>{multi.recentAverageWinningGuesses?.toFixed(1) ?? '-'}</dd></div>
        </dl>
      </section>
      <section className="player-stats-recent">
        <h3>{t('multi.recentMatches')}</h3>
        {multi.recentMatches.length ? (
          <div className="player-stats-recent-list">
            {multi.recentMatches.map((match) => (
              <article key={match.id}>
                <div className="player-stats-recent-heading">
                  <strong>{match.opponentDisplayId}</strong>
                  <span className={`badge ${match.result === 'won' ? 'green' : match.result === 'lost' ? 'red' : ''}`}>
                    {t(`common.${match.result === 'won' ? 'win' : match.result === 'lost' ? 'loss' : 'draw'}`)}
                  </span>
                  <b>{match.score.me} : {match.score.opponent}</b>
                </div>
                <p className="muted">
                  BO{match.boType} · {difficultyLabel(t, match.dbType)} · {new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(match.finishedAt))}
                </p>
                <div className="player-stats-rounds">
                  {match.rounds.map((round) => (
                    <span key={round.round}>
                      {t('multi.roundGuessSummary', {
                        round: round.round,
                        me: round.meGuesses,
                        opponent: round.opponentGuesses,
                      })}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">{t('multi.noRecentMatches')}</p>
        )}
      </section>
    </div>
  );
}
