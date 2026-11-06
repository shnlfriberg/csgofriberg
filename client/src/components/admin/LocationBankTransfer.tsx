import { useRef, useState } from 'react';
import { Archive, Download, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, message } from '../../location/api';

interface Preview {
  token: string;
  fingerprint: string;
  expiresAt: number;
  exportedAt: string;
  questions: number;
  assets: number;
  mapChanges: number;
  added: number;
  updated: number;
  skipped: number;
  captureDrafts?: number;
  captureChanges?: number;
  conflicts: Array<{ id: string; code: string }>;
  canImport: boolean;
}
export default function LocationBankTransfer({
  onImported,
}: {
  onImported: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [updateQuestions, setUpdateQuestions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filename, setFilename] = useState('');
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      const data = (e as { response?: { data?: unknown } })?.response?.data;
      if (data instanceof Blob) {
        try {
          setError(message(JSON.parse(await data.text())));
        } catch {
          setError(message(e));
        }
      } else setError(message(e));
    } finally {
      setBusy(false);
      setPhase('');
    }
  };
  const exportPackage = async () => {
    setPhase('bankExporting');
    const response = await api.get<Blob>('/admin/location/bank/export', {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(response.data);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `location-bank-${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setNotice(t('location.bankExported'));
  };
  const uploadPackage = async (file?: File) => {
    if (!file) return;
    if (file.size > 1024 * 1024 * 1024) {
      setError(t('location.errors.LOCATION_BANK_TOO_LARGE'));
      return;
    }
    await run(async () => {
      setPreview(null);
      setFilename(file.name);
      setUpdateQuestions(false);
      setProgress(0);
      setPhase('bankUploading');
      const response = await api.post<Preview>(
        '/admin/location/bank/preview',
        file,
        {
          headers: { 'Content-Type': 'application/zip' },
          onUploadProgress: (event) => {
            const value = Math.min(
              100,
              Math.round((event.loaded / (event.total || file.size)) * 100)
            );
            setProgress(value);
            if (value === 100) setPhase('bankChecking');
          },
        }
      );
      setPreview(response.data);
    });
  };
  const recheck = async (update: boolean) => {
    if (!preview) return;
    setPhase('bankChecking');
    const response = await api.post<Preview>('/admin/location/bank/recheck', {
      token: preview.token,
      updateQuestions: update,
    });
    setUpdateQuestions(update);
    setPreview(response.data);
  };
  const apply = async () => {
    if (!preview) return;
    setPhase('bankImporting');
    const response = await api.post('/admin/location/bank/import', {
      token: preview.token,
      fingerprint: preview.fingerprint,
      updateQuestions,
    });
    setPreview(null);
    setNotice(String(t('location.bankImported', response.data)));
    await onImported();
  };
  return (
    <section
      className="admin-panel location-bank-transfer"
      aria-label={t('location.bankTransfer')}
    >
      <header className="admin-panel-head">
        <div className="admin-panel-title">
          <h2><Archive size={18} aria-hidden="true" />{t('location.bankTransfer')}</h2>
          <p>{t('location.bankStorageHelp')}</p>
        </div>
      </header>
      <div className="admin-panel-body">
      <p className="admin-help">{t('location.bankPackageHelp')}</p>
      <div className="location-admin-actions">
        <button
          className="btn"
          disabled={busy}
          onClick={() => void run(exportPackage)}
        >
          <Download size={16} />
          {t('location.bankExport')}
        </button>
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={16} />
          {t('location.bankImport')}
        </button>
        <span className="muted">{t('location.bankLimit')}</span>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".zip,application/zip"
        hidden
        aria-label={t('location.bankImport')}
        disabled={busy}
        onChange={(event) => {
          void uploadPackage(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      {busy && (
        <p role="status">
          {t(`location.${phase || 'bankChecking'}`)}
          {phase === 'bankUploading' && ` ${progress}%`}
        </p>
      )}
      {error && (
        <div className="location-alert" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {preview && (
        <div className="location-bank-preview">
          <h4>{t('location.bankPreview')}</h4>
          <p>
            {filename} · {t('location.bankExportTime')}:{' '}
            {new Intl.DateTimeFormat(undefined, {
              timeZone: 'Asia/Shanghai',
              dateStyle: 'short',
              timeStyle: 'short',
            }).format(new Date(preview.exportedAt))}
          </p>
          <p>
            {t(
              'location.bankSummary',
              preview as unknown as Record<string, unknown>
            )}
          </p>
          <p>{t('location.bankMapHelp')}</p>
          <p>{t('location.bankStatusHelp')}</p>
          {!!preview.captureDrafts && (
            <p>
              {t('location.captureBankSummary', {
                count: preview.captureDrafts,
                changes: preview.captureChanges,
              })}
            </p>
          )}
          <label>
            <input
              type="checkbox"
              checked={updateQuestions}
              disabled={busy}
              onChange={(event) =>
                void run(() => recheck(event.target.checked))
              }
            />
            {t('location.bankUpdateExisting')}
          </label>
          {!!preview.conflicts.length && (
            <div role="alert">
              <strong>
                {t('location.bankConflicts', {
                  count: preview.conflicts.length,
                })}
              </strong>
              <ul>
                {preview.conflicts.slice(0, 20).map((item) => (
                  <li key={item.id}>
                    {item.id}: {message({ code: item.code })}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="location-admin-actions">
            <button
              className="btn"
              disabled={busy || !preview.canImport}
              onClick={() => void run(apply)}
            >
              {t('location.bankApply')}
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void run(() => recheck(updateQuestions))}
            >
              {t('location.bankRecheck')}
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      </div>
    </section>
  );
}
