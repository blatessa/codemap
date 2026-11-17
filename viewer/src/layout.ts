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
function flowOrder(boxes: LBox[], links: [string, string][]): Map<string, number> {
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
  return new Map(sorted.map((b, i) => [b.id, i]));
}

export async function layoutUnplaced(
  boxes: LBox[],
  links: [string, string][],
  areas: { name: string; modules: string[] }[],
  fixed: Pos,
): Promise<Pos> {
  const order = flowOrder(boxes, links);
  const todo = boxes.filter((b) => !fixed[b.id]).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  if (!todo.length) return {};
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
  const seen = new Set<string>();
  const edges: ElkExtendedEdge[] = [];
  for (const [a, b] of links) {
    if (a === b || !ids.has(a) || !ids.has(b)) continue;
    const k = a + '>' + b;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ id: 'e' + edges.length, sources: [a], targets: [b] });
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
      'elk.edgeRouting': 'SPLINES',
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
  // new boxes go below whatever is already placed
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
