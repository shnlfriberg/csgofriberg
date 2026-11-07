import { useTranslation } from 'react-i18next';
import type { Difficulty } from './types';

export type DailyLeaderboardEntry = {
  name: string;
  score: number;
  rank: number;
  me: boolean;
};

export default function DailyLeaderboard({
  board,
  difficulty,
}: {
  board: DailyLeaderboardEntry[];
  difficulty: Difficulty;
}) {
  const { t } = useTranslation();
  return (
    <section
      className="location-board"
      aria-labelledby="location-daily-leaderboard-heading"
    >
      <div className="location-board-heading">
        <div>
          <span className="location-eyebrow">{t('location.topN', { count: 100 })}</span>
          <h2 id="location-daily-leaderboard-heading">
            {t('location.leaderboard')}
          </h2>
          <p className="muted">{t(`location.${difficulty}`)}</p>
        </div>
        <span className="location-board-date">
          {t('location.leaderboardHint')}
        </span>
      </div>
      {board.map((entry) => (
        <div
          key={`${entry.rank}:${entry.name}`}
          className={entry.me ? 'me' : ''}
        >
          <span>#{entry.rank}</span>
          <strong>{entry.name}</strong>
          <span>{entry.score.toLocaleString()}</span>
        </div>
      ))}
      {!board.length && (
        <p className="muted location-board-empty">
          {t('location.leaderboardEmpty')}
        </p>
      )}
    </section>
  );
}
