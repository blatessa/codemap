// The dev server and the browser tests use the real codemap server: this
// Vite plugin starts `codemap serve` and forwards /api to it.
//
// By default it serves a fixture repo made from testdata/shop: a git repo
// whose main branch is the fixture and whose checked-out branch adds one
// route, so the viewer opens on "this branch vs main" as on a real branch.
//
// Env:
//   CODEMAP_ROOT   serve this repo instead of the fixture
//   CODEMAP_GRAPH  serve this graph.json instead of running the extractors
//   CODEMAP_API_PORT  the codemap server's port (default: Vite's port + 1)
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

// fixtureRoot is where the fixture repo for a port lives; the browser tests
// reset it between tests (e2e/app.spec.ts).
export const fixtureRoot = (port: number) => path.join(os.tmpdir(), `codemap-fixture-${port}`);

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=codemap', '-c', 'user.email=codemap@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    stdio: 'ignore',
  });

// makeFixture copies testdata/shop into a fresh git repo: main is the fixture,
// and the checked-out branch "receipts" adds a route.
export function makeFixture(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(repo, 'testdata/shop'), dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'shop');
  git(dir, 'checkout', '-q', '-b', 'receipts');
  const routes = path.join(dir, 'cmd/server/routes.go');
  const src = fs.readFileSync(routes, 'utf8');
  fs.writeFileSync(
    routes,
    src.replace('\tr.Post("/webhooks/stripe"', '\tr.With(authH.RequireUser).Get("/orders/{id}/receipt", ordersH.Get)\n\tr.Post("/webhooks/stripe"'),
  );
  git(dir, 'commit', '-q', '-am', 'Receipts');
}

export function codemapServer(): Plugin {
  let child: ChildProcess | null = null;
  return {
    name: 'codemap-server',
    apply: 'serve',
    config(_, env) {
      const port = Number(process.env.VITE_PORT) || 7782;
      const api = Number(process.env.CODEMAP_API_PORT) || port + 1;
      const target = `http://127.0.0.1:${api}`;
      if (env.command !== 'serve' || child) return;
      const root = process.env.CODEMAP_ROOT ?? fixtureRoot(port);
      if (!process.env.CODEMAP_ROOT) makeFixture(root);
      // built, then run: `go run` wouldn't pass a kill on to the server
      const bin = path.join(os.tmpdir(), `codemap-dev-${api}`);
      execFileSync('go', ['build', '-o', bin, './cmd/codemap'], { cwd: repo, stdio: 'inherit' });
      const args = ['serve', '--no-open', '--port', String(api), '--root', root];
      if (process.env.CODEMAP_GRAPH) args.push('--graph', path.resolve(process.env.CODEMAP_GRAPH));
      child = spawn(bin, args, { cwd: repo, stdio: ['ignore', 'inherit', 'inherit'] });
      const stop = () => child?.kill();
      process.on('exit', stop);
      process.on('SIGINT', () => process.exit());
      process.on('SIGTERM', () => process.exit());
      return {
        server: {
          proxy: {
            // The server refuses writes from another origin; through the
            // proxy, the page's origin is the server's own.
            '/api': { target, changeOrigin: true, configure: (proxy) => proxy.on('proxyReq', (req) => req.setHeader('origin', target)) },
          },
        },
      };
    },
  };
}
