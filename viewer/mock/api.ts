// Development-only mock of the codemap server API (PLAN.md §8), served by Vite's
// dev and preview servers. It reads testdata/shop.expected.json and the files in
// testdata/shop/.codemap; writes are kept in memory. Never part of the build.
//
// Env: CODEMAP_MOCK_GRAPH (graph JSON file), CODEMAP_MOCK_ROOT (repo root holding .codemap).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, Connect } from 'vite';
import YAML from 'yaml';

const here = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(process.env.CODEMAP_MOCK_ROOT ?? path.join(here, '../../testdata/shop'));
const GRAPH = path.resolve(process.env.CODEMAP_MOCK_GRAPH ?? path.join(here, '../../testdata/shop.expected.json'));
const DIR = path.join(ROOT, '.codemap');

type Obj = Record<string, unknown>;
const FILES = ['areas', 'blocks', 'layout', 'views', 'external'] as const;
type FileKey = (typeof FILES)[number];

interface Mock {
  graph: Obj;
  config: unknown;
  files: Record<FileKey, unknown>;
  proposals: Map<string, Obj>;
}

let db: Mock = load();
const clients = new Set<ServerResponse>();

function readText(name: string): string | null {
  try {
    return fs.readFileSync(path.join(DIR, name), 'utf8');
  } catch {
    return null;
  }
}

function readFile(key: FileKey): unknown {
  if (key === 'layout') {
    const t = readText('layout.json');
    return t ? JSON.parse(t) : {};
  }
  const t = readText(key + '.yaml');
  const v = t ? YAML.parse(t) : null;
  if (key === 'external') return v ?? {};
  return v ?? [];
}

// parseProposal mirrors project.ParseProposal.
export function parseProposal(text: string): Obj {
  let p: Obj = { status: 'open' };
  let body = text;
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
    const rest = text.slice(text.indexOf('\n') + 1);
    const end = rest.indexOf('\n---');
    if (end < 0) throw new Error('frontmatter is not closed with ---');
    p = { ...p, ...(YAML.parse(rest.slice(0, end)) ?? {}) };
    body = rest.slice(end + 4).replace(/^\r/, '').replace(/^\n/, '');
  }
  p.body = body;
  if (!p.status) p.status = 'open';
  if (!p.name) {
    const m = /^#+\s+(.+)$/m.exec(body);
    if (m) p.name = m[1].trim();
  }
  return p;
}

function loadProposals(): Map<string, Obj> {
  const out = new Map<string, Obj>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(DIR, 'proposals')).filter((n) => n.endsWith('.md')).sort();
  } catch {
    /* none */
  }
  for (const n of names) {
    const p = parseProposal(fs.readFileSync(path.join(DIR, 'proposals', n), 'utf8'));
    const slug = n.slice(0, -3);
    out.set(slug, { slug, ...p });
  }
  return out;
}

function load(): Mock {
  const files = {} as Record<FileKey, unknown>;
  for (const k of FILES) files[k] = readFile(k);
  const t = readText('config.yaml');
  return {
    graph: JSON.parse(fs.readFileSync(GRAPH, 'utf8')),
    config: t ? YAML.parse(t) ?? {} : {},
    files,
    proposals: loadProposals(),
  };
}

const hash = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);

