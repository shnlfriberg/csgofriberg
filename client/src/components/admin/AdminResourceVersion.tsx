import { useState } from 'react';
import { RadioTower } from 'lucide-react';
import { api, errMsg } from '../../api/client';
import { RESOURCE_VERSION } from '../../resourceVersion';
import { useConfirm } from '../ConfirmDialog';
import { toast } from '../Toast';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../../i18n';
import { BUILD_INFO, type BuildInfo } from '../../buildInfo';
import { BuildVersion } from '../VersionFooter';

export default function AdminResourceVersion() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [submitting, setSubmitting] = useState(false);
  const [serverBuild, setServerBuild] = useState<BuildInfo | null>(null);
  const [buildError, setBuildError] = useState(false);
  const [loadingBuild, setLoadingBuild] = useState(false);

  const loadServerBuild = async () => {
    setLoadingBuild(true);
    setBuildError(false);
    try {
      const response = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error('HEALTH_UNAVAILABLE');
      const health = await response.json();
      if (!health.version?.version) throw new Error('BUILD_INFO_UNAVAILABLE');
      setServerBuild(health.version);
    } catch { setBuildError(true); }
    finally { setLoadingBuild(false); }
  };

  const broadcast = async () => {
    const accepted = await confirm({
      title: t('admin.broadcastTitle'),
      message: t('admin.broadcastMessage'),
      confirmLabel: t('admin.broadcastConfirm'),
    });
    if (!accepted) return;

    setSubmitting(true);
    try {
      await api.post('/admin/resource-version/broadcast', { version: RESOURCE_VERSION });
      toast.success(t('admin.broadcastSuccess'));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card admin-resource-card admin-centered-card">
      <div className="admin-resource-heading">
        <div>
          <h3>{t('admin.resourcesTitle')}</h3>
          <p className="muted">{t('admin.currentVersion')}</p>
        </div>
        <code className="resource-version-value">
          {new Date(Number(RESOURCE_VERSION)).toLocaleString(currentLocale())}
        </code>
      </div>
      <details className="admin-build-details" onToggle={(event) => {
        if (event.currentTarget.open) void loadServerBuild();
      }}>
        <summary>{t('admin.buildDetails')}</summary>
        <p>{t('admin.frontendBuild')}: <BuildVersion /> · {new Date(BUILD_INFO.builtAt).toLocaleString(currentLocale())}</p>
        <p>{t('admin.backendBuild')}: {loadingBuild ? '…' : buildError ? t('admin.buildUnavailable') : serverBuild && <>
          <BuildVersion info={serverBuild} /> · {new Date(serverBuild.builtAt).toLocaleString(currentLocale())}
        </>}</p>
      </details>
      <button className="btn btn-green" type="button" disabled={submitting} onClick={() => void broadcast()}>
        <RadioTower size={17} />
        {submitting ? t('admin.broadcasting') : t('admin.broadcast')}
      </button>
    </div>
  );
}
