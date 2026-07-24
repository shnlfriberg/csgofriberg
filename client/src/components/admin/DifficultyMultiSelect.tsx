import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { difficultyLabel } from '../../utils/difficulty';

interface Props {
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
}

export default function DifficultyMultiSelect({ options, value, onChange }: Props) {
  const { t } = useTranslation();
  const selected = new Set(value);
  const summary = value.length
    ? value.map((key) => difficultyLabel(t, key)).join(', ')
    : t('admin.noDifficultySelected', { defaultValue: '请选择难度' });

  return (
    <details className="difficulty-multi-select">
      <summary className="difficulty-multi-select-trigger">
        <span className="difficulty-multi-select-summary">{summary}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="difficulty-multi-select-menu" role="group" aria-label={t('admin.difficulties')}>
        {options.map((key) => (
          <label key={key} className="difficulty-multi-select-option">
            <input
              type="checkbox"
              checked={selected.has(key)}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...new Set([...value, key])]
                  : value.filter((item) => item !== key);
                onChange(next);
              }}
            />
            <span>{difficultyLabel(t, key)}</span>
            {selected.has(key) && <Check size={14} aria-hidden="true" />}
          </label>
        ))}
      </div>
    </details>
  );
}
