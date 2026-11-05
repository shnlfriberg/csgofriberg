import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { View } from './types';

// Keep clock ticks local: the board, search results and lobby should not render
// four times per second merely to update this text.
export default function MatchClock({ view }: { view: View }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const stopped = !!view.current && (view.current.locked || view.status !== 'playing');
  const ticking = !stopped && (['playing', 'preparing', 'roundOver'].includes(view.status) ||
    (view.status === 'waiting' && view.scene === 'ranked'));
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [ticking, view.id, view.round]);
  // Old JSON never stored a stop time. Show its recorded score (if any),
  // rather than inventing a finish time from the current browser clock.
  if (stopped) {
    const elapsed = view.current!.stoppedAt !== undefined
      ? Math.max(0, view.current!.stoppedAt - view.current!.startedAt)
      : view.current!.best?.elapsed;
    return <strong>{elapsed === undefined ? t('card.roundOver') :
      `${t(view.current!.stoppedAt !== undefined ? 'card.roundTime' : 'card.resultTime')} · ${(elapsed / 1000).toFixed(1)} ${t('card.seconds')}`}</strong>;
  }
  const untimed = !!view.current && view.current.deadline === null;
  const deadline = untimed ? null : view.current?.deadline ?? view.dueAt;
  const seconds = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000))
    : view.current ? Math.max(0, Math.floor((now - view.current.startedAt) / 1000)) : 0;
  return <strong>
    {untimed && `${t('card.untimed')} · `}
    {seconds} {t('card.seconds')}
  </strong>;
}
