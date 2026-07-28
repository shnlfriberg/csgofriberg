import { ArrowUp, ArrowDown } from 'lucide-react';
import { memo } from 'react';
import {
  AttributeFeedback,
  HiddenAttributeFeedback,
  MultiplayerGuessFeedback,
} from '../types';
import { playerRoleLabel } from '../utils/playerRoles';
import { useTranslation } from 'react-i18next';

function Cell({
  attr,
  label,
  bool,
  format,
}: {
  attr: AttributeFeedback | HiddenAttributeFeedback;
  label: string;
  bool?: boolean;
  format?: (value: string) => string;
}) {
  const { t } = useTranslation();
  if (!('value' in attr)) {
    return (
      <td className={`${attr.level} masked-cell`} data-label={label}>
        {attr.hint && attr.level !== 'correct' && (
          <span className="dir">
            {attr.hint === 'higher' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
          </span>
        )}
      </td>
    );
  }
  const text =
    typeof attr.value === 'boolean' || bool
      ? attr.value
        ? t('common.active')
        : t('common.retired')
      : format
        ? format(String(attr.value))
        : String(attr.value);
  return (
    <td className={attr.level} data-label={label}>
      {text}
      {attr.hint && attr.level !== 'correct' && (
        <span className="dir">
          {attr.hint === 'higher' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
        </span>
      )}
    </td>
  );
}

/** 猜测反馈表:原版 game-table 布局,每行一次猜测的逐属性对比 */
function GuessBoard({ guesses }: { guesses: MultiplayerGuessFeedback[] }) {
  const { t } = useTranslation();
  const columns = [
    t('guess.columns.nickname'),
    t('guess.columns.team'),
    t('guess.columns.nationality'),
    t('guess.columns.age'),
    t('guess.columns.role'),
    t('guess.columns.majorChampionships'),
    t('guess.columns.majorAppearances'),
    t('guess.columns.status'),
  ];
  return (
    <div className="game-table-wrap">
      <table className="game-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {guesses.map((g, i) => (
            <tr
              key={'hidden' in g ? `hidden-${i}` : `${g.playerId}-${i}`}
              className={`${i === guesses.length - 1 ? 'row-latest' : ''} ${g.correct ? 'row-correct' : ''}`}
            >
              <td
                className={`name ${g.correct ? 'correct' : ''} ${'hidden' in g ? 'masked-cell' : ''}`}
                data-label={columns[0]}
              >
                {'hidden' in g ? null : g.nickname}
              </td>
              <Cell attr={g.attributes.team} label={columns[1]} />
              <Cell attr={g.attributes.nationality} label={columns[2]} />
              <Cell attr={g.attributes.age} label={columns[3]} />
              <Cell attr={g.attributes.role} label={columns[4]} format={playerRoleLabel} />
              <Cell attr={g.attributes.majorChampionships} label={columns[5]} />
              <Cell attr={g.attributes.majorAppearances} label={columns[6]} />
              <Cell attr={g.attributes.isActive} label={columns[7]} bool />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default memo(GuessBoard);
