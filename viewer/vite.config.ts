import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { codemapServer } from './scripts/server.ts';
import { wasmPlugin } from './scripts/wasm.ts';

export default defineConfig(() => ({
  plugins: [react(), wasmPlugin(), codemapServer()],
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
