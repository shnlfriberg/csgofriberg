import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import i18n from '../i18n';

function installViewportMocks(mobile = false) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const widthQuery = query.match(/max-width:\s*(\d+)px/);
      const matches = widthQuery ? (mobile ? Number(widthQuery[1]) >= 640 : false) : false;
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    },
  });

  Object.defineProperty(window, 'visualViewport', {
    writable: true,
    configurable: true,
    value: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      width: mobile ? 390 : 1280,
      height: mobile ? 844 : 800,
    },
  });
}

beforeAll(async () => {
  await i18n.changeLanguage('zh');
});

beforeEach(() => {
  installViewportMocks(false);
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  await i18n.changeLanguage('zh');
});

export { installViewportMocks };
