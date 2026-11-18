// Mock git history for the viewer's compare features (/api/revs, /api/diff,
// /api/source/diff, and /api/state or /api/source at a rev). The worktree is the
// fixture graph; older revisions are derived from it by editing a copy:
//
//   c1 "Initial shop"          = before: no getOrder, no expire-carts job, plus Repo.Archive (writes users)
//   c2 "Add order lookup" main = c1 + ts getOrder (and its fetch)
//   c3 "Archive old orders"    = c2 with Service.Place changed   (HEAD, branch agent/archive)
//   worktree                   = fixture: Archive removed, expire-carts added, Find and Reserve changed
//
// PR #7 is agent/archive into main.
import type { IncomingMessage, ServerResponse } from 'node:http';

type Obj = Record<string, unknown>;
interface N extends Obj {
  id: string;
  kind: string;
  label: string;
  module: string;
  file?: string;
  line?: number;
  endLine?: number;
  entry?: boolean;
  external?: boolean;
  fields?: Obj;
}
interface E extends Obj {
  from: string;
  to: string;
  type: string;
}
interface M extends Obj {
  id: string;
  label: string;
}
interface G {
  version: number;
  rev?: string;
  modules: M[];
  nodes: N[];
  edges: E[];
}

const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const C1 = sha(1),
  C2 = sha(2),
  C3 = sha(3);
const now = Date.now();
const day = 86400e3;
export const commits = [
  { sha: C3, short: C3.slice(0, 7), subject: 'Archive old orders', author: 'agent', date: new Date(now - 2 * 3600e3).toISOString(), parents: [C2], refs: ['agent/archive'] },
  { sha: C2, short: C2.slice(0, 7), subject: 'Add order lookup', author: 'agent', date: new Date(now - 1 * day).toISOString(), parents: [C1], refs: ['main'] },
  { sha: C1, short: C1.slice(0, 7), subject: 'Initial shop', author: 'brady', date: new Date(now - 9 * day).toISOString(), parents: [], refs: [] },
];

const ARCHIVE: N = {
  id: 'go:shop/internal/orders.(*Repo).Archive',
  kind: 'function',
  label: 'Repo.Archive',
  module: 'mod:go:shop/internal/orders',
  file: 'internal/orders/repo.go',
  line: 41,
  endLine: 45,
  doc: 'Archive moves old orders out of the way and notes it on the user.',
};
const GET_ORDER = 'ts:web/src/api/orders.ts#getOrder';
const JOB = 'job:expire-carts';
const RELEASE = 'go:shop/internal/inventory.(*Store).ReleaseExpired';

