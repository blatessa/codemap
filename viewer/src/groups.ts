// Folder groups: on maps with more than GROUP_AT boxes, modules fold into one box
// per folder. Groups are view-only; nothing about them is written except their
// position (layout.json, as "group:<path>") and which are open (view state).
import { FARH, type Box, type Row } from './model';

export const GROUP_AT = 28; // more boxes than this: fold modules into folder groups
const MIN_TOP = 10; // keep opening the smallest group while the map shows fewer boxes than this
export const GROUP_H = FARH + 24; // laid-out height of a closed group
// On big maps boxes are laid out at most this tall: zoomed out they draw short,
// and zoomed in a taller box draws over its neighbours.
export const BIG_H = 160;
export const layoutH = (b: Box) => (b.group ? GROUP_H : Math.min(b.defH, BIG_H));

export interface Group {
  id: string; // "group:" + path
  path: string;
  children: string[]; // box ids and group ids, one level down
  members: string[]; // every box below, at any depth
  parent: string | null;
  auto: boolean; // opened to fill the top level; its children are laid out there
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
  size: number;
}

const CH = 7.25;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// buildGrouping folds boxes by folder. `keep` boxes (in a user area, or shared)
// stay on their own. It returns null for maps small enough to show whole.
export function buildGrouping(boxes: Box[], box: Map<string, Box>, keep: Set<string>): Grouping | null {
  const real = boxes.filter((b) => !b.prop && !b.ghost);
  if (real.length <= GROUP_AT) return null;
  const root: Trie = { path: '', kids: new Map(), own: [], size: 0 };
  const fixed: string[] = [];
  for (const b of real) {
    const p = keep.has(b.id) ? null : pathOf(b, box);
    if (p === null) {
      fixed.push(b.id);
      continue;
    }
    let t = root;
    t.size++;
    for (const seg of p ? p.split('/') : []) {
      let k = t.kids.get(seg);
      if (!k) t.kids.set(seg, (k = { path: t.path ? t.path + '/' + seg : seg, kids: new Map(), own: [], size: 0 }));
      t = k;
      t.size++;
    }
    t.own.push(b.id);
  }

  const groups = new Map<string, Group>();
  const of = new Map<string, string>();
  const down = (t: Trie) => {
    // a folder with one subfolder and nothing of its own reads as one path: a/b/c
    while (!t.own.length && t.kids.size === 1) t = [...t.kids.values()][0];
    return t;
  };
  const sorted = (t: Trie) => [...t.kids.values()].sort((a, b) => a.path.localeCompare(b.path));
  const make = (t0: Trie, parent: string | null): string => {
    const t = down(t0);
    if (t.size === 1) return t.own[0] ?? make(sorted(t)[0], parent);
    const id = 'group:' + t.path;
    const g: Group = { id, path: t.path, children: [], members: [], parent, auto: false, box: null as unknown as Box };
    groups.set(id, g);
    g.children = [...t.own, ...sorted(t).map((k) => make(k, id))];
    for (const c of g.children) if (!isGroup(c)) of.set(c, id);
    g.members = g.children.flatMap((c) => (isGroup(c) ? groups.get(c)!.members : [c]));
    g.box = groupBox(g, box);
    return id;
  };
  const r = down(root);
  const top = [...fixed, ...r.own, ...sorted(r).map((k) => make(k, null))];

  // Open the smallest groups first, while the top level stays manageable: big
  // folders of many similar packages stay folded, small ones show their modules.
  for (;;) {
    let best: Group | null = null;
    for (const id of top) {
      const g = groups.get(id);
      if (g && (!best || g.members.length < best.members.length || (g.members.length === best.members.length && g.path < best.path))) best = g;
    }
    if (!best) break;
    if (top.length - 1 + best.children.length > GROUP_AT && top.length >= MIN_TOP) break;
    best.auto = true;
    top.splice(top.indexOf(best.id), 1, ...best.children);
  }
  return { groups, top, of };
}

function groupBox(g: Group, box: Map<string, Box>): Box {
  const ms = g.members.map((id) => box.get(id)!);
  const rows: Row[] = ms.flatMap((b) => b.rows);
  return {
    id: g.id,
    label: g.path,
    sub: plural(g.members.length, 'module'),
    external: false,
    prop: false,
    ghost: false,
    rows,
    w: Math.round(Math.min(440, Math.max(190, g.path.length * CH + 60))),
    hasEntry: ms.some((b) => b.hasEntry),
    pub: 0,
    shown: rows.length,
    defH: GROUP_H,
    shared: false,
    usedBy: 0,
    group: g.id,
  };
}

// chain lists the folded groups a box sits in, innermost first; auto-opened
// groups (already spread over the top level) are skipped.
export function chain(G: Grouping, id: string): string[] {
  const out: string[] = [];
  for (let g = G.of.get(id); g; g = G.groups.get(g)!.parent ?? undefined) if (!G.groups.get(g)!.auto) out.push(g);
  return out;
}

// topOf is the top-level item a box is drawn in when nothing is open.
export function topOf(G: Grouping, id: string): string {
  const c = chain(G, id);
  return c.length ? c[c.length - 1] : id;
}
