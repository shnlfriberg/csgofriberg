import ouseTonaeImage from '../assets/OuseTonae.jpg';
import wanjiqiImage from '../assets/wjq.jpg';

export interface SpecialThanksItem {
  name: string;
  note?: string;
  image: string;
  href: string;
  analyticsEvent: string;
}

export const SPECIAL_THANKS: SpecialThanksItem[] = [
  {
    name: '玩机器丶Machine',
    note: '对网站的冠名赞助',
    image: wanjiqiImage,
    href: 'https://www.douyu.com/6979222',
    analyticsEvent: 'home-special-thanks-wanjiqi',
  },
  {
    name: 'OuseTonae | AS202355 Ciallo Networks LTD',
    note: '提供了网站的服务器',
    image: ouseTonaeImage,
    href: 'https://ciallo.ee/',
    analyticsEvent: 'home-special-thanks-ciallo',
  },
];

if (SPECIAL_THANKS.length > 10) {
  throw new Error('SPECIAL_THANKS_LIMIT_EXCEEDED');
}
