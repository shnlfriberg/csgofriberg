import { createLucideIcon } from 'lucide-react';

// Match the menu's Lucide icons: 24px viewBox, rounded 2px strokes, no fill.
export default createLucideIcon('Duck', [
  ['path', { d: 'M3 11l4 2h3V8a4 4 0 0 1 7.8-1.2L21 8l-3 2v3a7 7 0 0 1-7 7H9a6 6 0 0 1-6-6Z', key: 'outline' }],
  ['path', { d: 'M15 7.5h.01', key: 'eye' }],
  ['path', { d: 'M7 15a4 4 0 0 0 6 1', key: 'wing' }],
]);
