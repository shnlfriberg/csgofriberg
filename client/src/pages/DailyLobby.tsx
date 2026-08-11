import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Check, Play } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import { api, errMsg } from '../api/client';
import { AVAILABLE_DIFFICULTIES } from '../config/difficulties';
import {
  difficultyColor,
  difficultyDescription,
  difficultyIcon,
  difficultyLabel,
} from '../utils/difficulty';
import { getStoredDailyDifficulty, setStoredDailyDifficulty } from '../store/dailyDifficulty';

type DailyStatus = 'not_started' | 'playing' | 'won' | 'lost';

interface DailyLobbyResponse {
  date: string;
  timeZone: 'Asia/Shanghai';
  serverNow: number;
  startsAt: number;
  nextRefreshAt: number;
  challenges: Array<{
    difficulty: string;
    status: DailyStatus;
  }>;
}

export default function DailyLobby() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const difficulties = AVAILABLE_DIFFICULTIES;
  const defaultDifficulty = difficulties.find((item) => item.recommended) ?? difficulties[0];
  const [selected, setSelected] = useState<string | null>(getStoredDailyDifficulty);
  const [statuses, setStatuses] = useState<Record<string, DailyStatus>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadStatuses = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<DailyLobbyResponse>('/daily-challenge/overview');
      setStatuses(Object.fromEntries(
        response.data.challenges.map((challenge) => [challenge.difficulty, challenge.status])
      ));
      setLoadError(null);
    } catch (error) {
      setLoadError(errMsg(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses]);

  const selectedDifficulty = difficulties.find((item) => item.key === selected) ?? defaultDifficulty;

  useEffect(() => {
    if (!selectedDifficulty || selected === selectedDifficulty.key) return;
    setSelected(selectedDifficulty.key);
    setStoredDailyDifficulty(selectedDifficulty.key);
  }, [selected, selectedDifficulty]);

  const choose = (key: string) => {
    setSelected(key);
    setStoredDailyDifficulty(key);
  };

  const enter = () => {
    if (!selectedDifficulty) return;
    navigate(`/daily/${selectedDifficulty.key}`);
  };

  return (
    <Page title={t('dailyLobby.title')} icon={<CalendarDays size={17} />}>
      <p className="muted single-lobby-subtitle">{t('dailyLobby.subtitle')}</p>
      {loadError && (
        <div className="daily-lobby-error" role="status">
          <span>{loadError}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadStatuses()}>
            {t('common.retry')}
          </button>
        </div>
      )}
      {difficulties.length ? (
        <>
          <div className="single-difficulty-grid">
            {difficulties.map((difficulty) => {
              const active = selectedDifficulty?.key === difficulty.key;
              const status = statuses[difficulty.key];
              const Icon = difficultyIcon(difficulty.key);
              return (
                <button
                  type="button"
                  key={difficulty.key}
                  className={`single-difficulty-option${active ? ' active' : ''}`}
                  style={{ ['--diff-color' as string]: difficultyColor(difficulty.key) }}
                  onClick={() => choose(difficulty.key)}
                >
                  <span className="single-difficulty-icon"><Icon size={20} /></span>
                  <span className="single-difficulty-copy">
                    <strong>{difficultyLabel(t, difficulty.key)}</strong>
                    <small>
                      {difficultyDescription(t, difficulty.key) || t('singleLobby.available')}
                    </small>
                  </span>
                  <span className="single-difficulty-check" aria-hidden="true">{active && <Check size={17} />}</span>
                  <span className={`single-difficulty-badge daily-lobby-status${status ? ` daily-lobby-status-${status}` : ''}`}>
                    {status
                      ? t(`daily.status.${status}`)
                      : loading
                        ? t('common.loading')
                        : t('dailyLobby.statusUnavailable')}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="single-lobby-action">
            <button type="button" className="btn btn-lg btn-green" onClick={enter}>
              <Play size={17} /> {t('dailyLobby.enter')}
            </button>
          </div>
        </>
      ) : (
        <div className="card"><p className="muted">{t('errors.DIFFICULTY_UNAVAILABLE')}</p></div>
      )}
    </Page>
  );
}
