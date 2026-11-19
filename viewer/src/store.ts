// App state, persistence (§8 PUTs with If-Match, 409 reloads) and live updates.
import { create } from 'zustand';
import * as api from './api';
import { escapeGlob, slugify } from './blocks';
import { layoutUnplaced, type Pos } from './layout';
import { buildGrouping, isGroup, layoutH, topOf, type Grouping } from './groups';
import { buildModel, selectionOf, type Model, type Sel } from './model';
import type { Block, Graph, Loose, Proposal } from './types';

export type Mode = 'explore' | 'propose';
export interface Form {
  type: 'fn' | 'mod';
  box?: string;
}

export interface S {
  rev: string;
  readOnly: boolean; // viewing a past rev or comparing: no writes (revs.ts)
  baseGraph: Graph | null; // an archived proposal's base, drawn under it (revs.ts)
  status: 'loading' | 'ready' | 'error';
  error: string;
  graph: Graph;
  blocks: Block[];
  proposals: Proposal[];
  versions: Record<string, string>;
  pos: Pos; // box positions for this session: laid out automatically, then dragged
  mode: Mode;
  sel: string[];
  hover: string | null;
  collapsed: Set<string>;
  expanded: Set<string>; // boxes showing their internal rows too
  focus: boolean;
  view: { x: number; y: number; k: number };
  touchedView: boolean;
  connectFrom: string | null;
  form: Form | null;
  splitting: string | null;
  pslug: string | null;
  cslug: string | null; // the proposal comments go to: the last one opened
  editing: boolean;
  plist: { q: string; sort: 'updated' | 'name' | 'status'; status: 'all' | 'open' | 'archived' };
  fitSeq: number; // bump to ask the map to fit
  centerOn: string | null;
}

const empty: Graph = { version: 1, modules: [], nodes: [], edges: [] };

export const useStore = create<S>(() => ({
  rev: 'worktree',
  readOnly: false,
  baseGraph: null,
  status: 'loading',
  error: '',
  graph: empty,
  blocks: [],
  proposals: [],
  versions: {},
  pos: {},
  mode: 'explore',
  sel: [],
  hover: null,
  collapsed: new Set(),
  expanded: new Set(),
  focus: false,
  view: { x: 0, y: 0, k: 1 },
  touchedView: false,
  connectFrom: null,
  form: null,
  splitting: null,
  pslug: null,
  cslug: readCslug(),
  editing: false,
  plist: { q: '', sort: 'updated', status: 'all' },
  fitSeq: 0,
  centerOn: null,
}));

// hooks.graph post-processes every loaded graph (compare.ts merges a diff in).
export const hooks = { graph: (g: Graph) => g };

const set = useStore.setState;
const get = useStore.getState;

// ---- derived ----

let memo: { g?: Graph; b?: Block[]; p?: Proposal | null; m?: Model } = {};
export function modelOf(s: S): Model {
  const p = s.mode === 'propose' ? currentProposal(s) : null;
  const g = p && s.baseGraph ? s.baseGraph : s.graph;
  if (memo.g !== g || memo.b !== s.blocks || memo.p !== p) memo = { g, b: s.blocks, p, m: buildModel(g, s.blocks, p) };
  return memo.m!;
}
export const useModel = () => useStore(modelOf);
function readCslug(): string | null {
  try {
    return localStorage.getItem('codemap.cslug');
  } catch {
    return null;
  }
}
useStore.subscribe((s, prev) => {
  if (s.pslug && s.pslug !== prev.pslug && s.pslug !== s.cslug) {
    useStore.setState({ cslug: s.pslug });
    try {
      localStorage.setItem('codemap.cslug', s.pslug);
    } catch {
      /* per-viewer convenience only */
    }
  }
});

// commentTarget is the open proposal comments go to: the last one opened, or the
// only open one.
export function commentTarget(s: S): Proposal | null {
  const open = s.proposals.filter((p) => p.status !== 'archived');
  return open.find((p) => p.slug === (s.pslug ?? s.cslug)) ?? (open.length === 1 ? open[0] : null);
}

export const currentProposal = (s: S) => (s.pslug ? s.proposals.find((p) => p.slug === s.pslug) ?? null : null);

// groupingFor folds folders of many similar modules into groups (groups.ts),
// the same way on every map. Shared modules stay on their own.
const groupMemo = new WeakMap<Model, Grouping>();
export function groupingFor(m: Model): Grouping {
  const hit = groupMemo.get(m);
  if (hit) return hit;
  const keep = new Set(m.boxes.filter((b) => b.shared).map((b) => b.id));
  const links: [string, string][] = m.edges.map((e) => [m.node.get(e.from)!.box.id, m.node.get(e.to)!.box.id]);
  const G = buildGrouping(m.boxes, m.box, keep, links);
  groupMemo.set(m, G);
  return G;
}
export const groupingOf = (s: S) => groupingFor(modelOf(s));
export const useGrouping = () => useStore(groupingOf);

