import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { getTheme, setTheme, subscribeTheme } from '../store/theme';
import { useTranslation } from 'react-i18next';

export default function ThemeToggle() {
  const { t } = useTranslation();
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'blast');
  const isLight = theme === 'light';
  const nextTheme = isLight ? 'blast' : 'light';
  const actionHint = isLight ? t('common.switchDark') : t('common.switchLight');

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm theme-toggle"
      aria-pressed={isLight}
      title={actionHint}
      onClick={() => setTheme(nextTheme)}
      data-umami-event="home-theme-change"
      data-umami-event-theme={nextTheme}
    >
      {isLight ? <Sun size={15} /> : <Moon size={15} />}
      <span className="btn-text">{isLight ? t('common.lightTheme') : t('common.darkTheme')}</span>
    </button>
  );
}
