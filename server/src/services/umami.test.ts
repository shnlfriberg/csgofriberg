import { describe, expect, it } from 'vitest';
import { injectUmamiScript, resolveUmamiConfig } from './umami';

describe('resolveUmamiConfig', () => {
  it('disables analytics without a website id', () => {
    expect(resolveUmamiConfig({})).toBeNull();
  });

  it('uses Umami Cloud by default and supports self-hosting', () => {
    expect(resolveUmamiConfig({ websiteId: 'site-123' })).toEqual({
      websiteId: 'site-123',
      scriptUrl: 'https://cloud.umami.is/script.js',
      origin: 'https://cloud.umami.is',
    });
    expect(resolveUmamiConfig({
      websiteId: 'site-123',
      scriptUrl: 'https://analytics.example.com/tracker.js',
    })).toEqual({
      websiteId: 'site-123',
      scriptUrl: 'https://analytics.example.com/tracker.js',
      origin: 'https://analytics.example.com',
    });
  });

  it('rejects invalid ids and script protocols', () => {
    expect(() => resolveUmamiConfig({ websiteId: 'invalid id' }))
      .toThrow('INVALID_UMAMI_WEBSITE_ID');
    expect(() => resolveUmamiConfig({ websiteId: 'site-123', scriptUrl: 'javascript:alert(1)' }))
      .toThrow('INVALID_UMAMI_SCRIPT_URL');
  });

  it('injects the configured script without changing disabled pages', () => {
    const html = '<html><head><title>Game</title></head><body></body></html>';
    expect(injectUmamiScript(html, null)).toBe(html);
    const rendered = injectUmamiScript(html, {
      websiteId: 'site-123',
      scriptUrl: 'https://analytics.example.com/script.js?key=a&mode=b',
      origin: 'https://analytics.example.com',
    });
    expect(rendered).toContain(
      'src="https://analytics.example.com/script.js?key=a&amp;mode=b"'
    );
    expect(rendered).toContain('data-website-id="site-123"');
    expect(rendered).toContain('data-performance="true"');
  });
});
