import { useEffect, useMemo, useState } from 'react';
import { Check, Gamepad2, Play } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Page from '../components/Page';
import { AVAILABLE_DIFFICULTIES } from '../config/difficulties';
import {
  difficultyColor,
  difficultyDescription,
  difficultyIcon,
  difficultyLabel,
} from '../utils/difficulty';
import { getStoredSingleDifficulty, setStoredSingleDifficulty } from '../store/singleDifficulty';
import { useTranslation } from 'react-i18next';
import { toast } from '../components/Toast';

export default function SingleLobby() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const difficulties = AVAILABLE_DIFFICULTIES;
  const [selected, setSelected] = useState<string | null>(getStoredSingleDifficulty);

  const selectedDifficulty = useMemo(
    () => difficulties.find((item) => item.key === selected)
      ?? difficulties.find((item) => item.recommended)
      ?? difficulties[0],
    [difficulties, selected]
  );

  useEffect(() => {
    if (!selectedDifficulty) return;
    if (selected !== selectedDifficulty.key) {
      setSelected(selectedDifficulty.key);
      setStoredSingleDifficulty(selectedDifficulty.key);
    }
  }, [selected, selectedDifficulty]);

  const choose = (key: string) => {
    setSelected(key);
    setStoredSingleDifficulty(key);
  };

  const start = () => {
    if (!selectedDifficulty) {
      toast.error(t('errors.DIFFICULTY_UNAVAILABLE'));
      return;
    }
    navigate(`/single/${selectedDifficulty.key}`);
  };

  return (
    <Page title={t('singleLobby.title')} icon={<Gamepad2 size={17} />}>
      <p className="muted single-lobby-subtitle">{t('singleLobby.subtitle')}</p>
      {difficulties.length ? (
        <>
          <div className="single-difficulty-grid">
            {difficulties.map((difficulty) => {
              const active = selectedDifficulty?.key === difficulty.key;
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
                  {difficulty.recommended && (
                    <span className="single-difficulty-badge">{t('singleLobby.recommended')}</span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="single-lobby-action">
            <button type="button" className="btn btn-lg btn-green" onClick={start}>
              <Play size={17} /> {t('singleLobby.start')}
            </button>
          </div>
        </>
      ) : (
        <div className="card"><p className="muted">{t('errors.DIFFICULTY_UNAVAILABLE')}</p></div>
      )}
    </Page>
  );
}
