import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mockApi } from './mock/api';

export default defineConfig(({ command }) => ({
  plugins: [react(), ...(command === 'serve' && !process.env.CODEMAP_NO_MOCK ? [mockApi()] : [])],
  base: './',
  build: {
    outDir: '../internal/web/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
    reportCompressedSize: false,
  },
  server: { port: 7782, strictPort: true },
  preview: { port: 7782, strictPort: true },
}));
