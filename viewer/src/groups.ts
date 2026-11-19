// Folder groups: a folder holding many sibling modules of the same kind (plugins,
// package formats, migrations: internal/integration/*, models/packages/*) folds
// into one box that opens on click. The rule is structural and the same on every
// map, whatever its size. Groups are view-only; which are open is view state.
import { FARH, HEAD, type Box, type Row } from './model';

// FOLD_AT is how many sibling modules of one kind a folder needs to fold.
export const FOLD_AT = 6;
// Every box and closed group is laid out this tall: zoomed in a box draws its
// header (HEAD), zoomed out its name and count line, up to FARH.
export const GROUP_H = FARH;
export const layoutH = (_b: Box) => FARH;

export interface Group {
  id: string; // "group:" + path
  path: string;
  label: string; // path + "/*"
  children: string[]; // box ids and group ids, one level down
  members: string[]; // every box below, at any depth
  parent: string | null;
  box: Box; // how the group draws when closed
}

export interface Grouping {
  groups: Map<string, Group>;
  top: string[]; // what the map lays out: box ids and closed group ids
  of: Map<string, string>; // box id -> innermost group
}

export const isGroup = (id: string) => id.startsWith('group:');

// pathOf is the folder a box lives in, from the module's path (or label). Blocks
// live with the module they were split from. Externals, proposals and missing
// boxes have none and never fold.
export function pathOf(b: Box, box: Map<string, Box>): string | null {
  if (b.prop || b.ghost || b.external) return null;
  if (b.block) {
    const src = b.from ? box.get(b.from) : undefined;
    return src && !src.block ? pathOf(src, box) : null;
  }
  const raw = b.module?.path || b.module?.label || b.label;
  if (!raw) return null;
  return raw
    .replace(/\\/g, '/')
    .replace(/^\.(\/|$)/, '')
    .replace(/\/+$/, '');
}

interface Trie {
  path: string;
  kids: Map<string, Trie>;
  own: string[];
}

const CH = 7.25;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// buildGrouping folds boxes by folder. `keep` boxes (shared ones) stay on their
// own. `links` are calls between boxes, as [from, to] box ids.
//
// A folder's sibling modules (its subfolders, each with whatever is below it) are
// of one kind when they're the same language, all have entry points or all
// don't, and stand side by side: none calls or is called by another sibling,
// except siblings that several others use (a shared helper or base package,
// which stays out). Six or more of one kind fold together.
export function buildGrouping(boxes: Box[], box: Map<string, Box>, keep: Set<string>, links: [string, string][] = []): Grouping {
  const real = boxes.filter((b) => !b.prop && !b.ghost);
  const root: Trie = { path: '', kids: new Map(), own: [] };
  const fixed: string[] = [];
  for (const b of real) {
    const p = keep.has(b.id) ? null : pathOf(b, box);
    if (p === null) {
      fixed.push(b.id);
      continue;
    }
    let t = root;
    for (const seg of p ? p.split('/') : []) {
      let k = t.kids.get(seg);
      if (!k) t.kids.set(seg, (k = { path: t.path ? t.path + '/' + seg : seg, kids: new Map(), own: [] }));
      t = k;
    }
    t.own.push(b.id);
  }
  const out = new Map<string, Set<string>>();
  for (const [a, b] of links) if (a !== b) (out.get(a) ?? out.set(a, new Set()).get(a)!).add(b);

  // a folder with one subfolder and nothing of its own reads as one path: a/b/c
  const down = (t: Trie) => {
    while (!t.own.length && t.kids.size === 1) t = [...t.kids.values()][0];
    return t;
  };
  const sorted = (t: Trie) => [...t.kids.values()].map(down).sort((a, b) => a.path.localeCompare(b.path));
  const membersOf = (t: Trie): string[] => [...t.own, ...[...t.kids.values()].flatMap(membersOf)];
  const kindOf = (ids: string[]) => {
    const bs = ids.map((id) => box.get(id)!);
    const lang = (b: Box) => (b.from ? box.get(b.from)?.module?.lang : b.module?.lang) ?? '';
    const l = lang(bs[0]);
    if (bs.some((b) => lang(b) !== l)) return null;
    const e = bs.some((b) => b.hasEntry);
    return l + (e ? ':entry' : '');
  };

  const groups = new Map<string, Group>();
  const of = new Map<string, string>();
  // items lists what folder t shows where it's drawn: its own modules, its
  // subfolders' items, and a group for its siblings of one kind.
  const items = (t: Trie, parent: string | null): string[] => {
    const kids = sorted(t);
    const mem = kids.map(membersOf);
    const kidOf = new Map<string, number>();
    mem.forEach((ms, i) => ms.forEach((id) => kidOf.set(id, i)));
    const touch = kids.map(() => new Set<number>()); // siblings linked either way
    const users = kids.map(() => new Set<number>()); // siblings calling into it
    mem.forEach((ms, i) => {
      for (const id of ms)
        for (const to of out.get(id) ?? []) {
          const j = kidOf.get(to);
          if (j === undefined || j === i) continue;
          touch[i].add(j);
          touch[j].add(i);
          users[j].add(i);
        }
    });
    const helper = users.map((u) => u.size >= 2);
    const byKind = new Map<string, number[]>();
    kids.forEach((_, i) => {
      if (helper[i] || [...touch[i]].some((j) => !helper[j])) return;
      const k = kindOf(mem[i]);
      if (k !== null) (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(i);
    });
    let fold: number[] = [];
    for (const is of byKind.values()) if (is.length >= FOLD_AT && is.length > fold.length) fold = is;
    const folded = new Set(fold);
    const res = [...t.own];
    let gid: string | null = null;
    if (fold.length) {
      gid = 'group:' + t.path;
      const g: Group = { id: gid, path: t.path, label: (t.path || '.') + '/*', children: [], members: [], parent, box: null as unknown as Box };
      groups.set(gid, g);
      g.children = fold.flatMap((i) => items(kids[i], gid));
      for (const c of g.children) if (!isGroup(c)) of.set(c, gid);
      g.members = fold.flatMap((i) => mem[i]);
      g.box = groupBox(g, box);
    }
    kids.forEach((k, i) => {
      if (!folded.has(i)) res.push(...items(k, parent));
    });
    if (gid) res.push(gid);
    return res;
  };
  const top = [...fixed, ...items(down(root), null)];
  return { groups, top, of };
}

function groupBox(g: Group, box: Map<string, Box>): Box {
  const ms = g.members.map((id) => box.get(id)!);
  const rows: Row[] = ms.flatMap((b) => b.rows);
  return {
    id: g.id,
    label: g.label,
    sub: plural(g.members.length, 'module'),
    external: false,
    prop: false,
    ghost: false,
    rows,
    w: Math.round(Math.min(440, Math.max(190, g.label.length * CH + 60))),
    hasEntry: ms.some((b) => b.hasEntry),
    pub: 0,
    defH: HEAD,
    shared: false,
    usedBy: 0,
    group: g.id,
  };
}

// chain lists the folded groups a box sits in, innermost first.
export function chain(G: Grouping, id: string): string[] {
  const out: string[] = [];
  for (let g = G.of.get(id); g; g = G.groups.get(g)!.parent ?? undefined) out.push(g);
  return out;
}

// topOf is the top-level item a box is drawn in when nothing is open.
export function topOf(G: Grouping, id: string): string {
  const c = chain(G, id);
  return c.length ? c[c.length - 1] : id;
}
