// The map at the level codemap draws: programs and their parts, the resources
// they use (tables, services, channels, screens), and how they talk. Functions
// are never drawn; a function's edges count towards its part's. Pure: the map
// component draws what this returns.
import { flowColumns, type LBox } from './layout';
import type { Box, MEdge, Model } from './model';

export const PART_H = 44;
export const CHIP_H = 26;
const CHIP_GAP = 6;
const FPAD = 24; // a frame's padding
const FTOP = 40; // a frame's title bar
const FGAP = 80; // between frames

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Frame extends Rect {
  id: string; // 'program:<name>' or a resource module's id
  label: string;
  resource: boolean;
}
// A Link is every edge between two things of one kind, as one line.
export type LinkKind = 'calls' | 'http' | 'event' | 'reads' | 'writes' | 'shows';
export interface Link {
  key: string;
  from: string; // a part's box id or a resource's node id
  to: string;
  kind: LinkKind;
  edges: number[]; // the function edges it stands for (MEdge.i)
  prop: boolean; // only proposed edges
}
export interface Parts {
  frames: Frame[];
  at: Map<string, Rect>; // every thing: parts by box id, resources by node id
  links: Link[];
  thingOf: (nodeId: string) => string | undefined;
  programOf: (thing: string) => string;
}

// A resource is a node in an external module: a table, a service, a topic, a
// server-rendered screen. Everything else is code, drawn as its part.
export const isResourceBox = (b: Box) => b.external;

export function thingFn(m: Model): (id: string) => string | undefined {
  return (id) => {
    const x = m.node.get(id);
    if (!x) return undefined;
    return isResourceBox(x.box) ? id : x.box.id;
  };
}

export function linkKind(m: Model, e: MEdge): LinkKind {
  switch (e.type) {
    case 'fetches':
      return 'http';
    case 'publishes':
    case 'subscribes':
      return 'event';
    case 'reads':
      return 'reads';
    case 'writes':
      return 'writes';
    case 'renders':
      return m.node.get(e.to)?.box.external ? 'shows' : 'calls';
  }
  return 'calls';
}

export function linksOf(m: Model, edges: Iterable<MEdge>): Link[] {
  const thing = thingFn(m);
  const by = new Map<string, Link>();
  for (const e of edges) {
    const a = thing(e.from),
      b = thing(e.to);
    if (!a || !b || a === b) continue;
    const kind = linkKind(m, e);
    const key = a + '>' + b + '>' + kind;
    const l = by.get(key) ?? by.set(key, { key, from: a, to: b, kind, edges: [], prop: true }).get(key)!;
    l.edges.push(e.i);
    l.prop &&= e.prop;
  }
  return [...by.values()];
}

// wide enough for its name (mono 12px) and what it holds (sans 10.5px)
export const partWidth = (b: Box) => Math.max(170, b.label.length * 7.4 + 44, partSub(b).length * 5.6 + 36);
const chipWidth = (label: string) => Math.max(110, Math.min(260, label.length * 7 + 28));

// sub is what a part holds, by kind: "2 routes · 1 job · 13 functions".
export function partSub(b: Box): string {
  const words: Record<string, [string, string]> = {
    route: ['route', 'routes'],
    page: ['page', 'pages'],
    command: ['command', 'commands'],
    job: ['job', 'jobs'],
    subscriber: ['subscriber', 'subscribers'],
  };
  const n = new Map<string, number>();
  let fns = 0,
    proposed = 0;
  for (const r of b.rows) {
    if (r.prop || r.moved) {
      proposed++;
      continue;
    }
    const k = r.node.entry && words[r.node.kind] ? r.node.kind : r.node.entry && r.node.fields?.screen_root ? 'screen' : '';
    if (k) n.set(k, (n.get(k) ?? 0) + 1);
    else fns++;
  }
  const out = [...n].map(([k, c]) => `${c} ${k === 'screen' ? (c === 1 ? 'screen' : 'screens') : words[k][c === 1 ? 0 : 1]}`);
  if (fns) out.push(`${fns} function${fns === 1 ? '' : 's'}`);
  if (proposed) out.push(`${proposed} proposed`);
  return out.join(' · ');
}

const memo = new WeakMap<Model, Parts>();

