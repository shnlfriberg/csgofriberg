import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ConnectionSlot from './ConnectionSlot';
import type { View } from './types';

const edgeKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

/** Both the result dialog and the board use the same frozen-route evidence. */
export default function SolutionRoute({ path, evidence, label }: {
  path: number[]; evidence: View['evidence']; label: (id: number) => string;
}) {
  const { t } = useTranslation();
  const edges = useMemo(() => new Map(evidence.map(edge => [edgeKey(edge.a, edge.b), edge.evidence])), [evidence]);
  return <p className="cl-solution-route" aria-label={t('card.solution')}>
    {path.map((id, index) => <Fragment key={`${index}:${id}`}>
      {index > 0 && <ConnectionSlot type="button" className="cl-solution-arrow"
        first={label(path[index - 1])} second={label(id)}
        evidence={edges.get(edgeKey(path[index - 1], id)) ?? []}
        aria-label={`${label(path[index - 1])} ↔ ${label(id)} · ${t('card.evidence')}`}>→</ConnectionSlot>}
      <span>{label(id)}</span>
    </Fragment>)}
  </p>;
}
