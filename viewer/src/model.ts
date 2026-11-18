// Turns graph.json + .codemap state into what the map draws: boxes (modules,
// blocks, proposed modules) holding rows (nodes), and the edges between rows.
// Also the walks behind selection, call trees and test reach (graph/query.go).
import { blockFor } from './blocks';
import type { Block, GEdge, GModule, GNode, Graph, Loose, Proposal } from './types';

export const ROW = 28,
  HEAD = 36,
  PAD = 8,
  MORE = 24, // the "+N internal" row
  FAR = 0.55,
  FARH = 64;

// heightOf is a box's height showing `rows` rows, plus the "+N internal" row when `more`.
export const heightOf = (rows: number, more: boolean) => HEAD + (more ? rows : Math.max(rows, 1)) * ROW + (more ? MORE : 0) + PAD;

export interface Row {
  id: string;
  label: string;
  prefix: string; // method or kind for entry points
  tag: string; // kind, shown on external rows
  tagClass: string; // db | queue | http, from edge types
  node: GNode;
  prop: boolean; // added by the open proposal
  ghost: boolean; // referenced by the proposal but not in the code
  pub: boolean; // shown by default: entry, external, or an edge crosses the box
  role: string; // fields.role: wiring, utility, passthrough, … ('' is core)
  moved?: string; // the proposal moves this existing node here from that module (its label)
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
  pub: number; // public rows
  defH: number; // height with only public rows showing at the Code level (what layout uses)
  shared: boolean; // used by most other modules; laid out along the bottom
  usedBy: number; // modules with edges into this one
  group?: string; // set on a folder group's box (groups.ts)
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
  via?: string[]; // passthroughs collapsed into this edge (Features)
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
  all: { edges: MEdge[]; out: Map<string, MEdge[]>; inn: Map<string, MEdge[]> };
}

export const roleOf = (n: GNode): string => (typeof n.fields?.role === 'string' ? (n.fields.role as string) : '');

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
  return {
    id: n.id,
    label: n.label || n.id,
    prefix: prefixOf(n),
    tag: n.external ? n.kind : '',
    tagClass: '',
    node: n,
    prop,
    ghost,
    pub: false,
    role: prop || ghost ? '' : roleOf(n),
  };
}

const sortRows = (a: Row, b: Row) =>
  Number(!!b.node.entry) - Number(!!a.node.entry) ||
  str(a.node.file).localeCompare(str(b.node.file)) ||
  (a.node.line ?? 0) - (b.node.line ?? 0) ||
  a.label.localeCompare(b.label);

// shownRows lets the compare view keep changed rows on show (revs.ts).
export const shownRows = { has: (_id: string) => false };

export const isTest = (n: GNode) => n.kind === 'test';

