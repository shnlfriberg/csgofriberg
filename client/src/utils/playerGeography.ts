import type { TFunction } from 'i18next';

export interface GeographyOption {
  value: string;
  key: string;
}

export const COUNTRY_OPTIONS: GeographyOption[] = [
  { value: '阿根廷', key: 'argentina' },
  { value: '阿塞拜疆', key: 'azerbaijan' },
  { value: '爱沙尼亚', key: 'estonia' },
  { value: '澳大利亚', key: 'australia' },
  { value: '巴西', key: 'brazil' },
  { value: '白俄罗斯', key: 'belarus' },
  { value: '保加利亚', key: 'bulgaria' },
  { value: '北马其顿', key: 'northMacedonia' },
  { value: '比利时', key: 'belgium' },
  { value: '波黑', key: 'bosniaHerzegovina' },
  { value: '波兰', key: 'poland' },
  { value: '丹麦', key: 'denmark' },
  { value: '德国', key: 'germany' },
  { value: '俄罗斯', key: 'russia' },
  { value: '法国', key: 'france' },
  { value: '芬兰', key: 'finland' },
  { value: '哈萨克斯坦', key: 'kazakhstan' },
  { value: '荷兰', key: 'netherlands' },
  { value: '黑山', key: 'montenegro' },
  { value: '加拿大', key: 'canada' },
  { value: '捷克', key: 'czechia' },
  { value: '拉脱维亚', key: 'latvia' },
  { value: '立陶宛', key: 'lithuania' },
  { value: '罗马尼亚', key: 'romania' },
  { value: '马来西亚', key: 'malaysia' },
  { value: '美国', key: 'unitedStates' },
  { value: '蒙古', key: 'mongolia' },
  { value: '南非', key: 'southAfrica' },
  { value: '挪威', key: 'norway' },
  { value: '葡萄牙', key: 'portugal' },
  { value: '瑞典', key: 'sweden' },
  { value: '瑞士', key: 'switzerland' },
  { value: '塞尔维亚', key: 'serbia' },
  { value: '塞尔维亚科索沃', key: 'kosovo' },
  { value: '斯洛伐克', key: 'slovakia' },
  { value: '土耳其', key: 'turkey' },
  { value: '危地马拉', key: 'guatemala' },
  { value: '乌克兰', key: 'ukraine' },
  { value: '乌拉圭', key: 'uruguay' },
  { value: '乌兹别克斯坦', key: 'uzbekistan' },
  { value: '西班牙', key: 'spain' },
  { value: '新西兰', key: 'newZealand' },
  { value: '匈牙利', key: 'hungary' },
  { value: '以色列', key: 'israel' },
  { value: '印度', key: 'india' },
  { value: '印度尼西亚', key: 'indonesia' },
  { value: '英国', key: 'unitedKingdom' },
  { value: '约旦', key: 'jordan' },
  { value: '智利', key: 'chile' },
  { value: '中国', key: 'china' },
];

export const REGION_OPTIONS: GeographyOption[] = [
  { value: '北美洲', key: 'northAmerica' },
  { value: '大洋洲', key: 'oceania' },
  { value: '独联体', key: 'cis' },
  { value: '非洲与以色列', key: 'africaIsrael' },
  { value: '南美洲', key: 'southAmerica' },
  { value: '欧洲', key: 'europe' },
  { value: '亚太', key: 'asiaPacific' },
];

const countryKeys = new Map(COUNTRY_OPTIONS.map((option) => [option.value, option.key]));
const regionKeys = new Map(REGION_OPTIONS.map((option) => [option.value, option.key]));
const canonicalRegions = new Map(REGION_OPTIONS.map((option) => [option.value, option.value]));
regionKeys.set('北美', 'northAmerica');
regionKeys.set('南美', 'southAmerica');
regionKeys.set('亚洲', 'asiaPacific');
canonicalRegions.set('北美', '北美洲');
canonicalRegions.set('南美', '南美洲');
canonicalRegions.set('亚洲', '亚太');

export function countryLabel(t: TFunction, value: string): string {
  const key = countryKeys.get(value.trim());
  return key ? String(t(`geography.countries.${key}`)) : value;
}

export function regionLabel(t: TFunction, value: string): string {
  const key = regionKeys.get(value.trim());
  return key ? String(t(`geography.regions.${key}`)) : value;
}

export function isKnownCountry(value: string): boolean {
  return countryKeys.has(value.trim());
}

export function isKnownRegion(value: string): boolean {
  return regionKeys.has(value.trim());
}

export function canonicalRegionValue(value: string): string {
  const trimmed = value.trim();
  return canonicalRegions.get(trimmed) ?? trimmed;
}
