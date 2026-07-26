import { useTranslation } from 'react-i18next';
import type { PlayerPerformanceStats } from '../types';

function formatWinRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export default function PlayerStatsSummary({ stats }: { stats: PlayerPerformanceStats }) {
  const { t } = useTranslation();
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
        </dl>
      </section>
    </div>
  );
}