// bodies: which nodes' bodies differ from the fixture at each rev (by a version number)
const bodies: Record<string, Record<string, number>> = {
  [C1]: {},
  [C2]: {},
  [C3]: { 'go:shop/internal/orders.(*Service).Place': 1 },
  worktree: { 'go:shop/internal/orders.(*Service).Place': 1, 'go:shop/internal/orders.(*Repo).Find': 1, 'go:shop/internal/inventory.(*Store).Reserve': 1 },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function without(g: G, ids: string[]): G {
  const drop = new Set(ids);
  return { ...g, nodes: g.nodes.filter((n) => !drop.has(n.id)), edges: g.edges.filter((e) => !drop.has(e.from) && !drop.has(e.to)) };
}

function graphAt(rev: string, wt: G): G {
  if (rev === 'worktree') return wt;
  let g = clone(wt);
  // c3 and c2: no expire-carts job; Archive exists and writes users
  g = without(g, [JOB, RELEASE]);
  g.nodes.push(ARCHIVE);
  g.edges.push({ from: ARCHIVE.id, to: 'table:users', type: 'writes', detail: 'UPDATE users SET archived_orders = archived_orders + 1' });
  g.edges.push({ from: 'go:shop/internal/orders.(*Service).MarkPaid', to: ARCHIVE.id, type: 'calls' });
  if (rev === C1) g = without(g, [GET_ORDER]);
  g.rev = rev;
  return g;
}

function resolve(rev: string): string | null {
  const r = rev.replace(/^base:/, '');
  if (rev.startsWith('base:')) return C2; // merge-base with main
  if (r === 'worktree' || r === '') return 'worktree';
  const map: Record<string, string> = { HEAD: C3, 'HEAD~1': C2, 'HEAD~2': C1, main: C2, 'agent/archive': C3 };
  if (map[r]) return map[r];
  const c = commits.find((c) => c.sha.startsWith(r));
  return c ? c.sha : null;
}

const ekey = (e: E) => e.from + '\0' + e.to + '\0' + e.type;
const ref = (n: N) => ({ id: n.id, kind: n.kind, label: n.label, module: n.module, ...(n.fields?.method ? { method: n.fields.method } : {}) });

// diff mirrors graph.Diff in Go, with "changed" from the bodies table.
function diff(a: G, b: G, from: string, to: string) {
  const an = new Map(a.nodes.map((n) => [n.id, n]));
  const bn = new Map(b.nodes.map((n) => [n.id, n]));
  const addedNodes = b.nodes.filter((n) => !an.has(n.id));
  const removedNodes = a.nodes.filter((n) => !bn.has(n.id));
  const changed = b.nodes.filter((n) => an.has(n.id) && (bodies[from]?.[n.id] ?? 0) !== (bodies[to]?.[n.id] ?? 0)).map((n) => n.id);
  const ae = new Set(a.edges.map(ekey)),
    be = new Set(b.edges.map(ekey));
  const am = new Map(a.modules.map((m) => [m.id, m])),
    bm = new Map(b.modules.map((m) => [m.id, m]));
  const access = (g: G) => {
    const out = new Map<string, string[]>();
    for (const e of g.edges) if (e.type === 'reads' || e.type === 'writes') out.set(e.to + '\0' + e.type, [...(out.get(e.to + '\0' + e.type) ?? []), e.from]);
    return out;
  };
  const aa = access(a),
    ba = access(b);
  const data = (x: Map<string, string[]>, y: Map<string, string[]>, nodes: Map<string, N>) =>
    [...x]
      .filter(([k]) => !y.has(k))
      .map(([k, by]) => {
        const [id, type] = k.split('\0');
        const n = nodes.get(id) ?? an.get(id)!;
        return { ...ref(n), type, by };
      });
  const deps = (g: G, nodes: Map<string, N>) => {
    const out = new Set<string>();
    for (const e of g.edges) {
      const f = nodes.get(e.from),
        t = nodes.get(e.to);
      if (f && t && f.module !== t.module && f.kind !== 'test') out.add(f.module + '\0' + t.module);
    }
    return out;
  };
  const label = (id: string) => bm.get(id)?.label ?? am.get(id)?.label ?? id;
  const ad = deps(a, an),
    bd = deps(b, bn);
  const dep = (k: string) => {
    const [f, t] = k.split('\0');
    return { from: f, to: t, fromLabel: label(f), toLabel: label(t) };
  };
  const counts = new Map<string, { id: string; label: string; added: number; removed: number; changed: number }>();
  const at = (m: string) => counts.get(m) ?? (counts.set(m, { id: m, label: label(m), added: 0, removed: 0, changed: 0 }), counts.get(m)!);
  for (const n of addedNodes) at(n.module).added++;
  for (const n of removedNodes) at(n.module).removed++;
  for (const id of changed) at(bn.get(id)!.module).changed++;
  const files = [...new Set([...addedNodes, ...removedNodes, ...changed.map((id) => bn.get(id)!)].map((n) => n.file).filter(Boolean))].map((f) => ({ old: f, new: f }));
  return {
    from,
    to,
    addedNodes,
    removedNodes,
    changed,
    renamed: [],
    addedEdges: b.edges.filter((e) => !ae.has(ekey(e))),
    removedEdges: a.edges.filter((e) => !be.has(ekey(e))),
    addedModules: b.modules.filter((m) => !am.has(m.id)),
    removedModules: a.modules.filter((m) => !bm.has(m.id)),
    files,
    summary: {
      entriesAdded: addedNodes.filter((n) => n.entry).map(ref),
      entriesRemoved: removedNodes.filter((n) => n.entry).map(ref),
      dataAdded: data(ba, aa, bn),
      dataRemoved: data(aa, ba, bn),
      externalAdded: addedNodes.filter((n) => n.external).map(ref),
      externalRemoved: removedNodes.filter((n) => n.external).map(ref),
      depsAdded: [...bd].filter((k) => !ad.has(k)).map(dep),
      depsRemoved: [...ad].filter((k) => !bd.has(k)).map(dep),
      modules: [...counts.values()].sort((x, y) => x.id.localeCompare(y.id)),
    },
  };
}

// fileDiff makes a unified diff of file with one inserted line after the first
// line of each node whose body changed.
function fileDiff(lines: string[], changed: N[], file: string): string {
  const hs = changed.filter((n) => n.file === file && n.line).map((n) => ({ at: n.line!, add: ['\t// changed in this revision'] }));
  hs.sort((a, b) => a.at - b.at);
  let out = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`;
  let shift = 0;
  for (const h of hs) {
    const ctxFrom = Math.max(1, h.at - 2),
      ctxTo = Math.min(lines.length, h.at + 3);
    const before = lines.slice(ctxFrom - 1, h.at);
    const after = lines.slice(h.at, ctxTo);
    const oldN = before.length + after.length;
    out += `@@ -${ctxFrom},${oldN} +${ctxFrom + shift},${oldN + h.add.length} @@\n`;
    for (const l of before) out += ' ' + l + '\n';
    for (const l of h.add) out += '+' + l + '\n';
    for (const l of after) out += ' ' + l + '\n';
    shift += h.add.length;
  }
  return out;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// handleRevs answers the rev-related requests and returns true, or returns false.
export function handleRevs(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  wt: G,
  project: () => Obj,
  readLines: (file: string) => string[] | null,
): boolean {
  const p = url.pathname;
  const q = url.searchParams;
  if (req.method !== 'GET') return false;
  if (p === '/api/revs') {
    send(res, 200, {
      commits,
      branches: ['agent/archive', 'main'],
      current: 'agent/archive',
      default: 'main',
      head: C3,
      dirty: true,
      prs: [{ number: 7, title: 'Archive old orders', headRefName: 'agent/archive', baseRefName: 'main', author: { login: 'agent' }, updatedAt: new Date(now - 3600e3).toISOString() }],
    });
    return true;
  }
  const range = (): [string, string] | null => {
    let from = q.get('from') || 'HEAD',
      to = q.get('to') || 'worktree';
    if (from.startsWith('pr:')) [from, to] = [C2, C3];
    const f = resolve(from),
      t = resolve(to);
    return f && t ? [f, t] : null;
  };
  if (p === '/api/diff') {
    const r = range();
    if (!r) return send(res, 422, { error: 'unknown revision' }), true;
    const a = graphAt(r[0], wt),
      b = graphAt(r[1], wt);
    send(res, 200, diff(a, b, r[0], r[1]));
    return true;
  }
  if (p === '/api/source/diff') {
    const r = range();
    const file = q.get('file') ?? '';
    const lines = readLines(file);
    if (!r || !lines) return send(res, 422, { error: 'bad request' }), true;
    const b = graphAt(r[1], wt);
    const d = diff(graphAt(r[0], wt), b, r[0], r[1]);
    const changed = b.nodes.filter((n) => d.changed.includes(n.id));
    send(res, 200, { file, from: r[0], to: r[1], diff: fileDiff(lines, changed, file) });
    return true;
  }
  const rev = q.get('rev');
  if (!rev || rev === 'worktree') return false;
  const at = resolve(rev);
  if (p === '/api/state') {
    if (!at) return send(res, 422, { error: 'unknown revision ' + rev }), true;
    send(res, 200, { graph: graphAt(at, wt), project: project(), versions: {} });
    return true;
  }
  return false; // /api/source at a rev: the mock serves the worktree's files
}
