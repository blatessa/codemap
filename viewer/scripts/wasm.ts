// Builds cmd/codemap-wasm, the graph walks the viewer shares with the CLI, into
// src/wasm/ along with the Go release's wasm_exec.js. The Vite and Vitest
// configs run it, so dev, build and tests always use the current Go code.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../src/wasm');

export function buildWasm() {
  mkdirSync(out, { recursive: true });
  const repo = join(here, '../..');
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', join(out, 'codemap.wasm'), './cmd/codemap-wasm'], {
    cwd: repo,
    env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' },
    stdio: 'inherit',
  });
  const root = execFileSync('go', ['env', 'GOROOT'], { cwd: repo }).toString().trim();
  copyFileSync(join(root, 'lib/wasm/wasm_exec.js'), join(out, 'wasm_exec.js'));
}

// wasmPlugin builds once when Vite or Vitest starts.
export const wasmPlugin = () => ({ name: 'codemap-wasm', buildStart: buildWasm });
