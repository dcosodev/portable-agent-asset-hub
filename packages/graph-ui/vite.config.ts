/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api/v1': process.env.GRAPH_UI_REST_URL ?? 'http://127.0.0.1:39521',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rolldownOptions: {
      output: {
        manualChunks: (id) => {
          if (/\/node_modules\/(react|react-dom)\//.test(id)) return 'react';
          if (id.includes('/node_modules/cytoscape/')) return 'graph';
          if (/\/node_modules\/(react-markdown|remark-gfm)\//.test(id)) return 'markdown';
          return null;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    css: true,
  },
});
