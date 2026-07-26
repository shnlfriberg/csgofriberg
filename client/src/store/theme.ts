export type Theme = 'blast' | 'light';

const STORAGE_KEY = 'ui-theme';
const STYLESHEET_SELECTOR = 'link[data-blast-theme]';
const listeners = new Set<() => void>();

function storedTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light') return 'light';
    if (stored === 'blast') return 'blast';
    // 未显式选择过主题时跟随系统偏好
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'blast';
  } catch {
    return 'blast';
  }
}

let currentTheme = storedTheme();

function blastStylesheets(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>(STYLESHEET_SELECTOR)];
}

function renderTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'blast' ? 'dark' : 'light';
  document.documentElement.style.background = theme === 'blast' ? '#160a13' : '#f3f0ea';
  // 链接在 index.html 中按级联顺序位于主样式表之后,切换只翻转 media,不移动节点
  for (const stylesheet of blastStylesheets()) {
    stylesheet.media = theme === 'blast' ? 'all' : 'not all';
  }
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'blast' ? '#160a13' : '#f3f0ea'
  );
}

export function initializeTheme(): void {
  currentTheme = storedTheme();
  renderTheme(currentTheme);
}

export function getTheme(): Theme {
  return currentTheme;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setTheme(theme: Theme): void {
  if (theme === currentTheme) return;
  currentTheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Theme switching still works when storage is unavailable.
  }
  renderTheme(theme);
  for (const listener of listeners) listener();
}

window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  const theme: Theme = event.newValue === 'light' ? 'light' : event.newValue === 'blast' ? 'blast' : storedTheme();
  if (theme === currentTheme) return;
  currentTheme = theme;
  renderTheme(theme);
  for (const listener of listeners) listener();
});
