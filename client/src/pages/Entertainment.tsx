import CardLinkIcon from '../components/CardLinkIcon';
import { MapPin, Soup } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import MenuCard from '../components/MenuCard';
import '../styles/location.css';
export default function Entertainment() {
  const { t } = useTranslation();
  const items = [
    { path: '/entertainment/location', icon: MapPin, title: 'location.title', description: 'location.subtitle', accent: '#ffb64e' },
    { path: '/turtle-soup', icon: Soup, title: 'soup.title', description: 'soup.description', accent: '#ba95ed' },
    { path: '/entertainment/card-link', icon: CardLinkIcon, title: 'card.title', description: 'card.description', accent: '#74e38f' },
  ];
  return <Page title={t('location.entertainment')} className="location-page entertainment-page">
    <p className="muted single-lobby-subtitle">{t('location.entertainmentHeroSubtitle')}</p>
    <div className="menu-grid ent-menu-grid">
      {items.map((item) => <MenuCard key={item.path} to={item.path} className="location-mode-card" icon={<item.icon size={22} />}
        label={t(item.title)} description={t(item.description)} color={item.accent} />)}
    </div>
    <p className="muted location-footer-note">{t('location.officialGuest')}</p></Page>;
}
