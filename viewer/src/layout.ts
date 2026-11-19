// Lays a program's parts out left to right in dependency flow, entry points
// left (parts.ts): columns, one per step of the flow. Every part is the same
// height, so columns read well, and it's instant for any number of parts.

export interface LBox {
  id: string;
  w: number;
  h: number; // laid-out height
  entry?: boolean;
  external?: boolean;
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
export function flowColumns(items: LBox[], links: [string, string][], minH: number, GAPX: number, GAPY: number): Pos {
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
