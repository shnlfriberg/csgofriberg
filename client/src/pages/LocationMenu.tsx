import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarDays, MapPin, UploadCloud, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import MenuCard from '../components/MenuCard';
import '../styles/location.css';
import { LOCATION_SUBMISSIONS_ENABLED } from '../config/features';

export default function LocationMenu() {
  const { t } = useTranslation();
  const items = [
    { path: 'daily', icon: CalendarDays, title: 'mapDaily', description: 'dailyDescription', accent: '#f25f5c' },
    { path: 'random', icon: MapPin, title: 'mapInfinite', description: 'randomDescription', accent: '#74e38f' },
    { path: 'multi', icon: Users, title: 'mapMultiplayer', description: 'multiDescription', accent: '#ffb64e' },
  ];
  return <Page title={t('location.title')} icon={<MapPin size={18} />} className="location-page ent-page" actions={
    <Link className="btn btn-ghost btn-sm" to="/entertainment"><ArrowLeft size={16} aria-hidden="true" /><span className="btn-text">{t('location.entertainment')}</span></Link>
  }>
    <p className="muted single-lobby-subtitle">{t('location.subtitle')}</p>
    <div className="menu-grid ent-menu-grid">
      {items.map((item) => <MenuCard key={item.path} to={`/entertainment/location/${item.path}`} className="location-mode-card"
        icon={<item.icon size={22} />} label={t(`location.${item.title}`)} description={t(`location.${item.description}`)} color={item.accent} />)}
    </div>
    {LOCATION_SUBMISSIONS_ENABLED && <div className="location-submission-entry"><Link className="btn btn-ghost btn-sm" to="/entertainment/location/submit"><UploadCloud size={15} aria-hidden="true" /><span>{t('location.submissionTitle')}</span></Link></div>}
    <p className="muted location-footer-note">{t('location.officialGuest')}</p>
  </Page>;
}