function versions() {
  const v: Record<string, string> = {};
  for (const k of FILES) v[k] = hash(db.files[k]);
  for (const [slug, p] of db.proposals) v['proposals/' + slug] = hash(p);
  return v;
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  if (body === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : null);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function broadcast(event: string, files: string[]) {
  for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify({ files })}\n\n`);
}

const sortedLayout = (l: Obj) => Object.fromEntries(Object.keys(l).sort().map((k) => [k, l[k]]));

async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const m = req.method ?? 'GET';
  const rev = url.searchParams.get('rev');
  if (m !== 'GET' && rev && rev !== 'worktree') return send(res, 405, { error: 'read-only revision' });

  if (p === '/__mock/reset' && m === 'POST') {
    db = load();
    return send(res, 204);
  }
  // test hook: replace the graph, as if the code changed
  if (p === '/__mock/graph' && m === 'PUT') {
    db.graph = (await readBody(req)) as Obj;
    broadcast('graph-changed', ['(mock)']);
    return send(res, 204);
  }
  if (p === '/api/state' && m === 'GET') {
    return send(res, 200, {
      graph: db.graph,
      project: {
        config: db.config,
        areas: db.files.areas,
        blocks: db.files.blocks,
        layout: db.files.layout,
        views: db.files.views,
        external: db.files.external,
        proposals: [...db.proposals.values()],
      },
      versions: versions(),
    });
  }
  const pf = /^\/api\/project\/(areas|blocks|layout|views|external)$/.exec(p);
  if (pf && m === 'PUT') {
    const key = pf[1] as FileKey;
    const cur = hash(db.files[key]);
    const im = req.headers['if-match'];
    if (im !== undefined && im !== cur) return send(res, 409, { version: cur, value: db.files[key] });
    let v = await readBody(req);
    if (key === 'layout') v = sortedLayout((v ?? {}) as Obj);
    db.files[key] = v;
    // like the real server's file watcher, which also sees our own writes
    broadcast('project-changed', [`.codemap/${key}.${key === 'layout' ? 'json' : 'yaml'}`]);
    return send(res, 200, { version: hash(v) });
  }
  if (p === '/api/proposals' && m === 'GET') return send(res, 200, [...db.proposals.values()]);
  const pp = /^\/api\/proposals\/([^/]+)$/.exec(p);
  if (pp) {
    const slug = decodeURIComponent(pp[1]);
    const cur = db.proposals.get(slug);
    if (m === 'DELETE') {
      db.proposals.delete(slug);
      broadcast('project-changed', [`.codemap/proposals/${slug}.md`]);
      return send(res, 204);
    }
    if (m === 'PUT') {
      const im = req.headers['if-match'];
      if (cur && im !== undefined && im !== hash(cur)) return send(res, 409, { version: hash(cur), value: cur });
      const v: Obj = { ...((await readBody(req)) as Obj), slug };
      if (!cur && !v.base) v.base = 'HEAD';
      db.proposals.set(slug, v);
      broadcast('project-changed', [`.codemap/proposals/${slug}.md`]);
      return send(res, 200, { version: hash(v) });
    }
  }
  if (p === '/api/source' && m === 'GET') {
    const file = url.searchParams.get('file') ?? '';
    const full = path.resolve(ROOT, file);
    if (!file || !full.startsWith(ROOT + path.sep)) return send(res, 400, { error: 'bad file' });
    let lines: string[];
    try {
      lines = fs.readFileSync(full, 'utf8').split('\n');
    } catch {
      return send(res, 404, { error: 'not found' });
    }
    const from = Math.max(1, Number(url.searchParams.get('from')) || 1);
    const to = Math.min(lines.length, Number(url.searchParams.get('to')) || lines.length);
    return send(res, 200, { file, from, lines: lines.slice(from - 1, to) });
  }
  if (p === '/api/open' && m === 'POST') {
    const b = (await readBody(req)) as Obj;
    console.log(`[mock] open ${b?.file}:${b?.line}`);
    return send(res, 204);
  }
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  next();
}

// Watch the fixture so outside edits (an agent writing .codemap/*) reach the viewer.
function watch() {
  let timer: NodeJS.Timeout | undefined;
  const changed = new Set<string>();
  const flush = () => {
    const files = [...changed];
    changed.clear();
    let graph = false;
    for (const f of files) {
      if (f === GRAPH) {
        try {
          db.graph = JSON.parse(fs.readFileSync(GRAPH, 'utf8'));
          graph = true;
        } catch {
          /* mid-write */
        }
        continue;
      }
      const base = path.basename(f).replace(/\.(yaml|json)$/, '') as FileKey;
      if ((FILES as readonly string[]).includes(base)) db.files[base] = readFile(base);
      else if (f.includes('proposals')) db.proposals = loadProposals();
    }
    if (graph) broadcast('graph-changed', [path.basename(GRAPH)]);
    const proj = files.filter((f) => f !== GRAPH).map((f) => path.relative(ROOT, f));
    if (proj.length) broadcast('project-changed', proj);
  };
  const on = (full: string) => {
    changed.add(full);
    clearTimeout(timer);
    timer = setTimeout(flush, 300);
  };
  try {
    fs.watch(DIR, { recursive: true }, (_e, name) => name && !name.includes('.tmp') && on(path.join(DIR, name.toString())));
    fs.watch(GRAPH, () => on(GRAPH));
  } catch {
    /* watching is best-effort */
  }
}

export function mockApi(): Plugin {
  const mw: Connect.NextHandleFunction = (req, res, next) => {
    handle(req, res, next).catch((e) => send(res, 500, { error: String(e) }));
  };
  return {
    name: 'codemap-mock-api',
    configureServer(server) {
      watch();
      server.middlewares.use(mw);
    },
    configurePreviewServer(server) {
      watch();
      server.middlewares.use(mw);
    },
  };
}
