import CardLinkIcon from '../components/CardLinkIcon';
import { Link } from 'react-router-dom';
import { MapPin, Soup, ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import '../styles/location.css';
export default function Entertainment() {
  const { t } = useTranslation();
  const items = [
    { path: '/entertainment/location', icon: MapPin, title: 'location.title', description: 'location.subtitle', code: '01', accent: '#ffac54' },
    { path: '/turtle-soup', icon: Soup, title: 'soup.title', description: 'soup.description', code: '02', accent: '#cf9bea' },
    { path: '/entertainment/card-link', icon: CardLinkIcon, title: 'card.title', description: 'card.description', code: '03', accent: '#70d5be' },
  ];
  return <Page title={t('location.entertainment')} className="location-page">
    <section className="location-hero"><span className="location-eyebrow">CS2 // {t('location.entertainment')}</span><h1>{t('location.entertainment')}</h1><p>{t('location.entertainmentHeroSubtitle')}</p><div className="location-hero-meta"><span>{t('location.mapModes')}</span><span>{t('location.soupMode')}</span></div></section>
    <div className="location-mode-grid">
      {items.map((item) => <Link className="location-mode-card" key={item.path} to={item.path} style={{ '--location-accent': item.accent } as React.CSSProperties}><span className="location-mode-number">{item.code} /</span><item.icon size={30} /><h2>{t(item.title)}</h2><p>{t(item.description)}</p><ArrowUpRight className="location-mode-arrow" size={24} /></Link>)}
    </div>
    <p className="muted location-footer-note">{t('location.officialGuest')}</p></Page>;
}
