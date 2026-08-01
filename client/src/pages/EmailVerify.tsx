import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import Page from '../components/Page';
import { api } from '../api/client';
import { useTranslation } from 'react-i18next';

export default function EmailVerify() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [state, setState] = useState<'loading' | 'success' | 'error'>('loading');
  useEffect(() => {
    const token = params.get('token') || '';
    api.get('/auth/email/verify', { params: { token } })
      .then((response) => setState(response.data?.ok ? 'success' : 'error'))
      .catch(() => setState('error'));
  }, [params]);
  return <Page title={t('emailVerify.title')} icon={<MailCheck size={17} />}>
    <div className="card auth-card" style={{ textAlign: 'center' }}>
      <p>{state === 'loading' ? t('emailVerify.loading') : state === 'success' ? t('emailVerify.success') : t('emailVerify.error')}</p>
      <Link className="btn btn-ghost" to="/">{t('emailVerify.home')}</Link>
    </div>
  </Page>;
}
