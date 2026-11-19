// Lays boxes out left to right in dependency flow: entry points left, data and
// external systems right. The map (layoutMap) and an open folder group
// (innerLayout) go in columns, one per step of the flow, the same way on every
// map: at rest every box is the same short height, so columns read well, and
// it's instant for any number of boxes. A focused path (layoutPath) is laid
// out by ELK, in a Web Worker: it's small and draws its calls, so ELK's
// crossing minimisation pays off there. Boxes with a position never move.
import ELK from 'elkjs/lib/elk-api.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';

let elk: InstanceType<typeof ELK> | null = null;
const getElk = () => (elk ??= new ELK({ workerUrl }));

export interface LBox {
  id: string;
  w: number;
  h: number; // laid-out height
  entry?: boolean;
  external?: boolean;
  shared?: boolean; // goes in the bottom row
}
export type Pos = Record<string, [number, number]>;

// flowOrder sorts boxes so entry points come first and the rest follow by
// distance from them; cycles are broken by this order, so the map reads left to right.
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

// flowColumns places boxes in columns. A box's column is how many calls away
// from the entry points it is (the fewest), counting first from entry points
// nothing calls (a page calls the API's routes, so they come after it), then
// from the other entry points, then from the boxes nothing calls. A box nothing
// calls that isn't an entry point
// sits just left of what it calls. External systems take the last column.
// Within a column boxes sit near the boxes that call them. A column wraps when
// it gets taller than a roughly 16:9 block would allow (at least `minH`).
function flowColumns(items: LBox[], links: [string, string][], minH: number, GAPX: number, GAPY: number): Pos {
  if (!items.length) return {};
  const ids = new Set(items.map((b) => b.id));
  const inner = links.filter(([a, b]) => a !== b && ids.has(a) && ids.has(b));
  const { order } = flowOrder(items, inner);
  const byOrder = [...items].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const out1 = new Map<string, Set<string>>(),
    in1 = new Map<string, Set<string>>();
  for (const [a, b] of inner) {
    (out1.get(a) ?? out1.set(a, new Set()).get(a)!).add(b);
    (in1.get(b) ?? in1.set(b, new Set()).get(b)!).add(a);
  }
  const col = new Map<string, number>();
  const bfs = (start: LBox[]) => {
    const q = start.filter((b) => !col.has(b.id)).map((b) => b.id);
    q.forEach((id) => col.set(id, 0));
    for (let i = 0; i < q.length; i++)
      for (const t of out1.get(q[i]) ?? [])
        if (!col.has(t)) {
          col.set(t, col.get(q[i])! + 1);
          q.push(t);
        }
  };
  bfs(byOrder.filter((b) => b.entry && !b.external && !in1.has(b.id)));
  bfs(byOrder.filter((b) => b.entry && !b.external));
  bfs(byOrder.filter((b) => !in1.has(b.id) && !b.external));
  bfs(byOrder);
  for (const b of [...byOrder].reverse()) {
    const s = [...(out1.get(b.id) ?? [])].filter((t) => !items.find((x) => x.id === t)?.external);
    if (!b.entry && !in1.has(b.id) && s.length) col.set(b.id, Math.max(0, Math.min(...s.map((t) => col.get(t)!)) - 1));
  }
  const last = Math.max(0, ...items.filter((b) => !b.external).map((b) => col.get(b.id)!)) + 1;
  for (const b of items) if (b.external) col.set(b.id, last);
  // calls running left to right, for ordering within columns
  const preds = new Map<string, Set<string>>(),
    succs = new Map<string, Set<string>>();
  for (const [a, b] of inner) {
    if (col.get(a)! >= col.get(b)!) continue;
    (succs.get(a) ?? succs.set(a, new Set()).get(a)!).add(b);
    (preds.get(b) ?? preds.set(b, new Set()).get(b)!).add(a);
  }
  // order within columns: a sweep right by the callers' places, one back by the
  // callees', and one more right
  const cols = new Map<number, LBox[]>();
  for (const b of byOrder) (cols.get(col.get(b.id)!) ?? cols.set(col.get(b.id)!, []).get(col.get(b.id)!)!).push(b);
  const keys = [...cols.keys()].sort((a, b) => a - b);
  const at = new Map<string, number>();
  const number = () => keys.forEach((k) => cols.get(k)!.forEach((b, i) => at.set(b.id, i / Math.max(1, cols.get(k)!.length - 1))));
  number();
  const sweep = (ks: number[], nb: Map<string, Set<string>>) => {
    for (const k of ks) {
      const bc = (b: LBox) => {
        const ps = [...(nb.get(b.id) ?? [])].filter((x) => col.get(x) !== k);
        return ps.length ? ps.reduce((s, x) => s + at.get(x)!, 0) / ps.length : at.get(b.id)!;
      };
      const v = new Map(cols.get(k)!.map((b) => [b.id, bc(b)]));
      cols.get(k)!.sort((a, b) => v.get(a.id)! - v.get(b.id)! || order.get(a.id)! - order.get(b.id)!);
      cols.get(k)!.forEach((b, i) => at.set(b.id, i / Math.max(1, cols.get(k)!.length - 1)));
    }
  };
  sweep(keys, preds);
  sweep([...keys].reverse(), succs);
  sweep(keys, preds);
  const area = items.reduce((s, b) => s + (b.w + GAPX) * (b.h + GAPY), 0);
  const maxH = Math.max(minH, ...items.map((b) => b.h), Math.sqrt((area * 9) / 16));
  const out: Pos = {};
  let x = 0;
  for (const k of keys) {
    let y = 0,
      w = 0;
    for (const b of cols.get(k)!) {
      if (y > 0 && y + b.h > maxH) {
        x += w + GAPX;
        y = 0;
        w = 0;
      }
      out[b.id] = [x, y];
      y += b.h + GAPY;
      w = Math.max(w, b.w);
    }
    x += w + GAPX;
  }
  return out;
}

