import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Move, Scan } from 'lucide-react';
import Radar, { type RadarSelection } from '../../../location/Radar';
import type { MapDefinition } from '../../../location/types';

export default function QuestionAreaFilter({ map, floorId, selection, onChange }: {
  map: MapDefinition;
  floorId: string;
  selection: RadarSelection | null;
  onChange: (selection: RadarSelection | null) => void;
}) {
  const { t } = useTranslation();
  const [selecting, setSelecting] = useState(true);
  return <section className="location-question-area" aria-label={t('location.questionAreaFilter')}>
    <div className="location-question-area-heading">
      <h3>{t('location.questionAreaFilter')}</h3>
      <div className="location-question-area-tools">
        <button type="button" className={`btn ${selecting ? '' : 'btn-ghost'}`}
          aria-pressed={selecting} onClick={() => setSelecting(true)}>
          <Scan size={16} aria-hidden="true" />{t('location.selectQuestionArea')}
        </button>
        <button type="button" className={`btn ${selecting ? 'btn-ghost' : ''}`}
          aria-pressed={!selecting} onClick={() => setSelecting(false)}>
          <Move size={16} aria-hidden="true" />{t('location.panQuestionRadar')}
        </button>
        <button type="button" className="btn btn-ghost" disabled={!selection} onClick={() => onChange(null)}>
          {t('location.clearQuestionArea')}
        </button>
      </div>
    </div>
    <Radar map={map} floorId={floorId} selection={selection}
      onSelectArea={selecting ? onChange : undefined}
      hint={t(selecting ? 'location.questionAreaHelp' : 'location.questionAreaPanHelp')} />
  </section>;
}
