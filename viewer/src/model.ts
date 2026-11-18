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
  wide?: number; // targets of this call's site, when more than WIDE_CALL
  // synthetic edges of a selection's trace: a call through a skipped
  // forwarding function, or an effect reached through code the trace hides
  synth?: 'skip' | 'reach';
}

// WIDE_CALL matches graph.WideCall: a call site with more targets than this (a
// call through an interface or function value with many implementations) is
// one step in traces, and isn't followed.
export const WIDE_CALL = 4;

export interface Model {
  boxes: Box[];
  box: Map<string, Box>;
  node: Map<string, { row: Row; box: Box }>;
  edges: MEdge[];
  out: Map<string, MEdge[]>;
  inn: Map<string, MEdge[]>;
  tests: GNode[];
  // the whole graph, tests included; wide holds edges of wide call sites
  full: { out: Map<string, GEdge[]>; inn: Map<string, GEdge[]>; node: Map<string, GNode>; wide: Set<GEdge> };
  all: { edges: MEdge[]; out: Map<string, MEdge[]>; inn: Map<string, MEdge[]> };
}

export const roleOf = (n: GNode): string => (typeof n.fields?.role === 'string' ? (n.fields.role as string) : '');
// sharedFn: widely used, with effects of its own or one call away (graph.AssignRoles): traces
// show it but don't go into it
export const sharedFn = (n: GNode): boolean => n.fields?.shared === true;
// stops reports whether traces stop at a node: utilities and shared functions
// are shown, but what they call isn't part of the trace
export const stops = (n: GNode): boolean => roleOf(n) === 'utility' || sharedFn(n);

const codeKind = (n?: GNode): boolean => n?.kind === 'function' || n?.kind === 'component';

// markWide: only code makes wide calls; a route's, job's or subscriber's edges
// share the registration's position but are separate calls (graph.NewIndex).
function markWide(edges: MEdge[], node: Map<string, GNode>) {
  const sites = new Map<string, MEdge[]>();
  for (const e of edges) {
    if (e.type !== 'calls' || e.prop || !e.file || !e.line || !codeKind(node.get(e.from))) continue;
    const k = e.from + '\0' + e.file + '\0' + e.line;
    (sites.get(k) ?? sites.set(k, []).get(k)!).push(e);
  }
  for (const es of sites.values()) if (es.length > WIDE_CALL) for (const e of es) e.wide = es.length;
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
  markWide(edges, fullNode);
  const all = { edges, ...index(edges) };
  const { out, inn } = all;
  // external rows get a colour from how they're used, never from their kind
  for (const { row } of node.values()) {
    if (!row.tag) continue;
    const types = new Set([...(inn.get(row.id) ?? []), ...(out.get(row.id) ?? [])].map((e) => e.type));
    row.tagClass = types.has('reads') || types.has('writes') ? 'db' : types.has('publishes') || types.has('subscribes') ? 'queue' : 'http';
  }

  const fullOut = new Map<string, GEdge[]>();
  const fullInn = new Map<string, GEdge[]>();
  const sites = new Map<string, GEdge[]>();
  for (const e of gedges) {
    (fullOut.get(e.from) ?? fullOut.set(e.from, []).get(e.from)!).push(e);
    (fullInn.get(e.to) ?? fullInn.set(e.to, []).get(e.to)!).push(e);
    if ((e.type || 'calls') === 'calls' && e.file && e.line && codeKind(fullNode.get(e.from))) {
      const k = e.from + '\0' + e.file + '\0' + e.line;
      (sites.get(k) ?? sites.set(k, []).get(k)!).push(e);
    }
  }
  const wide = new Set<GEdge>();
  for (const es of sites.values()) if (es.length > WIDE_CALL) for (const e of es) wide.add(e);

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
  return { boxes, box, node, edges, out, inn, tests, full: { out: fullOut, inn: fullInn, node: fullNode, wide }, all };
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
  extra: MEdge[]; // synthetic edges of the trace (MEdge.synth), numbered from SYNTH
  up: Set<string>;
  down: Set<string>;
}

// walkUp follows what leads to start, up to the entry points: never through a
// wide call (one of many possible targets isn't a caller of each) or out of
// an external node, unless that's what was selected.
function walkUp(m: Model, start: string): { nodes: Set<string>; edges: Set<number> } {
  const nodes = new Set([start]),
    edges = new Set<number>(),
    q = [start];
  while (q.length) {
    const n = q.shift()!;
    for (const e of m.inn.get(n) ?? []) {
      if (e.wide) continue;
      const vn = m.node.get(e.to)?.row.node;
      if (e.to !== start && vn?.external) continue;
      edges.add(e.i);
      if (!nodes.has(e.from)) {
        nodes.add(e.from);
        q.push(e.from);
      }
    }
  }
  return { nodes, edges };
}

