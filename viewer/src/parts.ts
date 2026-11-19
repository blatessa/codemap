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
const FGAP = 56; // between frames
const RES_PER_ROW = 6; // things per row in a resource frame

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
// An Item is a code box on the map: a part, or a folder of parts drawn as one.
export interface Item {
  id: string; // the part's box id, or 'folder:<program>:<path>'
  label: string;
  sub: string;
  box?: Box; // a part
  parts?: Box[]; // a folder's
  entry: boolean;
}
export interface Parts {
  frames: Frame[];
  items: Item[];
  at: Map<string, Rect>; // every thing: items by id, resources by node id
  links: Link[];
  thingOf: (nodeId: string) => string | undefined; // the item or resource a node is drawn as
  itemOf: (id: string) => string; // a node, part or folder id, as drawn
  programOf: (thing: string) => string;
}

// A program with more parts than this folds them by folder.
export const MAX_PARTS = 16;
export const isFolder = (id: string) => id.startsWith('folder:');

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

export function linksOf(m: Model, edges: Iterable<MEdge>, thing = thingFn(m)): Link[] {
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
const itemWidth = (it: Item) => Math.max(170, it.label.length * 7.4 + 44, it.sub.length * 5.6 + 36);
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

const partItem = (b: Box): Item => ({ id: b.id, label: b.label, sub: partSub(b), box: b, entry: b.hasEntry });

// foldItems is what a program's parts draw as. A program of up to MAX_PARTS
// draws every part. A bigger one groups its parts by folder: a folder of three
// or more is one box. Folders open, biggest first, while the program still
// draws at most MAX_PARTS boxes; a folder the user opened always does. An open
// folder's parts are grouped the same way.
export function foldItems(program: string, parts: Box[], open: ReadonlySet<string>): Item[] {
  const segs = new Map(parts.map((b) => [b, b.label.split('/').filter(Boolean)]));
  type Folder = Item & { depth: number };
  // one level: parts and closed folders, the user's open folders opened
  const level = (list: Box[], depth: number): (Item | Folder)[] => {
    if (list.length <= MAX_PARTS && depth > 0) return list.map(partItem);
    const groups = new Map<string, Box[]>();
    for (const b of list) {
      const k = segs.get(b)![depth] ?? '';
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(b);
    }
    // all in one folder: look one level down
    if (groups.size === 1 && list.some((b) => segs.get(b)!.length > depth + 1)) return level(list, depth + 1);
    const out: (Item | Folder)[] = [];
    for (const [k, g] of groups) {
      if (g.length < 3 || !k) {
        out.push(...g.map(partItem));
        continue;
      }
      const path = segs.get(g[0])!.slice(0, depth + 1).join('/');
      const id = `folder:${program}:${path}`;
      // opened by the user, or holding a folder they opened
      if (open.has(id) || [...open].some((o) => o.startsWith(id + '/'))) {
        out.push(...level(g, depth + 1));
        continue;
      }
      const entries = g.reduce((n, b) => n + b.rows.filter((r) => r.node.entry).length, 0);
      const proposed = g.some((b) => b.prop || b.rows.some((r) => r.prop || r.moved));
      const sub = [`${g.length} parts`, entries && `${entries} entry point${entries === 1 ? '' : 's'}`, proposed && 'proposed'].filter(Boolean).join(' · ');
      out.push({ id, label: path + '/', sub, parts: g, entry: g.some((b) => b.hasEntry), depth });
    }
    return out;
  };
  if (parts.length <= MAX_PARTS) return parts.map(partItem);
  let items = level(parts, 0);
  for (;;) {
    const folders = items.filter((it): it is Folder => 'depth' in it).sort((a, b) => b.parts!.length - a.parts!.length);
    const next = folders
      .map((f) => ({ f, inner: level(f.parts!, f.depth + 1) }))
      .find(({ inner }) => items.length - 1 + inner.length <= MAX_PARTS);
    if (!next) break;
    const i = items.indexOf(next.f);
    items = [...items.slice(0, i), ...next.inner, ...items.slice(i + 1)];
  }
  return items.map((it) => {
    if (!('depth' in it)) return it;
    const { depth: _, ...rest } = it as Folder;
    return rest;
  });
}

const memo = new WeakMap<Model, Map<string, Parts>>();

export function partsOf(m: Model, open: ReadonlySet<string> = new Set()): Parts {
  const okey = [...open].sort().join('\n');
  const hit = memo.get(m)?.get(okey);
  if (hit) return hit;
  const parts = m.boxes.filter((b) => !isResourceBox(b));
  const resources = m.boxes.filter((b) => isResourceBox(b) && b.rows.length);

  const partLinks = linksOf(m, m.edges);
  // each part's program: its module's, or for a proposed module the program of what it's connected to
  const prog = new Map<string, string>();
  for (const b of parts) {
    const p = b.module?.program;
    if (p) prog.set(b.id, p);
  }
  for (const b of parts)
    if (!prog.has(b.id))
      for (const l of partLinks) {
        const o = l.from === b.id ? l.to : l.to === b.id ? l.from : '';
        if (o && prog.has(o)) {
          prog.set(b.id, prog.get(o)!);
          break;
        }
      }
  const first = [...prog.values()][0] ?? '';
  for (const b of parts) if (!prog.has(b.id)) prog.set(b.id, first);

  // what each program draws: its parts, some folded into folders
  const names0 = [...new Set(parts.map((b) => prog.get(b.id)!))];
  const items: Item[] = [];
  const itemOfBox = new Map<string, string>();
  for (const name of names0) {
    for (const it of foldItems(name, parts.filter((b) => prog.get(b.id) === name), open)) {
      items.push(it);
      prog.set(it.id, name);
      for (const b of it.parts ?? [it.box!]) itemOfBox.set(b.id, it.id);
    }
  }
  const base = thingFn(m);
  const thing = (id: string) => {
    const t = base(id);
    return t && (itemOfBox.get(t) ?? t);
  };
  const itemOf = (id: string) => thing(id) ?? itemOfBox.get(id) ?? id;
  const links = linksOf(m, m.edges, thing);
  const programOf = (t: string) => prog.get(t) ?? '';

  // programs left to right: one whose code is called from another program comes after it
  const names = names0;
  const into = new Map(names.map((n) => [n, new Set<string>()]));
  for (const l of links) {
    const a = prog.get(l.from),
      b = prog.get(l.to);
    if (a && b && a !== b) into.get(b)!.add(a);
  }
  const size = (n: string) => items.filter((it) => prog.get(it.id) === n).length;
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
    const mine = items.filter((it) => prog.get(it.id) === name);
    const ids = new Set(mine.map((it) => it.id));
    const boxes: LBox[] = mine.map((it) => ({ id: it.id, w: itemWidth(it), h: PART_H, entry: it.entry }));
    const inner: [string, string][] = links.filter((l) => ids.has(l.from) && ids.has(l.to)).map((l) => [l.from, l.to]);
    const pos = flowColumns(boxes, inner, 0, 50, 18);
    let w = 0,
      h = 0;
    for (const it of boxes) {
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

  // resources: a frame per kind (database, topics, services, screens) in a
  // row below the programs, each thing a small box; a long list wraps into
  // columns. Below rather than beside, the map stays narrow enough to read
  // next to the panel.
  const rank = (b: Box) => {
    const k = b.rows[0]?.node.kind;
    return k === 'table' ? 0 : k === 'topic' ? 1 : k === 'service' ? 2 : 3;
  };
  const top = tallest + FGAP;
  const res: Frame[] = [];
  let rx = 0;
  for (const b of [...resources].sort((a, c) => rank(a) - rank(c) || a.label.localeCompare(c.label))) {
    const rows = [...b.rows].sort((a, c) => a.label.localeCompare(c.label));
    // things in rows, so lines coming down reach each one's top
    const per = Math.min(rows.length, RES_PER_ROW);
    const lines = Math.ceil(rows.length / per);
    const cw = Math.max(...rows.map((r) => chipWidth(r.label)));
    rows.forEach((r, i) => {
      const c = i % per,
        k = Math.floor(i / per);
      at.set(r.id, { x: rx + FPAD + c * (cw + 12), y: top + FTOP + k * (CHIP_H + CHIP_GAP), w: cw, h: CHIP_H });
    });
    const fw = Math.max(per * (cw + 12) - 12 + FPAD * 2, b.label.length * 8 + FPAD * 2);
    const fh = FTOP + lines * (CHIP_H + CHIP_GAP) - CHIP_GAP + FPAD;
    res.push({ id: b.id, label: b.label, resource: true, x: rx, y: top, w: fw, h: fh });
    rx += fw + 30;
  }
  // under the right end of the programs, where the backend usually is
  const shift = Math.max(0, x - FGAP - (rx - 30));
  for (const f of res) {
    f.x += shift;
    frames.push(f);
  }
  if (shift) for (const b of resources) for (const r of b.rows) at.get(r.id)!.x += shift;

  const out: Parts = { frames, items, at, links, thingOf: thing, itemOf, programOf };
  (memo.get(m) ?? memo.set(m, new Map()).get(m)!).set(okey, out);
  return out;
}
