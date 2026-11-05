import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Radar from '../../../location/Radar';
import type { Guess, MapDefinition } from '../../../location/types';
import { locationAdmin } from './api';
import { useAdminTask } from './useAdminTask';
import PositionCodeInput from './PositionCodeInput';
import { parseWorldPosition } from '../../../location/positionCode';
import {
  fitCalibration,
  inspectCalibration,
} from '@friberg/location-core';

export default function MapManager({
  maps,
  onChanged,
}: {
  maps: MapDefinition[];
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const task = useAdminTask();
  const [draft, setDraft] = useState(maps[0]);
  const [floor, setFloor] = useState(draft.floors[0].id);
  const [pin, setPin] = useState<Guess | null>(null);
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [positionCode, setPositionCode] = useState('');
  const [advanced, setAdvanced] = useState('');
  const choose = (map: MapDefinition) => {
    setDraft(map);
    setFloor(map.floors[0].id);
    setPin(null);
    setX('');
    setY('');
    setPositionCode('');
    setAdvanced('');
  };
  const { fitted, calibrated, report } = useMemo(() => {
    const fitted = fitCalibration(draft);
    const calibrated = fitted
      ? { ...draft, calibration: { ...draft.calibration, ...fitted } }
      : draft;
    return { fitted, calibrated, report: inspectCalibration(calibrated) };
  }, [draft]);
  return (
    <div className="location-admin-grid">
      <div className="location-admin-list">
        {maps.map((map) => (
          <button
            className={`btn ${map.id === draft.id ? '' : 'btn-ghost'}`}
            key={map.id}
            disabled={task.busy}
            onClick={() => choose(map)}
          >
            {map.name} · {map.enabled ? '●' : '○'}
          </button>
        ))}
      </div>
      <div className="location-admin-editor">
        {task.error && (
          <p className="location-alert" role="alert">
            {task.error}
          </p>
        )}
        {task.notice && <p role="status">{task.notice}</p>}
        <div className="location-admin-map-layout">
          <div className="location-admin-map-preview">
            <Radar
              map={calibrated}
              floorId={floor}
              guess={pin}
              onChange={task.busy ? undefined : setPin}
              markers={draft.calibration.points.map((point, index) => ({
                ...point,
                mapId: draft.id,
                id: `calibration-${index}`,
                label: String(index + 1),
                ariaLabel: t('location.calibrationMarker', { number: index + 1 }),
              }))}
            />
          </div>
          <fieldset className="location-admin-map-tools" disabled={task.busy}>
            <legend>
              {draft.name} · v{draft.version}
            </legend>
            <label className="location-admin-enabled">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              {t('location.enabled')}
            </label>
            <h3>{t('location.calibration')}</h3>
            <p className="muted location-admin-tool-help">
              {t('location.calibrationAutoHelp')}
            </p>
            <div className="location-floor-options">
              {draft.floors.map((item) => (
                <button
                  className={`btn ${floor === item.id ? '' : 'btn-ghost'}`}
                  key={item.id}
                  onClick={() => {
                    setFloor(item.id);
                    setPin(null);
                    setPositionCode('');
                    setX('');
                    setY('');
                  }}
                >
                  {t(`location.floor.${item.id}`, { defaultValue: item.name })}
                </button>
              ))}
            </div>
            <div className="location-calibration-status" role="status">
              <strong>
                {t(
                  !fitted
                    ? draft.calibration.points.length < 3
                      ? 'location.calibrationNeedPoints'
                      : 'location.calibrationCannotFit'
                    : report.valid
                      ? 'location.calibrationReady'
                      : 'location.calibrationNeedsReview'
                )}
              </strong>
              {fitted && (
                <p>
                  {t('location.calibrationMaxError', {
                    error: (Math.max(...report.points.map((p) => p.error)) * 100).toFixed(3),
                  })}
                </p>
              )}
              {report.floors.map((item) => (
                <p key={item.floorId}>
                  {t(`location.floor.${item.floorId}`, { defaultValue: item.floorId })}
                  {' · '}
                  {t('location.calibrationFloorPoints', { count: item.count })}
                  {' · '}
                  {t(item.ready ? 'location.calibrationSpreadReady' : 'location.calibrationSpreadNeeded')}
                </p>
              ))}
            </div>
            <PositionCodeInput
              value={positionCode}
              disabled={task.busy}
              onChange={(value) => {
                setPositionCode(value);
                setX('');
                setY('');
              }}
              onParsed={(value) => {
                setX(value.x);
                setY(value.y);
              }}
            />
            <div className="location-form-grid">
              <label>
                {t('location.worldX')}
                <input
                  className="input"
                  type="number"
                  value={x}
                  step="any"
                  onChange={(e) => {
                    setPositionCode('');
                    setX(e.target.value);
                  }}
                />
              </label>
              <label>
                {t('location.worldY')}
                <input
                  className="input"
                  type="number"
                  value={y}
                  step="any"
                  onChange={(e) => {
                    setPositionCode('');
                    setY(e.target.value);
                  }}
                />
              </label>
            </div>
            <button
              className="btn"
              disabled={
                !pin ||
                x === '' ||
                y === '' ||
                !Number.isFinite(Number(x)) ||
                !Number.isFinite(Number(y)) ||
                Boolean(
                  positionCode.trim() && !parseWorldPosition(positionCode)
                )
              }
              onClick={() => {
                if (!pin) return;
                setDraft({
                  ...draft,
                  calibration: {
                    ...draft.calibration,
                    points: [
                      ...draft.calibration.points,
                      {
                        x: Number(x),
                        y: Number(y),
                        u: pin.u,
                        v: pin.v,
                        floorId: floor,
                      },
                    ],
                  },
                });
                setPin(null);
                setX('');
                setY('');
                setPositionCode('');
              }}
            >
              {t('location.addCalibration')}
            </button>
            <details className="location-radar-parameters">
              <summary>{t('location.calibrationComputedParameters')}</summary>
              {fitted ? (
                <dl className="location-calibration-parameters">
                  {(['posX', 'posY', 'scale'] as const).map((key) => (
                    <div key={key}>
                      <dt>{t(`location.${key}`)}</dt>
                      <dd>{fitted[key].toFixed(6)}</dd>
                    </div>
                  ))}
                </dl>
              ) : <p className="muted">{t('location.calibrationNeedPoints')}</p>}
            </details>
            <div className="location-calibration-points">
              {draft.calibration.points.map((point, index) => (
                <div key={index}>
                  <span>
                    #{index + 1}{' · '}
                    {t(`location.floor.${point.floorId}`, {
                      defaultValue: point.floorId,
                    })}{' '}
                    · {point.x}, {point.y}
                    <small className={fitted && !report.points[index].valid ? 'location-error' : 'muted'}>
                      {fitted
                        ? t('location.calibrationPointError', {
                            error: (report.points[index].error * 100).toFixed(3),
                            pixels: report.points[index].pixels.toFixed(2),
                          })
                        : t('location.calibrationPending')}
                    </small>
                  </span>
                  <button
                    className="btn btn-ghost btn-sm"
                    aria-label={t('location.removeCalibration', {
                      number: index + 1,
                    })}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        calibration: {
                          ...draft.calibration,
                          points: draft.calibration.points.filter(
                            (_, i) => i !== index
                          ),
                        },
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </fieldset>
        </div>
        <details
          className="location-position-paste"
          onToggle={(e) => {
            if (e.currentTarget.open)
              setAdvanced(JSON.stringify(calibrated, null, 2));
          }}
        >
          <summary>{t('location.advancedMapConfig')}</summary>
          <p className="muted">{t('location.calibrationAdvancedHelp')}</p>
          <label>
            {t('location.mapConfig')}
            <textarea
              className="input"
              value={advanced}
              disabled={task.busy}
              onChange={(e) => setAdvanced(e.target.value)}
            />
          </label>
          <button
            className="btn btn-ghost"
            disabled={task.busy}
            onClick={() =>
              void task.run(async () => {
                const value: MapDefinition = JSON.parse(advanced);
                if (value.id !== draft.id)
                  throw new Error(t('location.invalidMapConfig'));
                const saved = await locationAdmin.saveMap(value);
                setDraft(saved);
                setFloor(saved.floors[0].id);
                await onChanged();
                task.setNotice(t('location.saved'));
              })
            }
          >
            {t('location.applyMapConfig')}
          </button>
        </details>
        <p className="muted">{t('location.mapVersionHelp')}</p>
        <button
          className="btn"
          disabled={task.busy}
          onClick={() =>
            void task.run(async () => {
              const saved = await locationAdmin.saveMap(calibrated);
              setDraft(saved);
              await onChanged();
              task.setNotice(t('location.saved'));
            })
          }
        >
          {t('location.save')}
        </button>
      </div>
    </div>
  );
}
