import { Trans, useTranslation } from 'react-i18next';
import './difficulty-rules.css';

export default function DifficultyRules() {
  const { t } = useTranslation();
  return <div className="cl-difficulty-rules">
    <p><Trans i18nKey="card.difficultyRules.intro" components={{ strong: <strong /> }} /></p>
    <table>
      <thead><tr>
        <th scope="col">{t('card.difficulty')}</th>
        <th scope="col">{t('card.difficultyRules.steps')}</th>
        <th scope="col">{t('card.difficultyRules.middle')}</th>
      </tr></thead>
      <tbody>{(['easy', 'normal', 'hard'] as const).map(level => <tr key={level}>
        <th scope="row">{t(`card.${level}`)}</th>
        <td>{t(`card.difficultyRules.${level}Steps`)}</td>
        <td>{t(`card.difficultyRules.${level}Middle`)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
