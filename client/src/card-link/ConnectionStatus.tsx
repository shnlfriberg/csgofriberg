import { useTranslation } from 'react-i18next';
import { useCountdown } from '../hooks/useCountdown';

export default function ConnectionStatus({ deadline }: { deadline: number }) {
  const { t } = useTranslation();
  const seconds = useCountdown(deadline);
  return <span>{t('card.offlineGrace', { seconds })} </span>;
}
