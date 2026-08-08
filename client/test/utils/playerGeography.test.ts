import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../../src/i18n';
import {
  COUNTRY_OPTIONS,
  REGION_OPTIONS,
  canonicalRegionValue,
  countryLabel,
  regionLabel,
} from '../../src/utils/playerGeography';

afterEach(async () => {
  await i18n.changeLanguage('zh');
});

describe('player geography labels', () => {
  it('covers every country and region in all supported languages', async () => {
    expect(COUNTRY_OPTIONS).toHaveLength(50);
    expect(REGION_OPTIONS).toHaveLength(7);
    for (const language of ['zh', 'en', 'ja']) {
      await i18n.changeLanguage(language);
      for (const option of COUNTRY_OPTIONS) {
        expect(countryLabel(i18n.t, option.value)).not.toContain('geography.countries.');
      }
      for (const option of REGION_OPTIONS) {
        expect(regionLabel(i18n.t, option.value)).not.toContain('geography.regions.');
      }
    }
  });

  it('translates canonical values and preserves unknown values', async () => {
    await i18n.changeLanguage('en');
    expect(countryLabel(i18n.t, '瑞典')).toBe('Sweden');
    expect(regionLabel(i18n.t, '欧洲')).toBe('Europe');
    expect(regionLabel(i18n.t, '北美')).toBe('North America');
    expect(canonicalRegionValue('北美')).toBe('北美洲');

    await i18n.changeLanguage('ja');
    expect(countryLabel(i18n.t, '乌克兰')).toBe('ウクライナ');
    expect(regionLabel(i18n.t, '亚太')).toBe('アジア太平洋');
    expect(countryLabel(i18n.t, '未知国家')).toBe('未知国家');
  });
});
