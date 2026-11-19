// Places boxes that have no position yet with ELK (layered, left to right, in
// dependency flow: entry points left, data and external systems right), running
// in a Web Worker. Boxes with a position never move.
import ELK from 'elkjs/lib/elk-api.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';

let elk: InstanceType<typeof ELK> | null = null;
const getElk = () => (elk ??= new ELK({ workerUrl }));

export interface LBox {
  id: string;
  w: number;
  h: number; // default height: public rows only
  entry?: boolean;
  external?: boolean;
  shared?: boolean; // goes in the bottom row
}
export type Pos = Record<string, [number, number]>;

// PER_BOX is how many of each box's calls ELK sees (its strongest).
const PER_BOX = 3;

// flowOrder sorts boxes so entry points come first and the rest follow by
// distance from them; ELK breaks cycles by this order, so the map reads left to right.
function flowOrder(boxes: LBox[], links: [string, string][]): { order: Map<string, number>; rank: Map<string, number> } {
  const out = new Map<string, string[]>(),
    hasIn = new Set<string>();
  for (const [a, b] of links) {
    if (a === b) continue;
    (out.get(a) ?? out.set(a, []).get(a)!).push(b);
    hasIn.add(b);
  }
  let start = boxes.filter((b) => b.entry && !hasIn.has(b.id));
  if (!start.length) start = boxes.filter((b) => b.entry);
  if (!start.length) start = boxes.filter((b) => !hasIn.has(b.id));
  const rank = new Map<string, number>();
  const q = start.map((b) => b.id);
  q.forEach((id) => rank.set(id, 0));
  while (q.length) {
    const id = q.shift()!;
    for (const t of out.get(id) ?? [])
      if (!rank.has(t)) {
        rank.set(t, rank.get(id)! + 1);
        q.push(t);
      }
  }
  const sorted = [...boxes].sort(
    (a, b) => Number(!!a.external) - Number(!!b.external) || (rank.get(a.id) ?? 1e6) - (rank.get(b.id) ?? 1e6) || a.id.localeCompare(b.id),
  );
  return { order: new Map(sorted.map((b, i) => [b.id, i])), rank };
}

// columnLayout places boxes in columns by distance from the entry points, a
// column wrapping when it gets taller than a roughly 16:9 block would allow.
// It's synchronous, so an open folder group lays out in place (innerLayout).
function columnLayout(todo: LBox[], rank: Map<string, number>, minH = 1200, GAPX = 70, GAPY = 28): Pos {
  const maxRank = Math.max(0, ...[...rank.values()]);
  const col = (b: LBox) => (b.external ? maxRank + 2 : rank.get(b.id) ?? maxRank + 1);
  const area = todo.reduce((s, b) => s + (b.w + GAPX) * (b.h + GAPY), 0);
  const maxH = Math.max(minH, ...todo.map((b) => b.h), Math.sqrt((area * 9) / 16));
  const sorted = [...todo].sort((a, b) => col(a) - col(b) || a.id.localeCompare(b.id));
  const out: Pos = {};
  let x = 0,
    y = 0,
    w = 0,
    c = -1;
  for (const b of sorted) {
    const h = b.h;
    if (col(b) !== c || y + h > maxH) {
      x += w ? w + GAPX : 0;
      y = 0;
      w = 0;
      c = col(b);
    }
    out[b.id] = [x, y];
    y += h + GAPY;
    w = Math.max(w, b.w);
  }
  return out;
}

// innerLayout places what an open folder group shows, at once and in place:
// columns by distance from its entry points, wrapping into a wide block.
export function innerLayout(items: LBox[], links: [string, string][]): { pos: Pos; w: number; h: number } {
  if (!items.length) return { pos: {}, w: 0, h: 0 };
  const ids = new Set(items.map((b) => b.id));
  const inner = links.filter(([a, b]) => a !== b && ids.has(a) && ids.has(b));
  const { order, rank } = flowOrder(items, inner);
  const sorted = [...items].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const pos = columnLayout(sorted, rank, 0, 50, 24);
  let w = 0,
    h = 0;
  for (const b of items) {
    w = Math.max(w, pos[b.id][0] + b.w);
    h = Math.max(h, pos[b.id][1] + b.h);
  }
  return { pos, w, h };
}

