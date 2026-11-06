import { FolderUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { message } from '../../../location/api';
import { Panel } from '../ui';
import { importQuestionManifest } from './api';
import { useAdminTask } from './useAdminTask';

export default function ManifestImport({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const task = useAdminTask();
  return (
    <Panel id="location-manifest-title" title={t('location.importJson')} description={t('location.manifestHelp')}>
      <label className="admin-file-pick">
        <input
          type="file"
          multiple
          disabled={task.busy}
          aria-label={t('location.importJson')}
          {...{ webkitdirectory: '' }}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            if (files.length)
              void task.run(async () => {
                const results = await importQuestionManifest(files);
                const failed = results.filter((row) => !row.ok);
                task.setNotice(
                  t('location.importResult', {
                    ok: results.length - failed.length,
                    failed: failed.length,
                  })
                );
                task.setError(
                  failed
                    .map((row) =>
                      !row.ok
                        ? `${row.id || '—'}: ${message({ code: row.code })}`
                        : ''
                    )
                    .join('\n')
                );
                await onChanged();
              });
          }}
        />
        <span className="btn btn-ghost btn-sm"><FolderUp size={15} aria-hidden="true" />{t('adminUi.chooseFolder')}</span>
        <span className="admin-file-name">manifest.json</span>
      </label>
      {task.error && (
        <p className="location-alert" role="alert">
          {task.error}
        </p>
      )}
      {task.notice && <p role="status" className="admin-help">{task.notice}</p>}
    </Panel>
  );
}