export interface AreaLike {
  name: string;
  modules: string[] | null;
}

// SYNTH numbers a selection's synthetic edges, above any real edge index.
export const SYNTH = 1 << 24;

export function selectionOf(m: Model, ids: string[], areas: AreaLike[], groups?: Map<string, { members: string[] }>): Sel | null {
  const S: Sel = { nodes: new Set(), edges: new Set(), up: new Set(), down: new Set(), path: new Set(), extra: [] };
  const synth = (from: string, to: string, type: string, kind: 'skip' | 'reach') => {
    const e: MEdge = { i: SYNTH + S.extra.length, from, to, type, declared: false, prop: false, net: type === 'fetches', synth: kind };
    S.extra.push(e);
    S.edges.add(e.i);
  };
  const on = (n: string) => (S.nodes.add(n), S.down.add(n), S.path.add(n));
  let any = false;
  for (const id of ids) {
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
      const u = walkUp(m, id);
      u.nodes.forEach((n) => (S.nodes.add(n), S.up.add(n), S.path.add(n)));
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
  const u = walkUp(m, id);
  return [...u.nodes].filter((n) => n !== id && m.node.get(n)?.row.node.entry);
}

// TEST_CALLS matches graph.TestCalls: a test calls the code, or a helper that
// does; functions nested in another count as part of it.
export const TEST_CALLS = 2;

// testsReaching ports graph.TestsReaching: tests within TEST_CALLS calls of
// any of ids, over calls and renders edges, never through external nodes, wide
// calls or support code (utilities, shared functions); an external node's
// tests are those of the code using it. Direct tests first.
export function testsReaching(m: Model, ids: Iterable<string>): { test: GNode; direct: boolean; via: string }[] {
  const { inn, node, wide } = m.full;
  const found = new Map<string, { test: GNode; direct: boolean; via: string }>();
  const seen = new Set<string>();
  let frontier: string[] = [];
  const add = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      frontier.push(id);
    }
  };
  for (const id of ids) {
    if (node.get(id)?.external) {
      for (const e of inn.get(id) ?? []) {
        const f = node.get(e.from);
        if (e.type !== 'fetches' && !wide.has(e) && f && !f.external && !isTest(f)) add(e.from);
      }
    } else add(id);
  }
  for (let d = 0; d < TEST_CALLS && frontier.length; d++) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i++) {
      const id = frontier[i];
      for (const e of inn.get(id) ?? []) {
        const type = e.type || 'calls';
        if ((type !== 'calls' && type !== 'renders') || wide.has(e)) continue;
        const f = node.get(e.from);
        if (!f || f.external) continue;
        if (isTest(f)) {
          if (!found.has(f.id)) found.set(f.id, { test: f, direct: d === 0, via: d > 0 ? (node.get(id)?.label ?? '') : '' });
          continue;
        }
        if (!seen.has(f.id) && !stops(f)) {
          seen.add(f.id);
          // a function nested in another (a component's handler) is part of it
          if (id.startsWith(f.id + '.') && f.id.includes('#')) frontier.push(f.id);
          else next.push(f.id);
        }
      }
    }
    frontier = next;
  }
  return [...found.values()].sort((a, b) => (a.direct !== b.direct ? (a.direct ? -1 : 1) : a.test.id.localeCompare(b.test.id)));
}

// Effect is an edge into the outside world: a table read or written, a topic
// published to, an external service called, a route fetched.
export interface Effect {
  to: string;
  type: string;
}

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

// TREE_DEPTH matches cli.FeatureDepth.
export const TREE_DEPTH = 4;

const isEffect = (m: Model, e: MEdge): boolean =>
  e.type === 'reads' || e.type === 'writes' || e.type === 'publishes' || e.type === 'fetches' || (e.type === 'calls' && !!m.node.get(e.to)?.row.node.external);