let selMemo: { m?: Model; sel?: string[]; S?: Sel | null } = {};
export function selOf(s: S): Sel | null {
  const m = modelOf(s);
  if (selMemo.m !== m || selMemo.sel !== s.sel) selMemo = { m, sel: s.sel, S: selectionOf(m, s.sel, groupingOf(s).groups) };
  return selMemo.S!;
}
export const useSel = () => useStore(selOf);

// ---- loading and live updates ----

const pending = new Set<string>(); // files with unsent or in-flight writes

export async function load() {
  const s = get();
  try {
    const st = await api.getState(s.rev);
    const v = st.versions ?? {};
    const first = s.status !== 'ready';
    const keep = (key: string) => !first && (pending.has(key) || s.versions[key] === v[key]);
    const next: Partial<S> = { status: 'ready', error: '', graph: hooks.graph(st.graph ?? empty), versions: { ...v } };
    const pr = st.project ?? ({} as never);
    if (!keep('blocks')) next.blocks = pr.blocks ?? [];
    else next.versions!.blocks = s.versions.blocks;
    // Positions aren't stored: the map is laid out on load, and again when the
    // blocks change on disk. Drags hold for the session.
    if (first || !keep('blocks')) next.pos = {};
    // proposals: take the server's copy unless we're mid-edit on it
    const server = pr.proposals ?? [];
    next.proposals = server.map((p) => {
      const key = 'proposals/' + p.slug;
      const mine = s.proposals.find((x) => x.slug === p.slug);
      if (mine && keep(key)) {
        next.versions![key] = s.versions[key];
        return mine;
      }
      return p;
    });
    for (const p of s.proposals) if (pending.has('proposals/' + p.slug) && !server.some((x) => x.slug === p.slug)) next.proposals.push(p);
    set(next);
    if (first) set({ fitSeq: get().fitSeq + 1 });
    await ensureLayout();
  } catch (e) {
    if (get().status !== 'ready') set({ status: 'error', error: String(e) });
  }
}

let es: EventSource | null = null;
export function subscribe() {
  if (typeof EventSource === 'undefined' || es) return;
  es = new EventSource('/api/events');
  const again = () => void load();
  es.addEventListener('graph-changed', again);
  es.addEventListener('project-changed', again);
}

// ---- layout ----

let layoutRun = 0;
export async function ensureLayout() {
  const s = get();
  const m = modelOf({ ...s, mode: 'explore' });
  const G = groupingFor(m);
  // what gets laid out: the top level (closed groups and the boxes outside them)
  const items = G.top.map((id) => (isGroup(id) ? G.groups.get(id)!.box : m.box.get(id)!));
  const fixed: Pos = { ...s.pos };
  // a group whose modules all have saved places goes where they were
  for (const id of G.top) {
      const g = G.groups.get(id);
      if (!g || fixed[id]) continue;
      const ps = g.members.map((x) => s.pos[x]).filter(Boolean);
      if (!ps.length || ps.length < g.members.length) continue;
      const cx = ps.reduce((a, p) => a + p[0], 0) / ps.length,
        cy = ps.reduce((a, p) => a + p[1], 0) / ps.length;
      fixed[id] = ps.reduce((a, p) => (Math.hypot(p[0] - cx, p[1] - cy) < Math.hypot(a[0] - cx, a[1] - cy) ? p : a));
    }
  const missing = items.filter((b) => !fixed[b.id]);
  const placed: Pos = {};
  for (const b of items) if (fixed[b.id] && !s.pos[b.id]) placed[b.id] = fixed[b.id];
  if (!missing.length) {
    if (Object.keys(placed).length) set({ pos: { ...get().pos, ...placed } });
    return;
  }
  const run = ++layoutRun;
  const at = (id: string) => topOf(G, id);
  const links: [string, string][] = m.edges.map((e) => [at(m.node.get(e.from)!.box.id), at(m.node.get(e.to)!.box.id)]);
  const res = await layoutUnplaced(
    items.map((b) => ({ id: b.id, w: b.w, h: layoutH(b), entry: b.hasEntry, external: b.external, shared: b.shared })),
    links,
    Object.fromEntries(items.filter((b) => fixed[b.id]).map((b) => [b.id, fixed[b.id]])),
  );
  if (run !== layoutRun) return;
  const hadAny = Object.keys(s.pos).length > 0;
  set({ pos: { ...get().pos, ...placed, ...res } });
  if (!hadAny) set({ fitSeq: get().fitSeq + 1 });
}

