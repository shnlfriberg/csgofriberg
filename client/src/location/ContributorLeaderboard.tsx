import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from '../components/DataTable';
import { useAuth } from '../store/auth';
import { api, message } from './api';
import type { ContributorBoard } from './types';

export default function ContributorLeaderboard() {
  const { t } = useTranslation(); const user = useAuth(s => s.user?.id ?? null);
  const [page, setPage] = useState(1); const [data, setData] = useState<ContributorBoard | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  useEffect(() => { setPage(1); }, [user]);
  useEffect(() => {
    let alive = true; setLoading(true); setError(''); setData(null);
    void api.get<ContributorBoard>('/location/submissions/leaderboard', { params: { page } })
      .then(({ data }) => alive && setData(data)).catch(e => alive && setError(message(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [page, user, retry]);
  return <section className="location-contributor-board">
    <h2>{t('location.contributorBoard')}</h2><p className="muted">{t('location.contributorBoardHelp')}</p>
    {error && <div role="alert">{error}<button className="btn" disabled={loading} onClick={() => setRetry(n => n + 1)}>{t('common.retry')}</button></div>}
    {data && <div className="leaderboard-self-summary" aria-label={t('leaderboard.myRank')}>
      <span>{t('leaderboard.myRank')}</span><strong>{data.currentUser.rank === null ? t('leaderboard.unranked') : `#${data.currentUser.rank}`}</strong>
      <span>{data.currentUser.displayId} · {t('location.acceptedSubmissions')} {data.currentUser.accepted}</span>
    </div>}
    <div className="card leaderboard-card"><DataTable rows={data?.items || []} rowKey={row => row.id} loading={loading} empty={t('location.contributorEmpty')}
      columns={[
        { key: 'rank', title: '#', render: row => row.rank },
        { key: 'displayId', title: t('leaderboard.player'), render: row => <>{row.displayId}{row.me && <span className="leaderboard-self-marker">{t('leaderboard.self')}</span>}</> },
        { key: 'accepted', title: t('location.acceptedSubmissions') },
      ]} /></div>
    <div className="submission-pagination"><button className="btn btn-ghost" disabled={loading || page === 1} onClick={() => setPage(n => n - 1)}>{t('common.previousPage')}</button><span>{page}</span><button className="btn btn-ghost" disabled={loading || !data?.hasNext} onClick={() => setPage(n => n + 1)}>{t('common.nextPage')}</button></div>
  </section>;
}
