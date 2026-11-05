import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AdminOverview,
  BankChecks as Checks,
} from '../../../location/types';
import { locationAdmin } from './api';
import { useAdminTask } from './useAdminTask';

export default function BankChecks({ data }: { data: AdminOverview }) {
  const { t } = useTranslation();
  const task = useAdminTask();
  const [checks, setChecks] = useState<Checks | null>(null);
  const check = () =>
    task.run(async () => setChecks(await locationAdmin.checks()));
  useEffect(() => {
    void check();
  }, []);
  return (
    <>
      <p className="muted">{t('location.samePointDrawHelp')}</p>
      <button className="btn" disabled={task.busy} onClick={() => void check()}>
        {t('location.runChecks')}
      </button>
      {task.busy && <p role="status">{t('location.checking')}</p>}
      {task.error && (
        <p role="alert" className="location-alert">
          {task.error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>{t('location.maps')}</th>
            <th>{t('location.calibration')}</th>
            <th>{t('location.easy')}</th>
            <th>{t('location.medium')}</th>
            <th>{t('location.hard')}</th>
            <th>{t('location.staleQuestions')}</th>
          </tr>
        </thead>
        <tbody>
          {data.counts.map((row) => (
            <tr key={row.mapId}>
              <td>{data.maps.find((map) => map.id === row.mapId)?.name}</td>
              <td>
                {t(
                  row.calibrationValid ? 'location.valid' : 'location.invalid'
                )}
              </td>
              <td>{row.easy}</td>
              <td>{row.medium}</td>
              <td>{row.hard}</td>
              <td>{row.stale}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {checks && (
        <>
          <p>
            {t('location.missingAssets')}: {checks.missingAssets.length}
          </p>
          {checks.missingAssets.length > 0 && (
            <p className="location-error">{checks.missingAssets.join(' / ')}</p>
          )}
          {checks.randomAfterDaily && <section>
            <p>{t(checks.dailySource === 'fixed' ? 'location.bankFixedDaily' : 'location.bankSimulatedDaily')}</p>
            <p>{t('location.bankPointCounts', { total: checks.uniquePoints, reserved: checks.reservedPoints })}</p>
            {Object.entries(checks.randomAfterDaily).map(([difficulty, valid]) => <p key={difficulty}>{t('location.random')} · {t(`location.${difficulty}`)}: {t(valid ? 'location.valid' : 'location.invalid')}</p>)}
            {Object.entries(checks.remainingByTier || {}).map(([tier, count]) => <p key={tier}>{t('location.bankRemaining')} · {t(`location.${tier}`)}: {count}</p>)}
          </section>}
          {Object.entries(checks.compositions).map(([difficulty, valid]) => (
            <p key={difficulty}>
              {t(`location.${difficulty}`)} ·{' '}
              {t(valid ? 'location.valid' : 'location.invalid')}
            </p>
          ))}
          <p>
            {t('location.daily')} ·{' '}
            {t(checks.dailyAvailable ? 'location.valid' : 'location.invalid')}
          </p>
        </>
      )}
    </>
  );
}
