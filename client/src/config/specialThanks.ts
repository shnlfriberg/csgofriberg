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
    image: '/image/wjq.jpg',
    href: 'https://www.douyu.com/6979222',
    analyticsEvent: 'home-special-thanks-wanjiqi',
  },
  {
    name: 'Ciallo Networks | AS202355',
    note: '提供了网站的服务器',
    image: '/image/ciallonetwork.jpg',
    href: 'https://ciallo.ee/',
    analyticsEvent: 'home-special-thanks-ciallo',
  },
];

if (SPECIAL_THANKS.length > 10) {
  throw new Error('SPECIAL_THANKS_LIMIT_EXCEEDED');
}