// effectsBeneath ports graph.Index.EffectsBeneath: effects reachable over calls
// and renders that aren't wide, and through fetched routes, not going into utilities or shared functions
// (their own effects count).
export function effectsBeneath(m: Model, id: string): Effect[] {
  const seen = new Set([id]);
  const got = new Map<string, Effect>();
  const add = (e: MEdge) => got.set(e.type + '\0' + e.to, { to: e.to, type: e.type });
  const q = [id];
  while (q.length) {
    const x = q.shift()!;
    for (const e of m.all.out.get(x) ?? []) {
      if (e.prop) continue;
      if (isEffect(m, e)) {
        add(e);
        // a fetched route's own effects are this code's too
        if (e.type === 'fetches' && !seen.has(e.to)) {
          seen.add(e.to);
          q.push(e.to);
        }
        continue;
      }
      if ((e.type !== 'calls' && e.type !== 'renders') || e.wide || seen.has(e.to)) continue;
      const n = m.node.get(e.to)?.row.node;
      if (!n || n.external) continue;
      seen.add(e.to);
      if (stops(n)) {
        for (const f of m.all.out.get(e.to) ?? []) if (!f.prop && isEffect(m, f)) add(f);
        continue;
      }
      q.push(e.to);
    }
  }
  return [...got.values()].sort((a, b) => a.type.localeCompare(b.type) || a.to.localeCompare(b.to));
}

// trace ports cli.Trace, the one tree codemap shows below a node: support code
// left out (counted on the row above), forwarding functions skipped, shared
// functions and external systems not gone into, TREE_DEPTH levels deep, wide
// calls folded into one row, and every row listing the effects it reaches
// through code the trace doesn't show.
export function trace(m: Model, start: string): Trace {
  const seen = new Set([start]);
  const hasOut = (id: string) => (m.all.out.get(id)?.length ?? 0) > 0;
  type Kids = { rows: TreeRow[][]; support: number }; // each child with its subtree, preorder
  const kids = (id: string, parent: string, depth: number, hops = 0): Kids => {
    const res: Kids = { rows: [], support: 0 };
    const wide = new Map<string, TreeRow>();
    for (const e of m.all.out.get(id) ?? []) {
      if (e.wide) {
        const k = e.file + ':' + e.line;
        const w = wide.get(k);
        if (w) w.targets!.push(e.to);
        else {
          const r: TreeRow = { id: e.to, via: e, parent, depth, seen: false, targets: [e.to], support: 0, reaches: [] };
          wide.set(k, r);
          res.rows.push([r]);
        }
        continue;
      }
      const n = m.node.get(e.to)?.row.node;
      const role = n && !m.node.get(e.to)!.row.prop ? roleOf(n) : '';
      if (role === 'passthrough' && hops < 16) {
        if (seen.has(e.to) || !hasOut(e.to)) {
          res.support++;
          continue;
        }
        seen.add(e.to);
        const sub = kids(e.to, parent, depth, hops + 1); // its children take its place
        res.rows.push(...sub.rows);
        res.support += sub.support;
        continue;
      }
      if (role) {
        res.support++;
        continue;
      }
      const r: TreeRow = { id: e.to, via: e, parent, depth, seen: seen.has(e.to), support: 0, reaches: [] };
      const sub: TreeRow[] = [r];
      res.rows.push(sub);
      if (r.seen) continue;
      seen.add(e.to);
      if (!n || n.external) continue;
      if (stops(n) || depth + 1 >= TREE_DEPTH) {
        r.more = hasOut(e.to);
        continue;
      }
      const k = kids(e.to, e.to, depth + 1);
      r.support = k.support;
      for (const c of k.rows) sub.push(...c);
    }
    return res;
  };
  const top = kids(start, start, 0);
  const rows = top.rows.flat();

  // Rollup, bottom-up: a row lists the effects below it that its shown
  // subtree doesn't show, as an effect row or another row's list.
  const cache = new Map<string, Effect[]>();
  const beneath = (id: string) => cache.get(id) ?? (cache.set(id, effectsBeneath(m, id)), cache.get(id)!);
  const key = (f: Effect) => f.type + '\0' + f.to;
  const coveredBelow = (i: number): Set<string> => {
    // rows i+1… deeper than rows[i] are its subtree
    const cov = new Set<string>();
    for (let j = i + 1; j < rows.length && rows[j].depth > (i < 0 ? -1 : rows[i].depth); j++) {
      const r = rows[j];
      if (r.targets) continue;
      if (isEffect(m, r.via)) cov.add(key({ to: r.id, type: r.via.type }));
      r.reaches.forEach((f) => cov.add(key(f)));
      if (r.seen) beneath(r.id).forEach((f) => cov.add(key(f)));
    }
    return cov;
  };
  const rollup = (id: string, i: number): Effect[] => {
    const n = m.node.get(id)?.row.node;
    if (!n || n.external) return [];
    const cov = coveredBelow(i);
    return beneath(id).filter((f) => !cov.has(key(f)));
  };
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r.seen && !r.targets) r.reaches = rollup(r.id, i);
  }
  return { rows, support: top.support, reaches: rollup(start, -1) };
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
  return ['writes', 'reads', 'publishes', 'calls', 'fetches']
    .filter((t) => by.has(t))
    .map((t) => t + ' ' + by.get(t)!.sort().join(', '))
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
