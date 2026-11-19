// Vitest: start the walks from the built module on disk.
import { readFileSync } from 'node:fs';
import { startWasm } from './wasm';

await startWasm(readFileSync(new URL('./wasm/codemap.wasm', import.meta.url)));
