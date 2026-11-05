import { useEffect, useId, useState } from 'react';
import { Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Variant } from '@friberg/card-link-core';
import { api, errMsg } from '../api/client';
import DataTable, { type Column } from '../components/DataTable';

export type DailyRank = { username: string; hops: number; elapsed: number };
type RankedRow = DailyRank & { rank: number };

/** Same heading, top-ten badge and table as the classic daily challenge. */
export default function CardDailyLeaderboard({ variant }: { variant: Variant }) {
  const { t } = useTranslation();
  const heading = useId();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ variant: Variant; rows: DailyRank[]; loading: boolean; error: string }>({
    variant, rows: [], loading: true, error: '',
  });
  useEffect(() => {
    let alive = true;
    setState({ variant, rows: [], loading: true, error: '' });
    void api.get<DailyRank[]>('/card-link/daily-leaderboard', { params: { variant } })
      .then(({ data }) => { if (alive) setState({ variant, rows: data.slice(0, 10), loading: false, error: '' }); })
      .catch(error => { if (alive) setState({ variant, rows: [], loading: false, error: errMsg(error) }); });
    return () => { alive = false; };
  }, [variant, retry]);
  // Do not briefly label the previous hand mode's rows as the newly chosen mode.
  const current = state.variant === variant ? state : { rows: [], loading: true, error: '' };
  const columns: Column<RankedRow>[] = [
    { key: 'rank', title: '#' },
    { key: 'username', title: t('daily.player'), render: row => <span className="daily-leaderboard-player">
      <span className="daily-leaderboard-player-name" title={row.username}>{row.username}</span>
    </span> },
    { key: 'hops', title: t('daily.steps'), render: row => `${row.hops} ${t('card.hops')}` },
    { key: 'elapsed', title: t('card.time'), render: row => <span className="cl-rank-time">{(row.elapsed / 1000).toFixed(3)} {t('card.seconds')}</span> },
  ];
  return <section className="daily-leaderboard-section cl-daily-leaderboard" aria-labelledby={heading}>
    <div className="daily-section-heading">
      <div>
        <span className="daily-section-icon daily-trophy-icon"><Trophy size={19} aria-hidden="true" /></span>
        <div><h2 id={heading}>{t('daily.leaderboard')}</h2><p>{t(`card.${variant}`)}</p></div>
      </div>
      <span className="daily-top-ten">TOP 10</span>
    </div>
    <div className="daily-leaderboard-table">
      <DataTable columns={columns} rows={current.rows.map((row, index) => ({ ...row, rank: index + 1 }))}
        rowKey={row => `${row.rank}:${row.username}`} loading={current.loading}
        empty={current.error || t('card.dailyLeaderboardEmpty')} />
      {current.error && !current.loading && <button className="btn btn-ghost btn-sm" onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</button>}
    </div>
  </section>;
}