// tidyLayout drops this session's drags and lays the map out again.
export function tidyLayout() {
  set({ pos: {} });
  void ensureLayout().then(() => set({ fitSeq: get().fitSeq + 1 }));
}

// ---- persistence ----

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function debounce(key: string, fn: () => Promise<void>, ms: number) {
  pending.add(key);
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      fn().finally(() => {
        if (!timers.has(key)) pending.delete(key);
      });
    }, ms),
  );
}

function valueOf(file: api.ProjectFile): unknown {
  const s = get();
  if (file === 'blocks') return s.blocks;
  return null;
}

export function persist(file: api.ProjectFile, explicit?: unknown, ms = 300) {
  if (get().rev !== 'worktree' || get().readOnly) return;
  debounce(
    file,
    async () => {
      const value = explicit ?? valueOf(file);
      try {
        const v = await api.putProject(file, value, get().versions[file]);
        set({ versions: { ...get().versions, [file]: v } });
      } catch (e) {
        if (e instanceof api.Conflict) applyConflict(file, e);
        else console.error(e);
      }
    },
    ms,
  );
}

function applyConflict(file: api.ProjectFile, c: api.Conflict) {
  const s = get();
  const versions = { ...s.versions, [file]: c.version };
  if (file === 'blocks') set({ blocks: (c.value as Block[]) ?? [], versions });
  else set({ versions });
}

export function persistProposal(slug: string, ms = 400) {
  if (get().rev !== 'worktree' || get().readOnly) return;
  const key = 'proposals/' + slug;
  debounce(
    key,
    async () => {
      const p = get().proposals.find((x) => x.slug === slug);
      if (!p) return;
      try {
        const v = await api.putProposal(p, get().versions[key]);
        set({ versions: { ...get().versions, [key]: v } });
      } catch (e) {
        if (e instanceof api.Conflict) {
          const server = e.value as Proposal;
          set({
            versions: { ...get().versions, [key]: e.version },
            proposals: get().proposals.map((x) => (x.slug === slug && server ? { ...server, slug } : x)),
          });
        } else console.error(e);
      }
    },
    ms,
  );
}

// ---- selection ----

// Selecting a function or entry point focuses on its path, on every map: the
// story of one feature, laid out on its own.
export function select(id: string | null) {
  const m = modelOf(get());
  const node = !!id && m.node.has(id) && get().mode !== 'propose'; // sketching needs the whole map
  set({ sel: id ? [id] : [], hover: null, form: null, splitting: null, ...(id ? (node ? { focus: true } : {}) : { focus: false }) });
}

export function toggleMulti(id: string) {
  const s = get();
  const ids = s.sel.includes(id) ? s.sel.filter((x) => x !== id) : [...s.sel, id];
  set({ sel: ids, form: null, splitting: null, hover: null, ...(ids.length ? {} : { focus: false }) });
}

export function setMode(mode: Mode) {
  set({ mode, connectFrom: null, form: null, focus: false, ...(mode === 'propose' ? { sel: [], pslug: null, editing: false } : {}) });
}

// ---- positions ----

export function toggleExpanded(id: string) {
  const e = new Set(get().expanded);
  if (e.has(id)) e.delete(id);
  else e.add(id);
  set({ expanded: e });
}

export function movePos(updates: Pos) {
  set({ pos: { ...get().pos, ...updates } });
}

export function moveProposalModule(id: string, at: [number, number]) {
  const p = currentProposal(get());
  if (!p) return;
  updateProposal(p.slug, { modules: (p.modules ?? []).map((m) => (m.id === id ? { ...m, pos: at } : m)) }, false);
}

// ---- blocks ----

export function splitBlock(from: string, labels: string[], name: string, at: [number, number]) {
  const s = get();
  const taken = new Set(s.blocks.map((b) => b.id));
  let id = 'block:' + slugify(name),
    i = 2;
  while (taken.has(id)) id = `block:${slugify(name)}-${i++}`;
  const block: Block = { id, name, from, match: [...new Set(labels)].map(escapeGlob) };
  set({ blocks: [...s.blocks, block], pos: { ...s.pos, [id]: at }, sel: [id], splitting: null, form: null });
  persist('blocks');
  return id;
}

export function renameBlock(id: string, name: string) {
  set({ blocks: get().blocks.map((b) => (b.id === id ? { ...b, name } : b)) });
  persist('blocks', undefined, 500);
}

export function mergeBlock(id: string) {
  const s = get();
  const b = s.blocks.find((x) => x.id === id);
  if (!b) return;
  const pos = { ...s.pos };
  delete pos[id];
  set({ blocks: s.blocks.filter((x) => x.id !== id), pos, sel: [b.from] });
  persist('blocks');
}

