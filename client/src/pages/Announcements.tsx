import { useEffect, useState } from 'react';
import { Megaphone } from 'lucide-react';
import Page from '../components/Page';
import { api, errMsg } from '../api/client';
import { toast } from '../components/Toast';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../i18n';

interface Announcement {
  id: number;
  title: string;
  content: string;
  created_at: string;
}

export default function Announcements() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Announcement[]>('/announcements')
      .then((res) => setItems(res.data))
      .catch((err) => toast.error(errMsg(err)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Page title={t('announcements.title')} icon={<Megaphone size={17} />}>
      {loading && (
        <div className="card" role="status" aria-label={t('common.loading')}>
          <div className="table-skeleton"><i /><i /><i /></div>
        </div>
      )}
      {!loading && !items.length && <p className="muted">{t('announcements.empty')}</p>}
      {items.map((a) => (
        <div key={a.id} className="card">
          <h3 style={{ marginTop: 0 }}>{a.title}</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{a.content}</p>
          <p className="muted">{new Date(a.created_at).toLocaleString(currentLocale())}</p>
        </div>
      ))}
    </Page>
  );
}
