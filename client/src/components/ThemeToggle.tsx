import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { getTheme, setTheme, subscribeTheme } from '../store/theme';
import { useTranslation } from 'react-i18next';

export default function ThemeToggle() {
  const { t } = useTranslation();
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'blast');
  const nextTheme = theme === 'blast' ? 'light' : 'blast';
  const label = nextTheme === 'light' ? t('common.switchLight') : t('common.switchDark');

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => setTheme(nextTheme)}
      data-umami-event="home-theme-change"
      data-umami-event-theme={nextTheme}
    >
      {nextTheme === 'light' ? <Sun size={15} /> : <Moon size={15} />}
      <span className="btn-text">{nextTheme === 'light' ? t('common.lightTheme') : t('common.darkTheme')}</span>
    </button>
  );
}
