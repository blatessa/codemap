// App state, saving proposals (PUTs with If-Match, 409 reloads) and live updates.
import { create } from 'zustand';
import * as api from './api';
import { buildModel, selectionOf, type Model, type Sel } from './model';
import { partsOf, type Parts } from './parts';
import type { Graph, Loose, Proposal } from './types';

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
  proposals: Proposal[];
  versions: Record<string, string>;
  mode: Mode;
  sel: string | null; // the selected node, part or folder
  open: string[]; // folders opened on the map (parts.foldItems)
  folded: string[]; // panel sections folded, by title (remembered per viewer)
  drawerW: number | null; // the panel's width, when dragged (remembered per viewer)
  hover: string | null;
  story: string | null; // the feature on the map; clicking its steps keeps it there
  view: { x: number; y: number; k: number };
  touchedView: boolean;
  connectFrom: string | null;
  form: Form | null;
  pslug: string | null;
  cslug: string | null; // the proposal comments go to: the last one opened
  editing: boolean;
  plist: { q: string; sort: 'updated' | 'name' | 'status'; status: 'all' | 'open' | 'archived' };
  fitSeq: number; // bump to ask the map to fit
}

const empty: Graph = { version: 1, modules: [], nodes: [], edges: [] };

export const useStore = create<S>(() => ({
  rev: 'worktree',
  readOnly: false,
  baseGraph: null,
  status: 'loading',
  error: '',
  graph: empty,
  proposals: [],
  versions: {},
  mode: 'explore',
  sel: null,
  open: [],
  folded: readPref<string[]>('codemap.folded', []),
  drawerW: readPref<number | null>('codemap.drawerW', null),
  hover: null,
  story: null,
  view: { x: 0, y: 0, k: 1 },
  touchedView: false,
  connectFrom: null,
  form: null,
  pslug: null,
  cslug: readCslug(),
  editing: false,
  plist: { q: '', sort: 'updated', status: 'all' },
  fitSeq: 0,
}));

// hooks.graph post-processes every loaded graph (compare.ts merges a diff in).
export const hooks = { graph: (g: Graph) => g };

const set = useStore.setState;
const get = useStore.getState;

// ---- derived ----

let memo: { g?: Graph; p?: Proposal | null; m?: Model } = {};
export function modelOf(s: S): Model {
  const p = s.mode === 'propose' ? currentProposal(s) : null;
  const g = p && s.baseGraph ? s.baseGraph : s.graph;
  if (memo.g !== g || memo.p !== p) memo = { g, p, m: buildModel(g, p) };
  return memo.m!;
}
export const useModel = () => useStore(modelOf);

// partsOfState is the map's layout: the model, with the folders that are open.
let openMemo: { open?: string[]; set?: Set<string> } = {};
export function partsOfState(s: S): Parts {
  if (openMemo.open !== s.open) openMemo = { open: s.open, set: new Set(s.open) };
  return partsOf(modelOf(s), openMemo.set!);
}
export const useParts = () => useStore(partsOfState);

// toggleFolder opens a folder on the map, or folds it again.
export function toggleFolder(id: string) {
  const open = get().open;
  set({ open: open.includes(id) ? open.filter((x) => x !== id) : [...open, id] });
}
// readPref and writePref keep per-viewer conveniences; storage may be missing.
function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* a convenience only */
  }
}

// toggleSection folds a panel section, or unfolds it, on every panel.
export function toggleSection(title: string) {
  const f = get().folded;
  const next = f.includes(title) ? f.filter((x) => x !== title) : [...f, title];
  set({ folded: next });
  writePref('codemap.folded', next);
}

// setDrawerWidth sets the panel's width, kept for next time.
export function setDrawerWidth(w: number, save = false) {
  set({ drawerW: w });
  if (save) writePref('codemap.drawerW', w);
}

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


let selMemo: { m?: Model; id?: string; S?: Sel | null } = {};
const ofId = (s: S, id: string): Sel | null => {
  const m = modelOf(s);
  if (selMemo.m !== m || selMemo.id !== id) selMemo = { m, id, S: selectionOf(m, id) };
  return selMemo.S!;
};
// storyOf is the story the map shows: the selection's own, or, for a step
// inside the current story, still that story.
export function storyOf(s: S): string | null {
  if (!s.story || !s.sel) return null;
  if (s.sel === s.story) return s.story;
  return ofId(s, s.story)?.nodes.has(s.sel) ? s.story : null;
}
export function selOf(s: S): Sel | null {
  const st = storyOf(s);
  if (st) return ofId(s, st);
  return s.sel ? ofId(s, s.sel) : null;
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
// story of one feature, laid out on its own. Selecting a step of the story on
// the map keeps the story where it is; `fresh` (search, "trace from here")
// starts a new one.
export function select(id: string | null, fresh = false) {
  const s = get();
  const m = modelOf(s);
  const node = !!id && m.node.has(id) && s.mode !== 'propose'; // sketching needs the whole map
  const st = s.story && !fresh && node ? storyOf({ ...s, sel: id! }) : null;
  if (st) return set({ sel: id!, hover: null, form: null });
  set({ sel: id, story: node ? id : null, hover: null, form: null });
}

export function setMode(mode: Mode) {
  set({ mode, connectFrom: null, form: null, ...(mode === 'propose' ? { sel: null, pslug: null, editing: false } : {}) });
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
  set({ proposals: [...s.proposals, p], pslug: slug, editing: true, sel: null });
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
  set({ form: null, sel: id });
}

export function proposeModule(label: string) {
  const p = currentProposal(get());
  if (!p) return;
  const id = uniqueNewId('new:mod:' + label, p);
  const m: Loose = { id, label };
  updateProposal(p.slug, { modules: [...(p.modules ?? []), m] });
  set({ form: null, sel: id });
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
