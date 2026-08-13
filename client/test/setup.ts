import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';

// Node 26 exposes a process-level localStorage getter that is undefined unless
// --localstorage-file is provided. jsdom inherits that value in this setup, so
// provide the small Storage surface used by the app for each test worker.
function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(String(key)) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(String(key));
    },
    setItem(key: string, value: string) {
      values.set(String(key), String(value));
    },
  };
}

function installStorage(name: 'localStorage' | 'sessionStorage'): void {
  const storage = createMemoryStorage();
  Object.defineProperty(window, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage,
  });
}

installStorage('localStorage');
installStorage('sessionStorage');

let i18n: typeof import('../src/i18n').default;

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
  i18n = (await import('../src/i18n')).default;
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