export function partsOf(m: Model): Parts {
  const hit = memo.get(m);
  if (hit) return hit;
  const thing = thingFn(m);
  const links = linksOf(m, m.edges);
  const parts = m.boxes.filter((b) => !isResourceBox(b));
  const resources = m.boxes.filter((b) => isResourceBox(b) && b.rows.length);

  // each part's program: its module's, a block's source module's, or for a
  // proposed module the program of what it's connected to
  const prog = new Map<string, string>();
  for (const b of parts) {
    const p = b.module?.program ?? (b.from ? m.box.get(b.from)?.module?.program : undefined);
    if (p) prog.set(b.id, p);
  }
  for (const b of parts)
    if (!prog.has(b.id))
      for (const l of links) {
        const o = l.from === b.id ? l.to : l.to === b.id ? l.from : '';
        if (o && prog.has(o)) {
          prog.set(b.id, prog.get(o)!);
          break;
        }
      }
  const first = [...prog.values()][0] ?? '';
  for (const b of parts) if (!prog.has(b.id)) prog.set(b.id, first);
  const programOf = (t: string) => prog.get(t) ?? '';

  // programs left to right: one whose code is called from another program comes after it
  const names = [...new Set(parts.map((b) => prog.get(b.id)!))];
  const into = new Map(names.map((n) => [n, new Set<string>()]));
  for (const l of links) {
    const a = prog.get(l.from),
      b = prog.get(l.to);
    if (a && b && a !== b) into.get(b)!.add(a);
  }
  const size = (n: string) => parts.filter((b) => prog.get(b.id) === n).length;
  const order: string[] = [];
  const left = new Set(names);
  while (left.size) {
    const ready = [...left].filter((n) => [...into.get(n)!].every((x) => !left.has(x) || x === n));
    const pick = (ready.length ? ready : [...left]).sort((a, b) => size(b) - size(a) || a.localeCompare(b))[0];
    order.push(pick);
    left.delete(pick);
  }

  const at = new Map<string, Rect>();
  const frames: Frame[] = [];
  let x = 0;
  let tallest = 0;
  for (const name of order) {
    const mine = parts.filter((b) => prog.get(b.id) === name);
    const ids = new Set(mine.map((b) => b.id));
    const items: LBox[] = mine.map((b) => ({ id: b.id, w: partWidth(b), h: PART_H, entry: b.hasEntry }));
    const inner: [string, string][] = links.filter((l) => ids.has(l.from) && ids.has(l.to)).map((l) => [l.from, l.to]);
    const pos = flowColumns(items, inner, 0, 70, 18);
    let w = 0,
      h = 0;
    for (const it of items) {
      const [px, py] = pos[it.id];
      at.set(it.id, { x: x + FPAD + px, y: FTOP + py, w: it.w, h: it.h });
      w = Math.max(w, px + it.w);
      h = Math.max(h, py + it.h);
    }
    const fw = Math.max(w + FPAD * 2, name.length * 8 + FPAD * 2);
    frames.push({ id: 'program:' + name, label: name, resource: false, x, y: 0, w: fw, h: FTOP + h + FPAD });
    tallest = Math.max(tallest, FTOP + h + FPAD);
    x += fw + FGAP;
  }

  // resources: a frame per kind (database, topics, services, screens), stacked
  // on the right, each thing a small box; a long list wraps into columns
  const rank = (b: Box) => {
    const k = b.rows[0]?.node.kind;
    return k === 'table' ? 0 : k === 'topic' ? 1 : k === 'service' ? 2 : 3;
  };
  let y = 0;
  const maxRows = Math.max(8, Math.floor((Math.max(tallest, 400) - FTOP - FPAD) / (CHIP_H + CHIP_GAP)));
  for (const b of [...resources].sort((a, c) => rank(a) - rank(c) || a.label.localeCompare(c.label))) {
    const rows = [...b.rows].sort((a, c) => a.label.localeCompare(c.label));
    const per = Math.min(rows.length, maxRows);
    const cols = Math.ceil(rows.length / per);
    const cw = Math.max(...rows.map((r) => chipWidth(r.label)));
    rows.forEach((r, i) => {
      const c = Math.floor(i / per),
        k = i % per;
      at.set(r.id, { x: x + FPAD + c * (cw + 12), y: y + FTOP + k * (CHIP_H + CHIP_GAP), w: cw, h: CHIP_H });
    });
    const fw = Math.max(cols * (cw + 12) - 12 + FPAD * 2, b.label.length * 8 + FPAD * 2);
    const fh = FTOP + per * (CHIP_H + CHIP_GAP) - CHIP_GAP + FPAD;
    frames.push({ id: b.id, label: b.label, resource: true, x, y, w: fw, h: fh });
    y += fh + 30;
  }

  const out: Parts = { frames, at, links, thingOf: thing, programOf };
  memo.set(m, out);
  return out;
}

// atRest reports whether a link draws with nothing selected or hovered: how
// programs talk to each other, and events. Calls inside a program and data
// access draw for what's hovered or selected.
export function atRest(P: Parts, l: Link): boolean {
  if (l.kind === 'http' || l.kind === 'event') return true;
  const a = P.programOf(l.from),
    b = P.programOf(l.to);
  return !!a && !!b && a !== b;
}
