import { useTranslation } from 'react-i18next';
import type { DailyAssignment } from '../../../location/types';
import { locationAdmin } from './api';
import { useAdminTask } from './useAdminTask';

export default function DailyManager({
  days,
  onChanged,
}: {
  days: DailyAssignment[];
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const task = useAdminTask();
  return (
    <>
      <p className="muted">{t('location.dailyAdminHelp')}</p>
      <button
        className="btn"
        disabled={task.busy}
        onClick={() =>
          void task.run(async () => {
            await locationAdmin.generateDaily();
            await onChanged();
            task.setNotice(t('location.saved'));
          })
        }
      >
        {t('location.generateDaily')}
      </button>
      {task.error && (
        <p role="alert" className="location-alert">
          {task.error}
        </p>
      )}
      {task.notice && <p role="status">{task.notice}</p>}
      {!days.length && (
        <p className="location-admin-empty">{t('location.noDaily')}</p>
      )}
      {days.map((day) => (
        <section key={day.date}>
          <h3>{day.date}</h3>
          {Object.entries(day.decks).map(([difficulty, deck]) => (
            <p key={difficulty}>
              {t(`location.${difficulty}`)}:{' '}
              {deck
                .map(
                  (item) => `${item.map.name} · ${item.question.capturePointId}`
                )
                .join(' / ')}
            </p>
          ))}
        </section>
      ))}
    </>
  );
}
