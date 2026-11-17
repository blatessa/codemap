// Turns graph.json + .codemap state into what the map draws: boxes (modules,
// blocks, proposed modules) holding rows (nodes), and the edges between rows.
// Also the walks behind selection, call trees and test reach (graph/query.go).
import { blockFor } from './blocks';
import type { Block, GEdge, GModule, GNode, Graph, Loose, Proposal } from './types';

export const ROW = 28,
  HEAD = 36,
  PAD = 8,
  FAR = 0.55,
  FARH = 64;

export interface Row {
  id: string;
  label: string;
  prefix: string; // method or kind for entry points
  tag: string; // kind, shown on external rows
  tagClass: string; // db | queue | http, from edge types
  node: GNode;
  prop: boolean; // added by the open proposal
  ghost: boolean; // referenced by the proposal but not in the code
}

export interface Box {
  id: string;
  label: string;
  sub: string;
  doc?: string;
  external: boolean;
  block?: Block; // a split of `from`
  from?: string;
  module?: GModule;
  prop: boolean;
  ghost: boolean;
  rows: Row[];
  w: number;
  hasEntry: boolean;
  propPos?: [number, number];
  propArea?: string;
}

export interface MEdge {
  i: number;
  from: string;
  to: string;
  type: string;
  detail?: string;
  declared: boolean;
  prop: boolean;
  net: boolean;
  file?: string;
  line?: number;
}

export interface Model {
  boxes: Box[];
  box: Map<string, Box>;
  node: Map<string, { row: Row; box: Box }>;
  edges: MEdge[];
  out: Map<string, MEdge[]>;
  inn: Map<string, MEdge[]>;
  tests: GNode[];
  full: { out: Map<string, GEdge[]>; node: Map<string, GNode> };
}

const ENTRY_PREFIX: Record<string, string> = { subscriber: 'SUB', function: 'MAIN', component: 'COMP' };