// ---- proposals ----

const today = () => new Date().toISOString().slice(0, 10);

export function updateProposal(slug: string, patch: Partial<Proposal>, touch = true) {
  set({ proposals: get().proposals.map((p) => (p.slug === slug ? { ...p, ...patch, ...(touch ? { updated: today() } : {}) } : p)) });
  persistProposal(slug);
}

export function newProposal() {
  const s = get();
  const taken = new Set(s.proposals.map((p) => p.slug));
  let slug = 'untitled',
    i = 2;
  while (taken.has(slug)) slug = `untitled-${i++}`;
  const p: Proposal = { slug, name: 'Untitled', status: 'open', updated: today(), body: '', modules: [], nodes: [], edges: [] };
  set({ proposals: [...s.proposals, p], pslug: slug, editing: true, sel: [] });
  persistProposal(slug, 0);
}

function uniqueNewId(base: string, p: Proposal) {
  const taken = new Set([...(p.nodes ?? []), ...(p.modules ?? [])].map((x) => String(x.id)));
  let id = base,
    i = 2;
  while (taken.has(id)) id = `${base}-${i++}`;
  return id;
}

export function proposeNode(box: string, label: string, kind: string, method: string, external: boolean) {
  const p = currentProposal(get());
  if (!p) return;
  const entry = ['route', 'page', 'job', 'subscriber', 'command'].includes(kind);
  const id = uniqueNewId('new:' + (method && entry ? method + ' ' : '') + label, p);
  const n: Loose = { id, kind, label, module: box };
  if (entry) n.entry = true;
  if (external) n.external = true;
  if (method && entry) n.method = method;
  updateProposal(p.slug, { nodes: [...(p.nodes ?? []), n] });
  set({ form: null, sel: [id] });
}

export function proposeModule(label: string, at: [number, number]) {
  const p = currentProposal(get());
  if (!p) return;
  const id = uniqueNewId('new:mod:' + label, p);
  const m: Loose = { id, label, pos: at };
  updateProposal(p.slug, { modules: [...(p.modules ?? []), m] });
  set({ form: null, sel: [id] });
}

export function proposeEdge(from: string, to: string) {
  const p = currentProposal(get());
  if (!p || from === to) return;
  if ((p.edges ?? []).some((e) => e.from === from && e.to === to)) return;
  updateProposal(p.slug, { edges: [...(p.edges ?? []), { from, to }] });
}

// moveNode records that the proposal moves an existing node to another module, as
// a [[node]] with the node's id and the new module. Moving it back home removes it.
export function moveNode(id: string, to: string) {
  const s = get();
  const p = currentProposal(s);
  const g = s.graph?.nodes?.find((n) => n.id === id);
  if (!p) return;
  const nodes = p.nodes ?? [];
  if (!g) {
    // a proposed node: just change its module
    updateProposal(p.slug, { nodes: nodes.map((n) => (n.id === id ? { ...n, module: to } : n)) });
    return;
  }
  const rest = nodes.filter((n) => n.id !== id);
  updateProposal(p.slug, { nodes: g.module === to ? rest : [...rest, { id, module: to }] });
}

// comment appends a note to the open proposal's body, headed by what it is about.
export function comment(about: string, text: string) {
  const p = commentTarget(get());
  if (!p || !text.trim()) return;
  const body = p.body.replace(/\s+$/, '');
  updateProposal(p.slug, { body: (body ? body + '\n\n' : '') + about.trim() + '\n\n' + text.trim() + '\n' });
}

export function removeProposalNode(id: string) {
  const p = currentProposal(get());
  if (!p) return;
  updateProposal(p.slug, {
    nodes: (p.nodes ?? []).filter((n) => n.id !== id),
    edges: (p.edges ?? []).filter((e) => e.from !== id && e.to !== id),
  });
}

export function removeProposalModule(id: string) {
  const p = currentProposal(get());
  if (!p) return;
  const gone = new Set((p.nodes ?? []).filter((n) => n.module === id).map((n) => String(n.id)));
  updateProposal(p.slug, {
    modules: (p.modules ?? []).filter((m) => m.id !== id),
    nodes: (p.nodes ?? []).filter((n) => !gone.has(String(n.id))),
    edges: (p.edges ?? []).filter((e) => !gone.has(String(e.from)) && !gone.has(String(e.to))),
  });
}

export function removeProposalEdge(i: number) {
  const p = currentProposal(get());
  if (!p) return;
  updateProposal(p.slug, { edges: (p.edges ?? []).filter((_, j) => j !== i) });
}

export { set as setState, get as getState };
