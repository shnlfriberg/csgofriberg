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
  plugins: [react()],
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
        inlineDynamicImports: true,
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
