import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AdminOverview,
  BankChecks as Checks,
} from '../../../location/types';
import Badge from '../../Badge';
import { Panel } from '../ui';
import { locationAdmin } from './api';
import { useAdminTask } from './useAdminTask';

function State({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return <Badge text={ok ? okText : badText} color={ok ? 'green' : 'amber'} />;
}

export default function BankChecks({ data }: { data: AdminOverview }) {
  const { t } = useTranslation();
  const task = useAdminTask();
  const [checks, setChecks] = useState<Checks | null>(null);
  const check = () =>
    task.run(async () => setChecks(await locationAdmin.checks()));
  useEffect(() => {
    void check();
  }, []);
  const valid = t('location.valid');
  const invalid = t('location.invalid');
  return (
    <div className="admin-columns location-checks">
      <Panel id="location-checks-maps" title={t('adminUi.checksPerMap')} description={t('location.samePointDrawHelp')} flush>
        <div className="admin-table-scroll">
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
                  <td><strong>{data.maps.find((map) => map.id === row.mapId)?.name}</strong></td>
                  <td><State ok={row.calibrationValid} okText={valid} badText={invalid} /></td>
                  <td className="admin-num">{row.easy}</td>
                  <td className="admin-num">{row.medium}</td>
                  <td className="admin-num">{row.hard}</td>
                  <td className={`admin-num${row.stale ? ' admin-bad' : ''}`}>{row.stale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel
        id="location-checks-results"
        title={t('adminUi.checksResults')}
        actions={(
          <button className="btn btn-sm" disabled={task.busy} onClick={() => void check()}>
            <RefreshCw size={15} aria-hidden="true" className={task.busy ? 'admin-spin' : undefined} />{t('location.runChecks')}
          </button>
        )}
      >
        {task.busy && <p role="status" className="admin-help">{t('location.checking')}</p>}
        {task.error && <p role="alert" className="location-alert">{task.error}</p>}
        {checks && (
          <ul className="admin-status-list">
            <li>
              <span>{t('location.missingAssets')}</span>
              <State ok={!checks.missingAssets.length} okText="0" badText={String(checks.missingAssets.length)} />
            </li>
            {checks.missingAssets.length > 0 && <li><span className="location-error">{checks.missingAssets.join(' / ')}</span></li>}
            {Object.entries(checks.compositions).map(([difficulty, ok]) => (
              <li key={`composition-${difficulty}`}>
                <span>{t(`location.${difficulty}`)}</span>
                <State ok={ok} okText={valid} badText={invalid} />
              </li>
            ))}
            <li>
              <span>{t('location.daily')}</span>
              <State ok={checks.dailyAvailable} okText={valid} badText={invalid} />
            </li>
            {checks.randomAfterDaily && <>
              <li className="is-note"><span>{t(checks.dailySource === 'fixed' ? 'location.bankFixedDaily' : 'location.bankSimulatedDaily')}</span></li>
              <li className="is-note"><span>{t('location.bankPointCounts', { total: checks.uniquePoints, reserved: checks.reservedPoints })}</span></li>
              {Object.entries(checks.randomAfterDaily).map(([difficulty, ok]) => (
                <li key={`random-${difficulty}`}>
                  <span>{t('location.random')} · {t(`location.${difficulty}`)}</span>
                  <State ok={ok} okText={valid} badText={invalid} />
                </li>
              ))}
              {Object.entries(checks.remainingByTier || {}).map(([tier, count]) => (
                <li key={`remaining-${tier}`}>
                  <span>{t('location.bankRemaining')} · {t(`location.${tier}`)}</span>
                  <strong className="admin-num">{count}</strong>
                </li>
              ))}
            </>}
          </ul>
        )}
      </Panel>
    </div>
  );
}