export async function layoutUnplaced(boxes: LBox[], links: [string, string][], fixed: Pos): Promise<Pos> {
  const unplaced = boxes.filter((b) => !fixed[b.id]);
  if (!unplaced.length) return {};
  // shared modules go in a row along the bottom, out of the flow
  const bottom = unplaced.filter((b) => b.shared);
  const low = new Set(bottom.map((b) => b.id));
  const flow = links.filter(([a, b]) => !low.has(a) && !low.has(b));
  const { order } = flowOrder(boxes.filter((b) => !low.has(b.id)), flow);
  const todo = unplaced.filter((b) => !low.has(b.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const out = todo.length ? await layoutFlow(todo, flow, order) : {};
  sharedRow(out, todo, bottom, links);
  return offset(out, boxes, fixed);
}

// sharedRow places shared boxes in a row under everything else, each as close
// as it can get to below the middle of the boxes that use it.
function sharedRow(out: Pos, placed: LBox[], bottom: LBox[], links: [string, string][]) {
  if (!bottom.length) return;
  const wOf = new Map(placed.map((b) => [b.id, b]));
  let y = 0,
    x0 = 0;
  const ps = placed.filter((b) => out[b.id]);
  if (ps.length) {
    y = Math.max(...ps.map((b) => out[b.id][1] + b.h)) + 90;
    x0 = Math.min(...ps.map((b) => out[b.id][0]));
  }
  const want = new Map<string, number>();
  for (const b of bottom) {
    const xs = links.filter(([f, t]) => t === b.id && f !== t && out[f] && wOf.has(f)).map(([f]) => out[f][0] + wOf.get(f)!.w / 2);
    want.set(b.id, xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length - b.w / 2 : 1e9);
  }
  const sorted = [...bottom].sort((a, b) => want.get(a.id)! - want.get(b.id)! || a.id.localeCompare(b.id));
  let x = x0;
  for (const b of sorted) {
    const w = want.get(b.id)!;
    x = Math.max(x, w < 1e8 ? Math.round(w) : x);
    out[b.id] = [x, y];
    x += b.w + 40;
  }
}

// layoutFlow lays the boxes out left to right with ELK in one pass. ELK gets
// each box's strongest few calls, on every map: layering and crossing
// minimisation grow fast with edges, and the map draws real calls itself.
async function layoutFlow(todo: LBox[], links: [string, string][], order: Map<string, number>): Promise<Pos> {
  const ids = new Set(todo.map((b) => b.id));
  const children: ElkNode[] = todo.map((b) => ({ id: b.id, width: b.w, height: b.h }));
  const weight = new Map<string, Map<string, number>>();
  for (const [a, b] of links) {
    if (a === b || !ids.has(a) || !ids.has(b)) continue;
    const m = weight.get(a) ?? weight.set(a, new Map()).get(a)!;
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  const edges: ElkExtendedEdge[] = [];
  for (const b of todo) {
    const outs = [...(weight.get(b.id) ?? [])].sort((x, y) => y[1] - x[1] || order.get(x[0])! - order.get(y[0])!);
    for (const [t] of outs.slice(0, PER_BOX)) edges.push({ id: 'e' + edges.length, sources: [b.id], targets: [t] });
  }
  const opts = {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.layered.spacing.nodeNodeBetweenLayers': '70',
    'elk.spacing.nodeNode': '28',
    'elk.spacing.componentComponent': '60',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    // one column per step of the flow: boxes are short at rest, so a column
    // holds many of them
    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
    'elk.edgeRouting': 'POLYLINE', // routes aren't used; the map draws its own curves
    'elk.layered.thoroughness': '2',
  };
  const res = await getElk().layout({ id: 'root', layoutOptions: opts, children, edges });
  const out: Pos = {};
  for (const c of res.children ?? []) out[c.id] = [Math.round(c.x ?? 0), Math.round(c.y ?? 0)];
  return pack(out, todo, links);
}

// pack lays ELK's connected components out in rows, roughly as wide as a
// screen, instead of one tall stack.
function pack(out: Pos, todo: LBox[], links: [string, string][]): Pos {
  const up = new Map<string, string>();
  const find = (x: string): string => {
    while (up.has(x)) x = up.get(x)!;
    return x;
  };
  const join = (a: string, b: string) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) up.set(ra, rb);
  };
  for (const [a, b] of links) if (out[a] && out[b]) join(a, b);
  const comps = new Map<string, { ids: string[]; x0: number; y0: number; x1: number; y1: number }>();
  for (const b of todo) {
    const p = out[b.id];
    if (!p) continue;
    const r = find(b.id);
    const c = comps.get(r) ?? comps.set(r, { ids: [], x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }).get(r)!;
    c.ids.push(b.id);
    c.x0 = Math.min(c.x0, p[0]);
    c.y0 = Math.min(c.y0, p[1]);
    c.x1 = Math.max(c.x1, p[0] + b.w);
    c.y1 = Math.max(c.y1, p[1] + b.h);
  }
  const list = [...comps.values()];
  if (list.length < 2) return out;
  const GAP = 90;
  const area = list.reduce((s, c) => s + (c.x1 - c.x0 + GAP) * (c.y1 - c.y0 + GAP), 0);
  const maxW = Math.max(Math.sqrt(area * 1.7), ...list.map((c) => c.x1 - c.x0));
  // biggest first, then ELK's order
  list.sort((a, b) => b.ids.length - a.ids.length || a.y0 - b.y0);
  const res: Pos = {};
  let x = 0,
    y = 0,
    rowH = 0;
  for (const c of list) {
    const w = c.x1 - c.x0,
      h = c.y1 - c.y0;
    if (x > 0 && x + w > maxW) {
      x = 0;
      y += rowH + GAP;
      rowH = 0;
    }
    for (const id of c.ids) res[id] = [Math.round(out[id][0] - c.x0 + x), Math.round(out[id][1] - c.y0 + y)];
    x += w + GAP;
    rowH = Math.max(rowH, h);
  }
  return res;
}

// offset moves newly placed boxes below whatever is already placed.
function offset(out: Pos, boxes: LBox[], fixed: Pos): Pos {
  const placed = Object.entries(fixed);
  let oy = 80,
    ox = 20;
  if (placed.length) {
    const hOf = new Map(boxes.map((b) => [b.id, b.h]));
    oy = Math.max(...placed.map(([k, [, y]]) => y + (hOf.get(k) ?? 100))) + 110;
    ox = Math.min(...placed.map(([, [x]]) => x));
  }
  for (const k in out) out[k] = [out[k][0] + ox, out[k][1] + oy];
  return out;
}
