import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCountdown } from '../hooks/useCountdown';

export default function RoomCountdown({ deadline, offset, label, clock = false }: {
  deadline: number | null; offset: number; label?: string; clock?: boolean;
}) {
  const { t } = useTranslation();
  const remaining = useCountdown(deadline, offset);
  const text = t('location.secondsShort', { count: remaining });
  if (clock) return remaining > 0 ? <span className="location-clock" role="timer"><Clock size={16} aria-hidden="true" />{text}</span> : null;
  return <p role="timer">{label} · {text}</p>;
}
