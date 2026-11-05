import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';

export default function RoomCountdown({ deadline, offset, label, clock = false }: {
  deadline: number | null; offset: number; label?: string; clock?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [deadline, offset]);
  const remaining = Math.max(0, Math.ceil(((deadline || 0) - now - offset) / 1000));
  if (clock) return remaining > 0 ? <span className="location-clock"><Clock size={16} />{remaining}s</span> : null;
  return <p>{label} · {remaining}s</p>;
}
