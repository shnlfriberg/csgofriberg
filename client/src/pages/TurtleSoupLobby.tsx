import { SOUP_MAX_ATTEMPTS } from '../turtleSoup';
import GameRules from '../components/GameRules';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Soup, Play, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import { AVAILABLE_DIFFICULTIES } from '../config/difficulties';
import { difficultyColor, difficultyDescription, difficultyIcon, difficultyLabel } from '../utils/difficulty';

const KEY = 'csgofriberg_soup_difficulty';
export default function TurtleSoupLobby() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(() => {
    try { return AVAILABLE_DIFFICULTIES.find((d) => d.key === localStorage.getItem(KEY))?.key ?? 'beginner'; }
    catch { return 'beginner'; }
  });
  return <Page title={t('soup.title')} icon={<Soup size={18} />} className="soup-lobby">
    <div className="soup-intro"><span className="hero-kicker">{t('soup.questionBudget', { count: SOUP_MAX_ATTEMPTS })} / CS MAJOR</span><h1>{t('soup.subtitle')}</h1><p className="muted">{t('soup.description')}</p></div>
    <div className="single-difficulty-grid">{AVAILABLE_DIFFICULTIES.map((difficulty) => {
      const Icon = difficultyIcon(difficulty.key);
      return <button key={difficulty.key} className={`single-difficulty-option${selected === difficulty.key ? ' active' : ''}`}
        aria-pressed={selected === difficulty.key} style={{ ['--diff-color' as string]: difficultyColor(difficulty.key) }} onClick={() => {
          setSelected(difficulty.key);
          try { localStorage.setItem(KEY, difficulty.key); } catch { /* Storage is optional. */ }
        }}>
        <span className="single-difficulty-icon"><Icon size={20} /></span>
        <span className="single-difficulty-copy"><strong>{difficultyLabel(t, difficulty.key)}</strong><small>{difficultyDescription(t, difficulty.key)}</small></span>
        <span className="single-difficulty-check">{selected === difficulty.key && <Check size={17} />}</span>
      </button>;
    })}</div>
    <div className="single-lobby-action"><button className="btn btn-lg btn-green" onClick={() => navigate(`/turtle-soup/${selected}`)}><Play size={17} />{t('singleLobby.start')}</button></div>
    <div className="soup-rules-entry"><GameRules variant="turtle-soup" /></div>
  </Page>;
}
