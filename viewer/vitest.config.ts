import { defineConfig } from 'vitest/config';
import { wasmPlugin } from './scripts/wasm.ts';

export default defineConfig({ plugins: [wasmPlugin()], test: { include: ['src/**/*.test.ts'], setupFiles: ['src/wasm.setup.ts'] } });
