import { CalendarPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DailyAssignment } from '../../../location/types';
import { Panel } from '../ui';
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
    <Panel
      id="location-daily-title"
      title={t('adminUi.dailyDays')}
      description={t('location.dailyAdminHelp')}
      flush
      actions={(
        <button
          className="btn btn-sm"
          disabled={task.busy}
          onClick={() =>
            void task.run(async () => {
              await locationAdmin.generateDaily();
              await onChanged();
              task.setNotice(t('location.saved'));
            })
          }
        >
          <CalendarPlus size={15} aria-hidden="true" />{t('location.generateDaily')}
        </button>
      )}
    >
      {(task.error || task.notice) && (
        <div className="admin-panel-body">
          {task.error && <p role="alert" className="location-alert">{task.error}</p>}
          {task.notice && <p role="status" className="admin-help">{task.notice}</p>}
        </div>
      )}
      {!days.length ? (
        <p className="admin-empty">{t('location.noDaily')}</p>
      ) : (
        <div className="admin-table-scroll location-daily-table">
          <table>
            <thead>
              <tr>
                <th>{t('adminUi.dateColumn')}</th>
                <th>{t('adminUi.difficultyColumn')}</th>
                <th>{t('adminUi.deckColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {days.flatMap((day) => Object.entries(day.decks).map(([difficulty, deck], index) => (
                <tr key={`${day.date}:${difficulty}`}>
                  {index === 0 && <th scope="rowgroup" rowSpan={Object.keys(day.decks).length}>{day.date}</th>}
                  <td>{t(`location.${difficulty}`)}</td>
                  <td>
                    <ol className="location-daily-deck">
                      {deck.map((item, position) => (
                        <li key={`${item.question.id}:${position}`}>
                          <span>{item.map.name}</span>
                          <code>{item.question.capturePointId}</code>
                        </li>
                      ))}
                    </ol>
                  </td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
