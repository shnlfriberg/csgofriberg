import { useTranslation } from 'react-i18next';

export default function RematchVote({ me, votes, eligible, busy, onVote, labels }: {
  me: string; votes?: { acceptedKeys: string[]; requiredKeys: string[] };
  eligible: string[]; busy: boolean; onVote: (wanted: boolean) => void;
  labels?: { start: string; cancel: string };
}) {
  const { t } = useTranslation();
  const required = votes?.requiredKeys ?? eligible;
  const wanted = votes?.acceptedKeys.includes(me) ?? false;
  if (!eligible.includes(me)) return null;
  return <div className="rematch-vote">
    <p role="status">{t('multi.rematchWantedProgress', { accepted: votes?.acceptedKeys.length ?? 0, required: required.length })}</p>
    <button className={wanted ? 'btn btn-ghost' : 'btn btn-success'} disabled={busy || (eligible.length < 2 && !wanted)}
      onClick={() => onVote(!wanted)}>{labels ? (wanted ? labels.cancel : labels.start) : t(wanted ? 'multi.cancelRematchWant' : 'multi.wantRematch')}</button>
  </div>;
}
