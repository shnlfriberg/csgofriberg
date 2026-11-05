import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export default function ConnectionStatus({ deadline }: { deadline: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return <span>{t('card.offlineGrace', { seconds: Math.max(0, Math.ceil((deadline - now) / 1000)) })} </span>;
}
