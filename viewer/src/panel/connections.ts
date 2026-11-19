// What a selected thing connects to, at the level the map draws: parts,
// folders, tables, topics and services. Each connection keeps the calls
// behind it, so the panel can say why two things talk.
import { onScreen, qn, type MEdge, type Model } from '../model';
import { isFolder, linkKind, type LinkKind, type Parts } from '../parts';

export interface Conn {
  thing: string; // an item (part or folder) id, or a resource's node id
  label: string;
  short: string; // what fits in the diagram
  cls: string; // part | folder | db | queue | http
  kinds: LinkKind[];
  calls: MEdge[];
}

// members are the nodes a thing is made of: a node itself, a part's rows, a
// folder's parts' rows.
export function membersOf(m: Model, P: Parts, id: string): Set<string> {
  if (m.node.has(id)) return new Set([id]);
  const box = m.box.get(id);
  if (box) return new Set(box.rows.map((r) => r.id));
  const it = P.items.find((x) => x.id === id);
  return new Set((it?.parts ?? []).flatMap((b) => b.rows.map((r) => r.id)));
}

// selfLabel is how the diagram's middle names the selected thing.
export function selfLabel(m: Model, P: Parts, id: string): { label: string; short: string; cls: string } {
  const r = m.node.get(id)?.row;
  if (r && !r.node.external) return { label: qn(m, id), short: (r.prefix ? r.prefix + ' ' : '') + r.label, cls: 'part' };
  return thingLabel(m, P, P.itemOf(id));
}

export function thingLabel(m: Model, P: Parts, t: string): { label: string; short: string; cls: string } {
  const it = P.items.find((x) => x.id === t);
  if (it) {
    const segs = it.label.split('/').filter(Boolean);
    const short = segs.length > 1 && /^(internal|pkg|src|lib|app)$/.test(segs[segs.length - 2]) ? segs[segs.length - 1] : segs.slice(-2).join('/');
    return { label: it.label, short: short + (isFolder(t) ? '/' : ''), cls: isFolder(t) ? 'folder' : 'part' };
  }
  const x = m.node.get(t);
  if (!x) return { label: t, short: t, cls: '' };
  const l = (x.row.prefix ? x.row.prefix + ' ' : '') + x.row.label;
  return { label: l, short: l, cls: x.row.tagClass || 'part' };
}

// connectionsOf returns what calls into id and what id calls out to, one
// entry per thing, biggest first. Calls inside a part or folder aren't
// connections; a function's calls to its own part's code are.
export function connectionsOf(m: Model, P: Parts, id: string): { inn: Conn[]; out: Conn[] } {
  const members = membersOf(m, P, id);
  const self = m.node.has(id) ? id : P.itemOf(id);
  const node = m.node.get(id)?.row.node;
  const collect = (dir: 'in' | 'out') => {
    const by = new Map<string, Conn>();
    for (const x of members) {
      for (const e of (dir === 'out' ? m.all.out : m.all.inn).get(x) ?? []) {
        const other = dir === 'out' ? e.to : e.from;
        if (members.has(other)) continue;
        // a page's code calling out of the frontend shows as the page (graph.FoldScreens)
        if (dir === 'in' && !onScreen(node) && onScreen(m.node.get(other)?.row.node) && !onScreen(m.node.get(x)?.row.node)) continue;
        const t = P.thingOf(other);
        if (!t || t === self) continue;
        let c = by.get(t);
        if (!c) by.set(t, (c = { thing: t, ...thingLabel(m, P, t), kinds: [], calls: [] }));
        const k = linkKind(m, e);
        if (!c.kinds.includes(k)) c.kinds.push(k);
        c.calls.push(e);
      }
    }
    return [...by.values()].sort((a, b) => b.calls.length - a.calls.length || a.label.localeCompare(b.label));
  };
  return { inn: collect('in'), out: collect('out') };
}

// entryPointsOf is what starts work in a thing: the entry points reaching any
// of its members (or, for an entry point, nothing: it starts itself).
export function entryPointsOf(m: Model, P: Parts, id: string): string[] {
  const n = m.node.get(id)?.row.node;
  if (n?.entry) return [];
  const got = new Set<string>();
  for (const x of membersOf(m, P, id)) {
    const r = m.node.get(x)?.row.node;
    if (r?.entry) got.add(x);
    for (const e of m.walk.entries(x)) got.add(e);
  }
  return [...got].sort();
}
