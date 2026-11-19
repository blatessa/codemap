// Turns graph.json + .codemap state into what the map draws: boxes (modules,
// proposed modules) holding rows (nodes), and the edges between rows.
// Selection, call trees and test reach come from the Go walks (wasm.ts).
import type { GEdge, GModule, GNode, Graph, Loose, Proposal } from './types';
import { Walker, type Effect } from './wasm';

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
  doc?: string;
  external: boolean;
  module?: GModule;
  prop: boolean;
  ghost: boolean;
  rows: Row[];
  hasEntry: boolean;
}

export interface MEdge {
  i: number;
  from: string;
  to: string;
  type: string;
  detail?: string;
  prop: boolean;
  net: boolean;
  file?: string;
  line?: number;
  // synthetic edges of a selection's trace: a call through a skipped
  // forwarding function, or an effect reached through code the trace hides
  synth?: 'skip' | 'reach';
}

export interface Model {
  boxes: Box[];
  box: Map<string, Box>;
  node: Map<string, { row: Row; box: Box }>;
  edges: MEdge[];
  out: Map<string, MEdge[]>;
  inn: Map<string, MEdge[]>;
  tests: GNode[];
  // every node, tests included
  full: { node: Map<string, GNode> };
  // the graph's walks (graph.Trace and friends), over the graph with the
  // proposal's sketch; edges are numbered as in all.edges
  walk: Walker;
  all: { edges: MEdge[]; out: Map<string, MEdge[]>; inn: Map<string, MEdge[]> };
}

export const roleOf = (n: GNode): string => (typeof n.fields?.role === 'string' ? (n.fields.role as string) : '');
// sharedFn: widely used, with effects of its own or one call away (graph.AssignRoles): traces
// show it but don't go into it
export const sharedFn = (n: GNode): boolean => n.fields?.shared === true;
// onScreen: frontend code that is part of a page (graph.FoldScreens). A
// page's story shows what that code reaches, not the code.
export const onScreen = (n?: GNode): boolean => n?.fields?.screen === true;
// screenRoot: a screen itself, a router page or a top component.
export const screenRoot = (n?: GNode): boolean => n?.fields?.screen_root === true;

const ENTRY_PREFIX: Record<string, string> = { subscriber: 'SUB', command: 'CMD', function: 'MAIN', component: 'COMP' };

