export interface UmamiConfig {
  websiteId: string;
  scriptUrl: string;
  origin: string;
}

const WEBSITE_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const DEFAULT_SCRIPT_URL = 'https://cloud.umami.is/script.js';

export function resolveUmamiConfig(input: {
  websiteId?: string;
  scriptUrl?: string;
}): UmamiConfig | null {
  const websiteId = input.websiteId?.trim();
  if (!websiteId) return null;
  if (!WEBSITE_ID_PATTERN.test(websiteId)) throw new Error('INVALID_UMAMI_WEBSITE_ID');

  let url: URL;
  try {
    url = new URL(input.scriptUrl?.trim() || DEFAULT_SCRIPT_URL);
  } catch {
    throw new Error('INVALID_UMAMI_SCRIPT_URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('INVALID_UMAMI_SCRIPT_URL');
  }
  return { websiteId, scriptUrl: url.href, origin: url.origin };
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function injectUmamiScript(indexHtml: string, umami: UmamiConfig | null): string {
  if (!umami) return indexHtml;
  const script = `<script defer src="${escapeHtmlAttribute(umami.scriptUrl)}" data-website-id="${escapeHtmlAttribute(umami.websiteId)}" data-performance="true"></script>`;
  return indexHtml.replace('</head>', `  ${script}\n</head>`);
}
