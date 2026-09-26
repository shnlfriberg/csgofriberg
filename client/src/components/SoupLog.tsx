import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { SoupEvent } from '../turtleSoup';
import { countryLabel } from '../utils/playerGeography';
import { playerRoleLabel } from '../utils/playerRoles';

export default function SoupLog({ events, newestFirst = false }: { events: SoupEvent[]; newestFirst?: boolean }) {
  const { t } = useTranslation();
  if (!events.length) return <p className="soup-empty">{t('soup.empty')}</p>;
  return <ol className="soup-log" aria-label={t('soup.log')} reversed={newestFirst}>
    {(newestFirst ? [...events].reverse() : events).map((event, index) => {
      const level = event.type === 'question' ? event.level : event.type === 'guess' && event.correct ? 'correct' : 'wrong';
      let question = t('soup.gaveUp');
      if (event.type === 'guess') question = t('soup.guessQuestion', { name: event.nickname });
      if (event.type === 'question') {
        const value = event.field === 'nationality' ? countryLabel(t, String(event.value))
          : event.field === 'role' ? playerRoleLabel(String(event.value))
          : event.field === 'isActive' ? t(event.value ? 'soup.active' : 'soup.retired')
          : event.field === 'team' && event.value === '' ? t('soup.noTeam') : String(event.value);
        question = t('soup.question', { field: t(`soup.${event.field}`), value });
      }
      return <li key={event.requestId} className={`soup-event soup-${level}`}>
        <span className="soup-event-number">{String(newestFirst ? events.length - index : index + 1).padStart(2, '0')}</span>
        <div><p>{question}</p><small className="muted">{t('soup.elapsed', { seconds: (event.elapsedMs / 1000).toFixed(1) })}</small></div>
        {event.type !== 'giveup' && <strong className="soup-feedback">{t(`soup.${level}`)}
          {event.type === 'question' && event.level !== 'correct' && event.hint && <span role="img" aria-label={t(`soup.${event.hint}`)} title={t(`soup.${event.hint}`)}>
            {event.hint === 'higher' ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />}
          </span>}
        </strong>}
      </li>;
    })}
  </ol>;
}