export function prefixOf(n: GNode): string {
  if (!n.entry) return '';
  const m = n.fields?.method;
  if (typeof m === 'string' && m) return m.toUpperCase().slice(0, 6);
  return ENTRY_PREFIX[n.kind] ?? n.kind.toUpperCase().slice(0, 5);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function subOf(rows: Row[], prop: boolean): string {
  if (!rows.length) return prop ? 'proposed' : 'empty';
  const kinds = new Set(rows.map((r) => r.node.kind));
  if (kinds.size === 1) return plural(rows.length, rows[0].node.kind);
  const e = rows.filter((r) => r.node.entry).length;
  if (e && e < rows.length) return `${plural(e, 'entry point')} · ${rows.length - e} more`;
  return plural(rows.length, 'item');
}

const CH = 7.25;
function widthOf(b: Box): number {
  let w = b.label.length * CH + 60;
  for (const r of b.rows) {
    const left = r.prefix ? 60 : 22;
    const right = r.tag ? r.tag.length * 6.2 + 20 : 12;
    w = Math.max(w, left + r.label.length * CH + right);
  }
  return Math.round(Math.min(440, Math.max(190, w)));
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function rowFor(n: GNode, prop: boolean, ghost: boolean): Row {
  return { id: n.id, label: n.label || n.id, prefix: prefixOf(n), tag: n.external ? n.kind : '', tagClass: '', node: n, prop, ghost };
}

const sortRows = (a: Row, b: Row) =>
  Number(!!b.node.entry) - Number(!!a.node.entry) ||
  str(a.node.file).localeCompare(str(b.node.file)) ||
  (a.node.line ?? 0) - (b.node.line ?? 0) ||
  a.label.localeCompare(b.label);

export const isTest = (n: GNode) => n.kind === 'test';

// buildModel derives the map. `proposal` is drawn over the graph when set.
export function buildModel(g: Graph, blocks: Block[], proposal: Proposal | null): Model {
  const mods = g.modules ?? [];
  const nodes = g.nodes ?? [];
  const gedges = g.edges ?? [];
  const box = new Map<string, Box>();
  const mkBox = (id: string, label: string, extra: Partial<Box> = {}): Box => {
    const b: Box = { id, label, sub: '', external: false, prop: false, ghost: false, rows: [], w: 0, hasEntry: false, ...extra };
    box.set(id, b);
    return b;
  };
  for (const m of mods) mkBox(m.id, m.label || m.id, { module: m, external: !!m.external, doc: m.doc });
  for (const b of blocks) {
    const src = box.get(b.from);
    if (!src || src.block) continue;
    mkBox(b.id, b.name, { block: b, from: b.from, external: src.external, doc: src.doc, module: src.module });
  }
  const node = new Map<string, { row: Row; box: Box }>();
  const fullNode = new Map<string, GNode>();
  const tests: GNode[] = [];
  const place = (n: GNode, prop: boolean, ghost: boolean) => {
    const bid = blockFor(blocks, n) || n.module;
    let b = box.get(bid);
    if (!b) b = mkBox(bid, bid.replace(/^mod:[^:]+:/, ''), { ghost: true });
    const row = rowFor(n, prop, ghost);
    b.rows.push(row);
    node.set(n.id, { row, box: b });
  };
  for (const n of nodes) {
    fullNode.set(n.id, n);
    if (isTest(n)) tests.push(n);
    else place(n, false, false);
  }

  const edges: MEdge[] = [];
  const push = (e: GEdge, prop: boolean) => {
    const a = node.get(e.from),
      b = node.get(e.to);
    if (!a || !b) return;
    edges.push({
      i: edges.length,
      from: e.from,
      to: e.to,
      type: e.type || 'calls',
      detail: e.detail,
      declared: !!e.declared,
      prop,
      net: e.type === 'fetches',
      file: e.file,
      line: e.line,
    });
  };
  for (const e of gedges) push(e, false);

  if (proposal) {
    for (const m of proposal.modules ?? []) {
      const id = str(m.id);
      if (!id || box.has(id)) continue;
      const pos = Array.isArray(m.pos) && m.pos.length === 2 ? ([Number(m.pos[0]), Number(m.pos[1])] as [number, number]) : undefined;
      mkBox(id, str(m.label) || id, { prop: true, propPos: pos, propArea: str(m.area) || undefined });
    }
    for (const raw of proposal.nodes ?? []) {
      const n = proposalNode(raw);
      if (!n || node.has(n.id)) continue;
      place(n, true, false);
    }
    const ghostBox = () => box.get('missing:') ?? mkBox('missing:', 'missing', { ghost: true });
    for (const raw of proposal.edges ?? []) {
      const from = str(raw.from),
        to = str(raw.to);
      if (!from || !to) continue;
      for (const id of [from, to]) {
        if (node.has(id)) continue;
        const b = ghostBox();
        const row = rowFor({ id, kind: 'missing', label: id.replace(/^new:/, ''), module: b.id }, false, true);
        b.rows.push(row);
        node.set(id, { row, box: b });
      }
      push({ from, to, type: str(raw.type) || 'calls', detail: str(raw.detail) || undefined }, true);
    }
  }

  const out = new Map<string, MEdge[]>(),
    inn = new Map<string, MEdge[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e);
  }
  // external rows get a colour from how they're used, never from their kind
  for (const { row } of node.values()) {
    if (!row.tag) continue;
    const types = new Set([...(inn.get(row.id) ?? []), ...(out.get(row.id) ?? [])].map((e) => e.type));
    row.tagClass = types.has('reads') || types.has('writes') ? 'db' : types.has('publishes') || types.has('subscribes') ? 'queue' : 'http';
  }

  const fullOut = new Map<string, GEdge[]>();
  for (const e of gedges) (fullOut.get(e.from) ?? fullOut.set(e.from, []).get(e.from)!).push(e);

  const boxes: Box[] = [];
  for (const b of box.values()) {
    if (!b.rows.length && !b.prop && !b.block) continue; // modules with only tests, or nothing
    b.rows.sort((x, y) => Number(x.prop || x.ghost) - Number(y.prop || y.ghost) || sortRows(x, y));
    b.hasEntry = b.rows.some((r) => r.node.entry);
    b.sub = subOf(b.rows, b.prop);
    b.w = widthOf(b);
    boxes.push(b);
  }
  return { boxes, box, node, edges, out, inn, tests, full: { out: fullOut, node: fullNode } };
}

export function proposalNode(raw: Loose): GNode | null {
  const id = str(raw.id);
  if (!id) return null;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!['id', 'kind', 'label', 'module', 'entry', 'external', 'file', 'line', 'doc'].includes(k)) fields[k] = v;
  return {
    id,
    kind: str(raw.kind) || 'function',
    label: str(raw.label) || id.replace(/^new:/, ''),
    module: str(raw.module),
    entry: !!raw.entry,
    external: !!raw.external,
    doc: str(raw.doc) || undefined,
    fields,
  };
}

// ---- walks ----

export interface Sel {
  nodes: Set<string>;
  edges: Set<number>;
  up: Set<string>;
  down: Set<string>;
}

function walk(m: Model, start: string, down: boolean): { nodes: Set<string>; edges: Set<number> } {
  const nodes = new Set([start]),
    edges = new Set<number>(),
    q = [start];
  const adj = down ? m.out : m.inn;
  while (q.length) {
    const n = q.shift()!;
    for (const e of adj.get(n) ?? []) {
      // paths stop at external nodes unless the external node itself is selected
      const via = down ? e.from : e.to;
      if (via !== start && m.node.get(via)?.row.node.external) continue;
      edges.add(e.i);
      const t = down ? e.to : e.from;
      if (!nodes.has(t)) {
        nodes.add(t);
        q.push(t);
      }
    }
  }
  return { nodes, edges };
}

