import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { message } from '../../location/api';
import type {
  AdminOverview,
  CaptureDraft,
  Question,
} from '../../location/types';
import LocationBatchCapture from './LocationBatchCapture';
import LocationQuestionDialog from './LocationQuestionDialog';
import LocationBankTransfer from './LocationBankTransfer';
import Operations from './location/Operations';
import MapManager from './location/MapManager';
import QuestionManager from './location/QuestionManager';
import BankChecks from './location/BankChecks';
import DailyManager from './location/DailyManager';
import ManifestImport from './location/ManifestImport';
import SubmissionManager from './location/SubmissionManager';
import { locationAdmin } from './location/api';
import { captureImages, sameCapturePoint } from '@friberg/location-core';
import '../../styles/location.css';
import './location/admin.css';
import { useAdminTab } from './useAdminTab';

type Tab =
  | 'capture'
  | 'submissions'
  | 'questions'
  | 'maps'
  | 'checks'
  | 'daily'
  | 'bankTransfer'
  | 'operations';
type Editor =
  | { kind: 'new' }
  | { kind: 'question'; value: Question; reference?: Question }
  | { kind: 'variant'; value: Question }
  | { kind: 'capture'; value: CaptureDraft; imageId: string };
const tabs: Tab[] = [
  'capture',
  'submissions',
  'questions',
  'maps',
  'checks',
  'daily',
  'bankTransfer',
  'operations',
];

export default function AdminLocation({ visible = true }: { visible?: boolean }) {
  const { t } = useTranslation();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [tab, setTab] = useAdminTab('location', tabs, 'capture');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const active = useRef(visible);
  active.current = visible;
  const reloadVersion = useRef(0);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const reload = useCallback(async () => {
    if (!active.current) return;
    const version = ++reloadVersion.current;
    const overview = await locationAdmin.overview(true, tabRef.current === 'daily');
    if (active.current && version === reloadVersion.current) {
      setData(overview);
      setRevision((value) => value + 1);
      setError('');
    }
  }, []);
  useEffect(() => {
    active.current = visible;
    void reload().catch((error) => active.current && setError(message(error)));
    return () => {
      active.current = false;
    };
  }, [reload, visible]);
  useEffect(() => {
    if (tab === 'daily') void reload().catch(error => setError(message(error)));
  }, [tab, reload]);
  const editQuestion = async (value: Question) => {
    try {
      const detail = await locationAdmin.question(value.id);
      if (active.current) setEditor({ kind: 'question', value: detail.question, reference: detail.reference || undefined });
    } catch (error) { if (active.current) setError(message(error)); }
  };

  const saved = async (_question: Question, next = false) => {
    const completed = editor?.kind === 'capture' ? editor.value : null;
    setEditor(null);
    try {
      await reload();
      if (!next || !completed || !active.current) return;
      const remaining = (await locationAdmin.captures()).filter(
        (point) => captureImages(point).length > 0
      );
      const following =
        remaining.find((point) => point.id === completed.id) ||
        remaining.find((point) => point.batchId === completed.batchId) ||
        remaining[0];
      if (following && active.current)
        setEditor({ kind: 'capture', value: following, imageId: captureImages(following)[0].id });
    } catch (error) {
      if (active.current) setError(message(error));
    }
  };

  return (
    <section className="location-admin location-page">
      <header className="location-admin-heading">
        <h2>{t('location.admin')}</h2>
        <p className="muted">{t('location.adminWorkflowHelp')}</p>
      </header>
      <nav className="location-admin-tabs" aria-label={t('location.admin')}>
        {tabs.map((item) => (
          <button
            className={'btn ' + (tab === item ? '' : 'btn-ghost')}
            aria-current={tab === item ? 'page' : undefined}
            key={item}
            onClick={() => setTab(item)}
          >
            {t('location.' + (item === 'capture' ? 'captureWorkspace' : item))}
          </button>
        ))}
      </nav>
      {error && (
        <div className="location-alert" role="alert">
          {error}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              void reload().catch((error) => setError(message(error)))
            }
          >
            {t('location.retry')}
          </button>
        </div>
      )}
      {!data && !error && <p role="status">{t('location.loadingAdmin')}</p>}
      {data && (
        <>
          <div hidden={tab !== 'capture'}>
            <LocationBatchCapture
              maps={data.maps}
              revision={revision}
              questions={data.questions}
              questionPoints={data.questionPoints}
              active={visible && tab === 'capture'}
              onEdit={(value, imageId) => setEditor({ kind: 'capture', value, imageId })}
            />
          </div>
          {tab === 'questions' && (
            <QuestionManager
              serverPaged
              revision={revision}
              maps={data.maps}
              questions={data.questions}
              onEdit={(value) => void editQuestion(value)}
              onNew={() => setEditor({ kind: 'new' })}
              onChanged={reload}
              onAddVariant={(value) => setEditor({ kind: 'variant', value })}
            />
          )}
          {tab === 'submissions' && <SubmissionManager maps={data.maps} onChanged={reload} />}
          {tab === 'maps' && data.maps.length > 0 && (
            <MapManager maps={data.maps} onChanged={reload} />
          )}
          {tab === 'operations' && <Operations active={visible} />}
          {tab === 'checks' && <BankChecks data={data} />}
          {tab === 'daily' && (
            <DailyManager days={data.daily} onChanged={reload} />
          )}
          {tab === 'bankTransfer' && (
            <>
              <LocationBankTransfer onImported={reload} />
              <ManifestImport onChanged={reload} />
            </>
          )}
          {editor && (
            <LocationQuestionDialog
              key={editor.kind === 'new' ? 'new' : editor.kind === 'capture' ? `${editor.value.id}:${editor.imageId}` : `${editor.kind}:${editor.value.id}`}
              maps={data.maps}
              question={editor.kind === 'question' ? editor.value : null}
              captureDraft={editor.kind === 'capture' ? editor.value : null}
              captureImageId={editor.kind === 'capture' ? editor.imageId : undefined}
              pointReference={editor.kind === 'variant' ? editor.value : editor.kind === 'question'
                ? editor.reference
                : undefined}
              onClose={() => setEditor(null)}
              onSaved={(question, next) => void saved(question, next)}
            />
          )}
        </>
      )}
    </section>
  );
}