// buildModel derives the map. `proposal` is drawn over the graph when set.
// At the Features level, rows with a role are support rows, and edges through
// passthroughs are drawn straight to where they lead (A → C for A → P → C).
export function buildModel(g: Graph, blocks: Block[], proposal: Proposal | null): Model {
  const mods = g.modules ?? [];
  const nodes = g.nodes ?? [];
  const gedges = g.edges ?? [];
  const box = new Map<string, Box>();
  const mkBox = (id: string, label: string, extra: Partial<Box> = {}): Box => {
    const b: Box = { id, label, sub: '', external: false, prop: false, ghost: false, rows: [], w: 0, hasEntry: false, pub: 0, defH: 0, shared: false, usedBy: 0, ...extra };
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
      if (!n) continue;
      const cur = node.get(n.id);
      if (!cur) {
        place(n, true, false);
        continue;
      }
      // an existing node listed with another module: the proposal moves it
      const to = n.module ? box.get(n.module) : undefined;
      if (!to || to === cur.box) continue;
      cur.box.rows = cur.box.rows.filter((r) => r !== cur.row);
      cur.row.moved = cur.box.label;
      to.rows.push(cur.row);
      node.set(n.id, { row: cur.row, box: to });
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

  const index = (list: MEdge[]) => {
    const o = new Map<string, MEdge[]>(),
      n = new Map<string, MEdge[]>();
    for (const e of list) {
      (o.get(e.from) ?? o.set(e.from, []).get(e.from)!).push(e);
      (n.get(e.to) ?? n.set(e.to, []).get(e.to)!).push(e);
    }
    return { out: o, inn: n };
  };
  const all = { edges, ...index(edges) };
  const { out, inn } = all;
  // external rows get a colour from how they're used, never from their kind
  for (const { row } of node.values()) {
    if (!row.tag) continue;
    const types = new Set([...(inn.get(row.id) ?? []), ...(out.get(row.id) ?? [])].map((e) => e.type));
    row.tagClass = types.has('reads') || types.has('writes') ? 'db' : types.has('publishes') || types.has('subscribes') ? 'queue' : 'http';
  }

  const fullOut = new Map<string, GEdge[]>();
  for (const e of gedges) (fullOut.get(e.from) ?? fullOut.set(e.from, []).get(e.from)!).push(e);

  // public rows: entry points, external nodes, and anything with an edge leaving
  // its box
  for (const e of edges) {
    const a = node.get(e.from)!,
      b = node.get(e.to)!;
    if (a.box !== b.box) a.row.pub = b.row.pub = true;
  }

  const boxes: Box[] = [];
  for (const b of box.values()) {
    if (!b.rows.length && !b.prop && !b.block) continue; // modules with only tests, or nothing
    b.rows.sort((x, y) => Number(x.prop || x.ghost) - Number(y.prop || y.ghost) || sortRows(x, y));
    for (const r of b.rows) {
      if (r.node.entry || r.node.external || r.prop || r.ghost) r.pub = true;
      if (shownRows.has(r.id)) r.pub = true;
    }
    b.pub = b.rows.filter((r) => r.pub).length;
    // layout sizes a box for what it shows at rest (MapView's visible): a box
    // that shows more for a selection is drawn above its neighbours
    const lp = b.rows.filter((r) => r.node.entry || r.node.external || r.prop || r.ghost).length;
    b.defH = heightOf(lp, lp < b.rows.length);
    b.hasEntry = b.rows.some((r) => r.node.entry);
    b.sub = subOf(b.rows, b.prop);
    b.w = widthOf(b);
    boxes.push(b);
  }
  markShared(boxes, box, node, gedges, fullNode, blocks);
  return { boxes, box, node, edges, out, inn, tests, full: { out: fullOut, node: fullNode }, all };
}

// markShared finds modules that most others depend on (a graph package, a config
// package): at least 40% of the other modules in their part of the map (minimum 3)
// have edges into them, and they call at most one other module. Callers count by
// module, tests included, since a module's tests depend on what they call too.
export const SHARED_SHARE = 0.4;
function markShared(
  boxes: Box[],
  box: Map<string, Box>,
  node: Map<string, { row: Row; box: Box }>,
  gedges: GEdge[],
  full: Map<string, GNode>,
  blocks: Block[],
) {
  const cand = new Set(boxes.filter((b) => !b.external && !b.prop && !b.ghost).map((b) => b.id));
  const boxOf = (id: string): string | undefined => {
    const x = node.get(id);
    if (x) return x.box.id;
    const n = full.get(id);
    if (!n) return undefined;
    const b = box.get(blockFor(blocks, n) || n.module);
    return b ? b.id : undefined;
  };
  const users = new Map<string, Set<string>>(),
    calls = new Map<string, Set<string>>(),
    parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const add = (m: Map<string, Set<string>>, k: string, v: string) => (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v);
  for (const e of gedges) {
    const a = boxOf(e.from),
      b = boxOf(e.to);
    if (!a || !b || a === b || !cand.has(a) || !cand.has(b)) continue;
    add(users, b, a);
    if (!isTest(full.get(e.from)!)) add(calls, a, b);
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const size = new Map<string, number>();
  for (const id of cand) size.set(find(id), (size.get(find(id)) ?? 0) + 1);
  for (const id of cand) {
    const b = box.get(id)!;
    b.usedBy = users.get(id)?.size ?? 0;
    const others = size.get(find(id))! - 1;
    b.shared = b.usedBy >= Math.max(3, Math.ceil(SHARED_SHARE * others)) && (calls.get(id)?.size ?? 0) <= 1;
  }
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
  path: Set<string>; // rows on a traced path; always drawn, even when internal
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

export function selectionOf(m: Model, ids: string[], areas: AreaLike[], groups?: Map<string, { members: string[] }>): Sel | null {
  const S: Sel = { nodes: new Set(), edges: new Set(), up: new Set(), down: new Set(), path: new Set() };
  let any = false;
  for (const id of ids) {
    if (m.node.has(id)) {
      const d = walk(m, id, true),
        u = walk(m, id, false);
      d.nodes.forEach((n) => (S.nodes.add(n), S.down.add(n), S.path.add(n)));
      u.nodes.forEach((n) => (S.nodes.add(n), S.up.add(n), S.path.add(n)));
      d.edges.forEach((e) => S.edges.add(e));
      u.edges.forEach((e) => S.edges.add(e));
      any = true;
      continue;
    }
    let bs: Box[] = [];
    if (id.startsWith('group:')) {
      const g = groups?.get(id);
      if (!g) continue;
      bs = g.members.map((x) => m.box.get(x)).filter((b): b is Box => !!b);
    } else if (id.startsWith('area:')) {
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

// callTree ports graph.Index.Tree: each node expands once, external nodes are
// leaves. It walks every edge, passthroughs included; the panel dims support rows.
export function callTree(m: Model, start: string, max = 400): TreeRow[] {
  const seen = new Set([start]);
  const out: TreeRow[] = [];
  const rec = (id: string, depth: number) => {
    for (const e of m.all.out.get(id) ?? []) {
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
