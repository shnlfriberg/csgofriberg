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
    expect(home).toMatch(
      /\.home-hero::before,\s*\n?\s*\.home-hero::after\s*\{[^}]*z-index:\s*0/s
    );
    expect(home).toMatch(/\.home-hero\s*>\s*\*\s*\{[^}]*z-index:\s*1/s);

    const responsive = readCss('./responsive.css');
    expect(responsive).toMatch(
      /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*\.single-lobby-action\s*\{[^}]*flex-direction:\s*column/ 
    );
    expect(responsive).toMatch(
      /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*\.single-lobby-action\s+\.btn\s*\{[^}]*width:\s*100%/
    );
    expect(home).toMatch(/\.thanks-dialog\s*\{[^}]*max-height:\s*calc\(100dvh - 40px\)/s);
    expect(home).toMatch(/\.home-sponsor-link\s*\{[^}]*font-size:\s*0\.72rem/s);
    const game = readCss('./game.css');
    expect(game).not.toMatch(/\.input-dock\s*\{[^}]*backdrop-filter/s);
  });

  it('hides chrome for mobile keyboards and stacks multiplayer boards only when space is genuinely narrow', () => {
    const responsive = readCss('./responsive.css');
    expect(responsive).toMatch(
      /\.game-page\.keyboard-active\s+\.header-bar,\s*\n?\s*\.game-page\.keyboard-active\s+\.status-bar\s*\{\s*display:\s*none/
    );
    expect(responsive).toMatch(
      /@media\s*\(max-width:\s*960px\)\s*and\s*\(pointer:\s*coarse\),\s*\(max-width:\s*700px\)\s*\{[\s\S]*\.boards\s*\{[^}]*grid-template-columns:\s*1fr/
    );
    expect(responsive).toMatch(
      /\.leaderboard-card\s+table\s+th:nth-child\(1\)\s*\{\s*width:\s*7%/
    );
    expect(responsive).toMatch(
      /\.leaderboard-card-multi\s+table\s+th:nth-child\(1\)\s*\{\s*width:\s*8%/
    );
    const dataAdmin = readCss('./data-admin.css');
    expect(dataAdmin).toMatch(
      /\.leaderboard-mode-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
    );
    expect(dataAdmin).toMatch(
      /\.leaderboard-self-summary\s*\{[^}]*grid-template-columns:[^}]*minmax\(5\.5rem,[^}]*minmax\(7rem,[^}]*min-height:\s*48px/s
    );
    expect(responsive).toMatch(
      /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*\.leaderboard-controls\s*\{[^}]*flex-direction:\s*column/
    );
  });

  it('keeps wide low-zoom layouts at the 1920px design scale', () => {
    const tokens = readCss('./tokens.css');
    // 单一根字号刻度,不再包媒体查询:下界 100% 已覆盖 1600–1920 区间
    expect(tokens).toMatch(/^html\s*\{\s*font-size:\s*clamp\(100%,\s*0\.833333vw,\s*400%\);\s*\}/m);
    expect(tokens).not.toMatch(/@media\s*\(min-width:\s*1600px\)/);

    const multiplayer = readCss('./home-multiplayer.css');
    expect(multiplayer).toMatch(/\.score-bar\s*\{[^}]*width:\s*min\(57\.5rem,\s*100%\)/s);
    expect(multiplayer).toMatch(/\.boards\s*\{[^}]*gap:\s*0\.875rem/s);
  });

  it('scales the multiplayer board continuously so browser zoom cannot snap its density', () => {
    // 参与版心宽度计算的间距,上下界必须是 rem,否则棋盘宽度占比会随缩放漂移
    const tokens = readCss('./tokens.css');
    expect(tokens).toMatch(/--page-inline:\s*clamp\(1rem,\s*4vw,\s*3\.25rem\)/);
    expect(readCss('./controls.css')).toMatch(
      /\.card\s*\{[^}]*padding:\s*clamp\(1\.125rem,\s*2\.25vw,\s*1\.5rem\)/s
    );

    const multiplayer = readCss('./home-multiplayer.css');
    // 唯一的刻度旋钮。上界必须是常规宽度下生效的那一项(0.95rem ≈ 15.2px),
    // 否则 cqw 会在放大页面时因容器变窄而抵消掉缩放
    expect(multiplayer).toMatch(
      /\.player-board\s+\.game-table\s*\{[^}]*font-size:\s*clamp\(0\.66rem,\s*3\.2cqw,\s*0\.95rem\)/s
    );
    // cqw 系数不能超过「不换行」上限,否则手机竖屏等窄容器会整片折行
    const cqw = Number(
      /\.player-board\s+\.game-table\s*\{[^}]*?([\d.]+)cqw/s.exec(multiplayer)?.[1]
    );
    const hPad = Number(
      /\.player-board\s+\.game-table\s+td\s*\{[^}]*padding:\s*[\d.]+em\s+([\d.]+)em/s.exec(
        multiplayer
      )?.[1]
    );
    // 列宽% ÷ (字符数 × 字宽 + 箭头 + 2×横向留白),取最紧的一列
    const demand = [
      { w: 21, n: 11, cjk: false }, { w: 16, n: 8, cjk: false },
      { w: 14, n: 7, cjk: false }, { w: 9, n: 2, cjk: false, arrow: true },
      { w: 13, n: 3, cjk: true }, { w: 8, n: 1, cjk: false, arrow: true },
      { w: 9, n: 2, cjk: false, arrow: true }, { w: 10, n: 2, cjk: true },
    ];
    const ceiling = Math.min(
      ...demand.map(
        (c) => c.w / (c.n * (c.cjk ? 1 : 0.5) + (c.arrow ? 0.88 : 0) + 2 * hPad)
      )
    );
    expect(cqw).toBeLessThanOrEqual(ceiling);
    // 板内尺寸全部由该字号用 em 派生 —— 出现 px 就意味着又引入了不随缩放变化的死值。
    // 先剥注释:说明文字里会提到 1920px 之类的设计基准,不该被当成声明扫到
    const boardBlock = multiplayer
      .slice(multiplayer.indexOf('.player-board {'))
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const boardRules = boardBlock.match(/\.player-board\s+\.game-table[^{]*\{[^}]*\}/gs) ?? [];
    expect(boardRules.length).toBeGreaterThan(3);
    for (const rule of boardRules) {
      expect(rule).not.toMatch(/:\s*[^;{}]*\b\d+(\.\d+)?px\b/);
    }
    // 断点式容器查询已移除:有台阶就有缩放时的密度跳变
    expect(multiplayer).not.toMatch(/@container\s*\(max-width:\s*(560|390)px\)/);

    // 多人棋盘自己的列宽比例必须正好占满 100%,否则 table-layout: fixed 会自行分配余量
    const widths = [
      ...multiplayer.matchAll(
        /\.player-board\s+\.game-table\s+td:nth-child\(\d\)\s*\{\s*width:\s*(\d+)%/g
      ),
    ].map((m) => Number(m[1]));
    expect(widths).toHaveLength(8);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('keeps mobile multiplayer tables compact without truncating content or changing desktop sizing', () => {
    const responsive = readCss('./responsive.css');
    expect(responsive).toMatch(
      /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*\.player-board\s+\.game-table\s*\{[^}]*font-size:\s*clamp\(0\.6rem,\s*2\.75cqw,\s*0\.78rem\)/
    );
    expect(responsive).toMatch(
      /\.player-board\s+\.game-table\s+td\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*normal/s
    );
    expect(responsive).toMatch(
      /\.player-board\s+\.game-table\s+th\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*normal/s
    );

    const mobileBoardRules = responsive
      .slice(responsive.indexOf('@media (max-width: 640px)'))
      .match(/\.player-board\s+\.game-table[^{]*\{[^}]*\}/gs) ?? [];
    expect(mobileBoardRules.join('\n')).not.toMatch(/overflow:\s*hidden|text-overflow:\s*ellipsis/);

    const multiplayer = readCss('./home-multiplayer.css');
    expect(multiplayer).toMatch(
      /\.player-board\s+\.game-table\s*\{[^}]*font-size:\s*clamp\(0\.66rem,\s*3\.2cqw,\s*0\.95rem\)/s
    );
  });
});
