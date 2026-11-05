import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function StatsModeTabs() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const variant = params.get('variant') || 'classic';
  return <div className="soup-mode-tabs" role="tablist" aria-label={t('leaderboard.modeLabel')}>
    {(['classic', 'turtle-soup', 'location', 'card-link'] as const).map((value) => <button type="button" role="tab" key={value}
      aria-selected={variant === value} className={`btn ${variant === value ? 'active' : ''}`}
      onClick={() => { if (variant !== value) setParams(value === 'classic' ? {} : { variant: value }); }}>
      {t(value === 'card-link' ? 'card.title' : value === 'location' ? 'location.title' : value === 'turtle-soup' ? 'soup.shortTitle' : 'soup.classic')}
    </button>)}
  </div>;
}
