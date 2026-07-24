import { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import Page from '../components/Page';
import DataTable, { Column } from '../components/DataTable';
import { api, errMsg } from '../api/client';
import { toast } from '../components/Toast';
import { useAuth } from '../store/auth';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_DIFFICULTIES } from '../config/difficulties';
import { difficultyLabel } from '../utils/difficulty';

interface BoardRow {
  id: number;
  displayId: string;
  total: number;
  wins: number;
  winRate: number;
  avgGuesses: number | null;
}

type LeaderboardType = string;

interface LeaderboardResponse {
  type: LeaderboardType;
  items: BoardRow[];
  currentUser: { displayId: string; rank: number | null } | null;
}

export default function Leaderboard() {
  const { t } = useTranslation();
  const difficulties = AVAILABLE_DIFFICULTIES;
  const [type, setType] = useState<LeaderboardType>('easy');
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [currentUser, setCurrentUser] = useState<LeaderboardResponse['currentUser']>(null);
  const currentUserId = useAuth((state) => state.user?.id ?? null);
  const leaderboardTypes = [...difficulties.map((item) => item.key), 'multi'];

  useEffect(() => {
    if (difficulties.length && type !== 'multi' && !difficulties.some((item) => item.key === type)) {
      setType(difficulties[0].key);
    }
  }, [difficulties, type]);

  useEffect(() => {
    let active = true;
    api
      .get<LeaderboardResponse>('/leaderboard', { params: { type } })
      .then((res) => {
        if (!active) return;
        setRows(res.data.items);
        setCurrentUser(res.data.currentUser);
      })
      .catch((err) => toast.error(errMsg(err)));
    return () => { active = false; };
  }, [type]);

  const columns: Column<BoardRow>[] = [
    { key: 'rank', title: '#', render: (r) => rows.indexOf(r) + 1 },
    {
      key: 'displayId',
      title: t('leaderboard.player'),
      render: (row) => (
        <span className="leaderboard-player-label">
          {row.displayId}
          {row.id === currentUserId && <span className="leaderboard-self-marker">{t('leaderboard.self')}</span>}
        </span>
      ),
    },
    { key: 'wins', title: t('leaderboard.wins') },
    { key: 'total', title: t('leaderboard.total') },
    { key: 'winRate', title: t('leaderboard.winRate'), render: (r) => `${(r.winRate * 100).toFixed(1)}%` },
    ...(type === 'multi' ? [] : [{
      key: 'avgGuesses',
      title: t('leaderboard.avgGuesses'),
      render: (r: BoardRow) => (r.avgGuesses != null ? r.avgGuesses.toFixed(2) : '-'),
    }]),
  ];

  return (
    <Page title={t('leaderboard.title')} icon={<Trophy size={17} />}>
      {currentUser && (
        <div className="leaderboard-self-summary">
          <span>{t('leaderboard.myRank')}</span>
          <strong>{currentUser.rank == null ? t('leaderboard.unranked') : `#${currentUser.rank}`}</strong>
          <span>{currentUser.displayId}</span>
        </div>
      )}
      <div className="leaderboard-mode-tabs" role="tablist" aria-label={t('leaderboard.typeLabel')}>
        {leaderboardTypes.map((option) => (
          <button
            type="button"
            role="tab"
            aria-selected={type === option}
            className={type === option ? 'active' : ''}
            key={option}
            onClick={() => setType(option)}
          >
            {option === 'multi' ? t('leaderboard.multi') : difficultyLabel(t, option)}
          </button>
        ))}
      </div>
      <div className={`card leaderboard-card leaderboard-card-${type}`}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={t('leaderboard.empty', { type: type === 'multi' ? t('leaderboard.multi') : difficultyLabel(t, type) })}
        />
      </div>
    </Page>
  );
}