export function prefixOf(n: GNode): string {
  if (!n.entry) return '';
  const m = n.fields?.method;
  if (typeof m === 'string' && m) return m.toUpperCase().slice(0, 6);
  return ENTRY_PREFIX[n.kind] ?? n.kind.toUpperCase().slice(0, 5);
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
// Rows with a role are support code: never drawn, except on a proposal's
// edits; traces leave them out (trace).
export function buildModel(g: Graph, proposal: Proposal | null): Model {
  const mods = g.modules ?? [];
  const nodes = g.nodes ?? [];
  const gedges = g.edges ?? [];
  const box = new Map<string, Box>();
  const mkBox = (id: string, label: string, extra: Partial<Box> = {}): Box => {
    const b: Box = { id, label, external: false, prop: false, ghost: false, rows: [], hasEntry: false, ...extra };
    box.set(id, b);
    return b;
  };
  for (const m of mods) mkBox(m.id, m.label || m.id, { module: m, external: !!m.external, doc: m.doc });
  const node = new Map<string, { row: Row; box: Box }>();
  const fullNode = new Map<string, GNode>();
  const tests: GNode[] = [];
  const place = (n: GNode, prop: boolean, ghost: boolean) => {
    let b = box.get(n.module);
    if (!b) b = mkBox(n.module, n.module.replace(/^mod:[^:]+:/, ''), { ghost: true });
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
    if (!a || !b) return false;
    edges.push({
      i: edges.length,
      from: e.from,
      to: e.to,
      type: e.type || 'calls',
      detail: e.detail,
      prop,
      net: e.type === 'fetches',
      file: e.file,
      line: e.line,
    });
    return true;
  };
  const rest: GEdge[] = []; // tests' edges
  for (const e of gedges) if (!push(e, false)) rest.push(e);

  if (proposal) {
    for (const m of proposal.modules ?? []) {
      const id = str(m.id);
      if (!id || box.has(id)) continue;
      mkBox(id, str(m.label) || id, { prop: true });
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


  // public rows: entry points, external nodes, and anything with an edge leaving
  // its box
  for (const e of edges) {
    const a = node.get(e.from)!,
      b = node.get(e.to)!;
    if (a.box !== b.box) a.row.pub = b.row.pub = true;
  }

  const boxes: Box[] = [];
  for (const b of box.values()) {
    if (!b.rows.length && !b.prop) continue; // modules with only tests, or nothing
    b.rows.sort((x, y) => Number(x.prop || x.ghost) - Number(y.prop || y.ghost) || sortRows(x, y));
    for (const r of b.rows) {
      if (r.node.entry || r.node.external || r.prop || r.ghost) r.pub = true;
      if (shownRows.has(r.id)) r.pub = true;
    }
    b.hasEntry = b.rows.some((r) => r.node.entry);
    boxes.push(b);
  }
  return { boxes, box, node, edges, out, inn, tests, full: { node: fullNode }, all, walk: new Walker(walkGraph(edges, node, fullNode, rest)) };
}


// walkGraph is the graph the walks run over: the map's nodes and edges, the
// edges in the same order and the proposal's marked proposed, then the tests
// and the edges the map leaves out.
function walkGraph(edges: MEdge[], node: Map<string, { row: Row }>, all: Map<string, GNode>, rest: GEdge[]): Graph {
  const nodes: GNode[] = [];
  for (const { row } of node.values()) nodes.push(row.prop || row.ghost ? { ...row.node, proposed: true } : row.node);
  for (const n of all.values()) if (!node.has(n.id)) nodes.push(n);
  const out: GEdge[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    type: e.type,
    detail: e.detail,
    file: e.file,
    line: e.line,
    proposed: e.prop || undefined,
  }));
  return { version: 1, modules: [], nodes, edges: out.concat(rest) };
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
  extra: MEdge[]; // synthetic edges of the trace (MEdge.synth), numbered from SYNTH
  up: Set<string>;
  down: Set<string>;
}

// SYNTH numbers a selection's synthetic edges, above any real edge index.
export const SYNTH = 1 << 24;

export function selectionOf(m: Model, id: string): Sel | null {
  const S: Sel = { nodes: new Set(), edges: new Set(), up: new Set(), down: new Set(), path: new Set(), extra: [] };
  const synth = (from: string, to: string, type: string, kind: 'skip' | 'reach') => {
    const e: MEdge = { i: SYNTH + S.extra.length, from, to, type, prop: false, net: type === 'fetches', synth: kind };
    S.extra.push(e);
    S.edges.add(e.i);
  };
  const on = (n: string) => (S.nodes.add(n), S.down.add(n), S.path.add(n));
  if (m.node.has(id)) {
    // down: the trace, as in the details panel and codemap show
    const t = trace(m, id);
    on(id);
    const reach = (from: string, fs: Effect[]) => fs.forEach((f) => (on(f.to), synth(from, f.to, f.type, 'reach')));
    reach(id, t.reaches);
    for (const r of t.rows) {
      if (r.targets) continue;
      on(r.id);
      if (r.via.from === r.parent) S.edges.add(r.via.i);
      else synth(r.parent, r.id, r.via.type, 'skip');
      reach(r.id, r.reaches);
    }
    // up: everything that leads here
    const u = m.walk.up(id);
    u.nodes.forEach((n) => (S.nodes.add(n), S.up.add(n), S.path.add(n)));
    u.edges.forEach((e) => S.edges.add(e));
    return S;
  }
  // a part: its rows and every edge in or out of it
  const b = m.box.get(id);
  if (!b) return null;
  const own = new Set(b.rows.map((r) => r.id));
  own.forEach((n) => S.nodes.add(n));
  for (const e of m.edges) {
    if (own.has(e.from) || own.has(e.to)) {
      S.edges.add(e.i);
      S.nodes.add(e.from);
      S.nodes.add(e.to);
    }
  }
  return S;
}

export const entriesReaching = (m: Model, id: string): string[] => m.walk.entries(id);

// testsReaching: graph.Index.TestsReaching, direct tests first.
export function testsReaching(m: Model, ids: Iterable<string>): { test: GNode; direct: boolean; via: string }[] {
  return m.walk.tests([...ids]).flatMap((t) => {
    const test = m.full.node.get(t.test);
    return test ? [{ test, direct: t.direct, via: t.via ? (m.full.node.get(t.via)?.label ?? '') : '' }] : [];
  });
}

export type { Effect };

export interface TreeRow {
  id: string;
  via: MEdge;
  parent: string; // the row (or root) this one is drawn under
  depth: number;
  seen: boolean;
  more?: boolean; // has calls not shown: cut by depth, or a shared function
  targets?: string[]; // a wide call: it may go to any of these
  support: number; // support rows left out below this one
  reaches: Effect[]; // effects reached through code the trace doesn't show
}

export interface Trace {
  rows: TreeRow[];
  support: number; // the root's
  reaches: Effect[]; // the root's
}

export const isEffect = (m: Model, e: MEdge): boolean =>
  e.type === 'reads' ||
  e.type === 'writes' ||
  e.type === 'publishes' ||
  e.type === 'fetches' ||
  (e.type === 'calls' && !!m.node.get(e.to)?.row.node.external) ||
  (e.type === 'renders' && m.node.get(e.to)?.row.node.kind === 'screen'); // a server-rendered screen, as graph.IsEffect

// trace is graph.Trace, the one tree codemap shows below a node, in the CLI
// and here.
export function trace(m: Model, start: string): Trace {
  const t = m.walk.trace(start);
  return {
    support: t.support,
    reaches: t.reaches,
    rows: t.rows.map((r) => ({ ...r, via: m.all.edges[r.via], seen: !!r.seen })),
  };
}

// effectSummary words effects as codemap show does: "writes comment, issue ·
// reads user · calls api.stripe.com".
export function effectSummary(m: Model, fs: Effect[]): string {
  const by = new Map<string, string[]>();
  for (const f of fs) {
    const x = m.node.get(f.to);
    const l = x ? (x.row.prefix ? x.row.prefix + ' ' + x.row.label : x.row.label) : f.to;
    (by.get(f.type) ?? by.set(f.type, []).get(f.type)!).push(l);
  }
  return ['writes', 'reads', 'renders', 'publishes', 'calls', 'fetches']
    .filter((t) => by.has(t))
    .map((t) => (t === 'renders' ? 'shows' : t) + ' ' + by.get(t)!.sort().join(', '))
    .join(' · ');
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
