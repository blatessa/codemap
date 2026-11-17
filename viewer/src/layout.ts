// Places boxes that have no saved position with ELK (layered, left to right),
// running in a Web Worker. Boxes with a position never move.
import ELK from 'elkjs/lib/elk-api.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { HEAD, PAD, ROW } from './model';

let elk: InstanceType<typeof ELK> | null = null;
const getElk = () => (elk ??= new ELK({ workerUrl }));

export interface LBox {
  id: string;
  w: number;
  rows: number;
  entry?: boolean;
  external?: boolean;
}
export type Pos = Record<string, [number, number]>;

export const fullHeight = (rows: number) => HEAD + Math.max(rows, 1) * ROW + PAD;

// AREA_PAD matches how areas are drawn around their members (see MapView).
const AREA_PAD = '[top=44,left=20,bottom=20,right=20]';

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

// columnLayout is the fallback for very large maps, where ELK gets slow and its
// layers get very tall: boxes go in columns by distance from the entry points,
// and a column wraps when it gets taller than a roughly 16:9 map would allow.
function columnLayout(todo: LBox[], rank: Map<string, number>, areaOf: Map<string, string>): Pos {
  const GAPX = 70,
    GAPY = 28;
  const maxRank = Math.max(0, ...[...rank.values()]);
  const col = (b: LBox) => (b.external ? maxRank + 2 : rank.get(b.id) ?? maxRank + 1);
  const area = todo.reduce((s, b) => s + (b.w + GAPX) * (fullHeight(b.rows) + GAPY), 0);
  const maxH = Math.max(1200, Math.sqrt((area * 9) / 16));
  const sorted = [...todo].sort((a, b) => col(a) - col(b) || (areaOf.get(a.id) ?? '~').localeCompare(areaOf.get(b.id) ?? '~') || a.id.localeCompare(b.id));
  const out: Pos = {};
  let x = 0,
    y = 0,
    w = 0,
    c = -1;
  for (const b of sorted) {
    const h = fullHeight(b.rows);
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

export async function layoutUnplaced(
  boxes: LBox[],
  links: [string, string][],
  areas: { name: string; modules: string[] }[],
  fixed: Pos,
): Promise<Pos> {
  const { order, rank } = flowOrder(boxes, links);
  const todo = boxes.filter((b) => !fixed[b.id]).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  if (!todo.length) return {};
  if (todo.length > 150) {
    const areaOf = new Map<string, string>();
    for (const a of areas) for (const m of a.modules) if (!areaOf.has(m)) areaOf.set(m, a.name);
    return offset(columnLayout(todo, rank, areaOf), boxes, fixed);
  }
  const ids = new Set(todo.map((b) => b.id));
  const parent = new Map<string, string>();
  const children: ElkNode[] = [];
  const groups = new Map<string, ElkNode>();
  const areaOrder = (a: { modules: string[] }) => Math.min(...a.modules.map((m) => order.get(m) ?? 1e9));
  for (const a of [...areas].sort((x, y) => areaOrder(x) - areaOrder(y))) {
    const mine = a.modules.filter((m) => ids.has(m) && !parent.has(m));
    if (!mine.length) continue;
    const g: ElkNode = { id: 'area:' + a.name, layoutOptions: { 'elk.padding': AREA_PAD }, children: [] };
    groups.set(g.id, g);
    children.push(g);
    mine.forEach((m) => parent.set(m, g.id));
  }
  for (const b of todo) {
    const n: ElkNode = { id: b.id, width: b.w, height: fullHeight(b.rows) };
    const p = parent.get(b.id);
    (p ? groups.get(p)!.children! : children).push(n);
  }
  // Big graphs: give ELK only each box's strongest few links. Layering and
  // crossing minimisation grow fast with edges, and the map draws real edges anyway.
  const weight = new Map<string, Map<string, number>>();
  for (const [a, b] of links) {
    if (a === b || !ids.has(a) || !ids.has(b)) continue;
    const m = weight.get(a) ?? weight.set(a, new Map()).get(a)!;
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  const big = todo.length > 60;
  const perBox = todo.length > 150 ? 2 : 3;
  const edges: ElkExtendedEdge[] = [];
  for (const b of todo) {
    const outs = [...(weight.get(b.id) ?? [])].sort((x, y) => y[1] - x[1] || order.get(x[0])! - order.get(y[0])!);
    for (const [t] of big ? outs.slice(0, perBox) : outs) edges.push({ id: 'e' + edges.length, sources: [b.id], targets: [t] });
  }
  const res = await getElk().layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.nodeNode': '28',
      'elk.spacing.componentComponent': '60',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.edgeRouting': 'POLYLINE', // routes aren't used; the map draws its own curves
      ...(big ? { 'elk.layered.thoroughness': '2' } : {}),
    },
    children,
    edges,
  });
  const out: Pos = {};
  const visit = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0),
        y = oy + (c.y ?? 0);
      if (ids.has(c.id)) out[c.id] = [Math.round(x), Math.round(y)];
      visit(c, x, y);
    }
  };
  visit(res, 0, 0);
  return offset(out, boxes, fixed);
}

// offset moves newly placed boxes below whatever is already placed.
function offset(out: Pos, boxes: LBox[], fixed: Pos): Pos {
  const placed = Object.entries(fixed).filter(([k]) => !k.startsWith('area:'));
  let oy = 80,
    ox = 20;
  if (placed.length) {
    const hOf = new Map(boxes.map((b) => [b.id, fullHeight(b.rows)]));
    oy = Math.max(...placed.map(([k, [, y]]) => y + (hOf.get(k) ?? 100))) + 110;
    ox = Math.min(...placed.map(([, [x]]) => x));
  }
  for (const k in out) out[k] = [out[k][0] + ox, out[k][1] + oy];
  return out;
}