// innerLayout places what an open folder group shows, at once and in place.
export function innerLayout(items: LBox[], links: [string, string][]): { pos: Pos; w: number; h: number } {
  if (!items.length) return { pos: {}, w: 0, h: 0 };
  const pos = flowColumns(items, links, 0, 50, 24);
  let w = 0,
    h = 0;
  for (const b of items) {
    w = Math.max(w, pos[b.id][0] + b.w);
    h = Math.max(h, pos[b.id][1] + b.h);
  }
  return { pos, w, h };
}

// layoutMap places the map's boxes that have no position yet.
export function layoutMap(boxes: LBox[], links: [string, string][], fixed: Pos): Pos {
  const unplaced = boxes.filter((b) => !fixed[b.id]);
  if (!unplaced.length) return {};
  // shared modules go in a row along the bottom, out of the flow
  const bottom = unplaced.filter((b) => b.shared);
  const low = new Set(bottom.map((b) => b.id));
  const todo = unplaced.filter((b) => !low.has(b.id));
  const out = flowColumns(todo, links.filter(([a, b]) => !low.has(a) && !low.has(b)), 1000, 90, 28);
  sharedRow(out, todo, bottom, links);
  return offset(out, boxes, fixed);
}

// layoutPath lays a focused path out with ELK.
export async function layoutPath(boxes: LBox[], links: [string, string][], fixed: Pos): Promise<Pos> {
  const todo0 = boxes.filter((b) => !fixed[b.id]);
  if (!todo0.length) return {};
  const { order } = flowOrder(boxes, links);
  const todo = todo0.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return offset(await layoutFlow(todo, links), boxes, fixed);
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

// layoutFlow lays the boxes out left to right with ELK in one pass, one edge
// per pair of boxes that call each other.
async function layoutFlow(todo: LBox[], links: [string, string][]): Promise<Pos> {
  const ids = new Set(todo.map((b) => b.id));
  const children: ElkNode[] = todo.map((b) => ({ id: b.id, width: b.w, height: b.h }));
  const seen = new Set<string>();
  const edges: ElkExtendedEdge[] = [];
  for (const [a, b] of links) {
    if (a === b || !ids.has(a) || !ids.has(b) || seen.has(a + '\0' + b)) continue;
    seen.add(a + '\0' + b);
    edges.push({ id: 'e' + edges.length, sources: [a], targets: [b] });
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
    // spreads tall layers over more columns, so the path is wider than it is tall
    'elk.layered.layering.strategy': 'STRETCH_WIDTH',
    'elk.edgeRouting': 'POLYLINE', // routes aren't used; the map draws its own curves
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
