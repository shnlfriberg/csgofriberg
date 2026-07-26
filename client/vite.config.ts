/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const configuredVersion = process.env.RESOURCE_VERSION?.trim();
if (configuredVersion && !/^\d{13}$/.test(configuredVersion)) {
  throw new Error('RESOURCE_VERSION must be a 13-digit Unix timestamp in milliseconds');
}
const resourceVersion = configuredVersion || String(Date.now());
process.env.VITE_RESOURCE_VERSION = resourceVersion;

export default defineConfig({
  plugins: [
    react(),
    {
      // 把 Vite 注入 head 的 CSS(如 *.module.css 的产物)搬进 body 的样式表组,
      // 保证首绘只依赖 head 内联启动屏样式,不被任何外链 CSS 阻塞
      name: 'move-injected-css-to-body',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler(html: string) {
          const moved: string[] = [];
          const stripped = html.replace(
            /[ \t]*<link rel="stylesheet" crossorigin[^>]*>\r?\n?/g,
            (match) => {
              moved.push(match.trim());
              return '';
            }
          );
          if (!moved.length) return html;
          return stripped.replace(
            /<link rel="stylesheet"(?![^>]*crossorigin)[^>]*data-blast-theme[^>]*>/,
            (firstBlastLink) => `${moved.join('\n    ')}\n    ${firstBlastLink}`
          );
        },
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // 路由保持静态导入,所有 chunk 首屏即加载;拆分只为长缓存:
        // 业务代码变更时 vendor chunk 的 hash 不变,老用户无需重新下载。
        // 注意:所有依赖 React 的包必须同在 vendor 内,单独拆出的 chunk
        // 只能是确定不依赖 React 的包,否则 chunk 间会形成循环引用,
        // 运行时报 "Cannot read properties of undefined (reading 'createContext')"
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/socket\.io|engine\.io/.test(id)) return 'realtime';
          if (/[\\/]node_modules[\\/]i18next[\\/]/.test(id)) return 'i18n';
          return 'vendor';
        },
      },
    },
    // CSP style-src is 'self' (+ unsafe-inline); data: stylesheet URLs are blocked.
    assetsInlineLimit(filePath, content) {
      if (filePath.endsWith('.css')) return false;
      return content.length < 4096;
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