export interface AreaLike {
  name: string;
  modules: string[] | null;
}

export function selectionOf(m: Model, ids: string[], areas: AreaLike[]): Sel | null {
  const S: Sel = { nodes: new Set(), edges: new Set(), up: new Set(), down: new Set() };
  let any = false;
  for (const id of ids) {
    if (m.node.has(id)) {
      const d = walk(m, id, true),
        u = walk(m, id, false);
      d.nodes.forEach((n) => (S.nodes.add(n), S.down.add(n)));
      u.nodes.forEach((n) => (S.nodes.add(n), S.up.add(n)));
      d.edges.forEach((e) => S.edges.add(e));
      u.edges.forEach((e) => S.edges.add(e));
      any = true;
      continue;
    }
    let bs: Box[] = [];
    if (id.startsWith('area:')) {
      const a = areas.find((x) => 'area:' + x.name === id);
      if (a) bs = (a.modules ?? []).map((x) => m.box.get(x)).filter((b): b is Box => !!b);
      if (!a) continue;
    } else {
      const b = m.box.get(id);
      if (!b) continue;
      bs = [b];
    }
    any = true;
    const own = new Set(bs.flatMap((b) => b.rows.map((r) => r.id)));
    own.forEach((n) => S.nodes.add(n));
    for (const e of m.edges) {
      if (own.has(e.from) || own.has(e.to)) {
        S.edges.add(e.i);
        S.nodes.add(e.from);
        S.nodes.add(e.to);
      }
    }
  }
  return any ? S : null;
}

export function entriesReaching(m: Model, id: string): string[] {
  const u = walk(m, id, false);
  return [...u.nodes].filter((n) => n !== id && m.node.get(n)?.row.node.entry);
}

// testsReaching ports graph.TestsReaching: reach follows calls and renders edges
// only, and never continues out of external nodes.
export function testsReaching(m: Model, ids: Iterable<string>): { test: GNode; direct: boolean; via: string }[] {
  const want = new Set(ids);
  const res: { test: GNode; direct: boolean; via: string }[] = [];
  for (const t of m.tests) {
    const outs = m.full.out.get(t.id) ?? [];
    const direct = outs.some((e) => want.has(e.to));
    const seen = new Set([t.id]),
      q = [t.id];
    let hit = false;
    while (q.length && !hit) {
      const n = q.shift()!;
      if (n !== t.id && m.full.node.get(n)?.external) continue;
      for (const e of m.full.out.get(n) ?? []) {
        if (e.type !== 'calls' && e.type !== 'renders') continue;
        if (!seen.has(e.to)) {
          if (want.has(e.to)) hit = true;
          seen.add(e.to);
          q.push(e.to);
        }
      }
    }
    if (hit) res.push({ test: t, direct, via: m.full.node.get(outs[0]?.to ?? '')?.label ?? '' });
  }
  return res.sort((a, b) => a.test.id.localeCompare(b.test.id));
}

export interface TreeRow {
  id: string;
  via: MEdge;
  depth: number;
  seen: boolean;
}

// callTree ports graph.Index.Tree: each node expands once, external nodes are leaves.
export function callTree(m: Model, start: string, max = 400): TreeRow[] {
  const seen = new Set([start]);
  const out: TreeRow[] = [];
  const rec = (id: string, depth: number) => {
    for (const e of m.out.get(id) ?? []) {
      if (out.length >= max) return;
      const again = seen.has(e.to);
      out.push({ id: e.to, via: e, depth, seen: again });
      if (!again) {
        seen.add(e.to);
        if (!m.node.get(e.to)?.row.node.external) rec(e.to, depth + 1);
      }
    }
  };
  rec(start, 0);
  return out;
}

// qualified name for lists: "orders.Service.Place", "POST /orders", "orders"
export function qn(m: Model, id: string): string {
  const x = m.node.get(id);
  if (!x) return id;
  const { row, box } = x;
  if (row.prefix) return `${row.prefix} ${row.label}`;
  if (row.node.external || row.ghost || box.hasEntry && row.node.entry) return row.label;
  const seg = (box.module?.label ?? box.label).split('/').pop();
  return seg ? `${seg}.${row.label}` : row.label;
}

export const shortMod = (m: Model, id: string) => {
  const x = m.node.get(id);
  if (!x || x.row.prefix || x.row.node.external || x.row.ghost) return '';
  const seg = (x.box.module?.label ?? x.box.label).split('/').pop();
  return seg ? seg + '.' : '';
};

export const isWriteDetail = (d?: string) => /^\s*(INSERT|UPDATE|DELETE)/i.test(d ?? '');
