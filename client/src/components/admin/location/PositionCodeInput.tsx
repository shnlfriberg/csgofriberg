import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  parseCapturePosition,
  parseWorldPosition,
  type CapturePosition,
  type WorldPosition,
} from '../../../location/positionCode';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onParsed: (value: WorldPosition & Partial<CapturePosition>) => void;
  requireAngles?: boolean;
  disabled?: boolean;
  help?: string;
}

export default function PositionCodeInput({
  value,
  onChange,
  onParsed,
  requireAngles = false,
  disabled,
  help,
}: Props) {
  const { t } = useTranslation();
  const [showError, setShowError] = useState(false);
  const parse = requireAngles ? parseCapturePosition : parseWorldPosition;
  const parsed = parse(value);
  const invalid = Boolean(value.trim()) && !parsed;
  const apply = () => {
    if (parsed) {
      onParsed(parsed);
      setShowError(false);
    } else setShowError(true);
  };
  return (
    <section className="location-position-paste">
      <label>
        {t('location.positionCodeLabel')}
        <textarea
          className="input"
          rows={3}
          value={value}
          disabled={disabled}
          placeholder="setpos_exact X Y Z;setang_exact PITCH YAW ROLL"
          aria-invalid={showError && invalid ? true : undefined}
          onChange={(event) => {
            const code = event.target.value;
            onChange(code);
            setShowError(false);
            const next = parse(code);
            if (next) onParsed(next);
          }}
          onBlur={() => setShowError(Boolean(value.trim()) && !parsed)}
        />
      </label>
      <p className="muted">
        {help || t(
          requireAngles
            ? 'location.questionCodeHelp'
            : 'location.calibrationCodeHelp'
        )}
      </p>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={disabled || !value.trim()}
        onClick={apply}
      >
        {t(
          requireAngles
            ? 'location.applyPosition'
            : 'location.fillWorldPosition'
        )}
      </button>
      {parsed && (
        <p className="muted" role="status">
          {t('location.positionCodeParsed', { x: parsed.x, y: parsed.y })}
        </p>
      )}
      {showError && invalid && (
        <p className="location-error" role="alert">
          {t(
            requireAngles
              ? 'location.positionParseFailed'
              : 'location.worldPositionParseFailed'
          )}
        </p>
      )}
    </section>
  );
}
