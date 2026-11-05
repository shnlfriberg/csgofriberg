import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, CalendarDays, History, MapPin, UploadCloud, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import '../styles/location.css';

export default function LocationMenu() {
  const { t } = useTranslation();
  const items = [
    { path: 'daily', icon: CalendarDays, title: 'mapDaily', description: 'dailyDescription', accent: '#73dec2' },
    { path: 'random', icon: MapPin, title: 'mapInfinite', description: 'randomDescription', accent: '#ffac54' },
    { path: 'multi', icon: Users, title: 'mapMultiplayer', description: 'multiDescription', accent: '#93a9ff' },
  ];
  return <Page title={t('location.title')} icon={<MapPin size={18} />} className="location-page" actions={<>
    <Link className="btn btn-ghost btn-sm" to="/entertainment"><ArrowLeft size={16} />{t('location.entertainment')}</Link>
    <Link className="btn btn-ghost btn-sm" to="/entertainment/location/history"><History size={16} />{t('location.history')}</Link>
  </>}>
    <section className="location-hero"><span className="location-eyebrow">CS2 // {t('location.title')}</span><h1>{t('location.title')}<MapPin /></h1><p>{t('location.subtitle')}</p></section>
    <div className="location-mode-grid">
      {items.map((item, index) => <Link className="location-mode-card" key={item.path} to={`/entertainment/location/${item.path}`} style={{ '--location-accent': item.accent } as React.CSSProperties}><span className="location-mode-number">0{index + 1} /</span><item.icon size={30} /><h2>{t(`location.${item.title}`)}</h2><p>{t(`location.${item.description}`)}</p><ArrowUpRight className="location-mode-arrow" size={24} /></Link>)}
    </div>
    <div className="location-submission-entry"><Link className="btn btn-ghost btn-sm" to="/entertainment/location/submit"><UploadCloud size={15} />{t('location.submissionTitle')}</Link></div>
    <p className="muted location-footer-note">{t('location.officialGuest')}</p>
  </Page>;
}
