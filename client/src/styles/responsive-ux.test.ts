import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readCss = (relativePath: string) =>
  readFileSync(resolve(__dirname, relativePath), 'utf8');

describe('desktop/mobile layout contracts', () => {
  it('caps single difficulty cards on wide screens and stacks actions on mobile', () => {
    const home = readCss('./home-multiplayer.css');
    expect(home).toMatch(
      /\.single-difficulty-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(230px,\s*360px\)\)/s
    );
    expect(home).toMatch(/\.single-difficulty-grid\s*\{[^}]*justify-content:\s*center/s);
    expect(home).toMatch(
      /\.single-difficulty-icon\s*\{[^}]*var\(--diff-color,\s*var\(--primary\)\)/s
    );
    expect(home).toMatch(
      /\.single-difficulty-option\.active\s+\.single-difficulty-check\s*\{[^}]*background:\s*var\(--primary\)/s
    );
    expect(home).toMatch(/\.single-difficulty-check\s*\{[^}]*color:\s*#201118/s);

    const responsive = readCss('./responsive.css');
    expect(responsive).toMatch(
      /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*\.single-lobby-action\s*\{[^}]*flex-direction:\s*column/ 
    );
    expect(responsive).toMatch(
      /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*\.single-lobby-action\s+\.btn\s*\{[^}]*width:\s*100%/
    );
  });

  it('hides chrome when mobile keyboard is open and keeps multiplayer boards stacked', () => {
    const responsive = readCss('./responsive.css');
    expect(responsive).toMatch(
      /\.game-page\.keyboard-active\s+\.header-bar,\s*\n?\s*\.game-page\.keyboard-active\s+\.status-bar\s*\{\s*display:\s*none/
    );
    expect(responsive).toMatch(
      /@media\s*\(max-width:\s*960px\)\s*\{[\s\S]*\.boards\s*\{[^}]*grid-template-columns:\s*1fr/
    );
    expect(responsive).toMatch(
      /\.leaderboard-card\s+table\s+th:nth-child\(1\)\s*\{\s*width:\s*7%/
    );
    expect(responsive).toMatch(
      /\.leaderboard-card-multi\s+table\s+th:nth-child\(1\)\s*\{\s*width:\s*8%/
    );
  });
});
