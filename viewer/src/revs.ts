// Viewing past revisions and comparing two (PLAN.md §7, §8 /api/revs, /api/diff).
// The map draws the "to" graph with the diff's removed modules, nodes and edges
// merged back in; MapView asks rowCls/boxCls/edgeCls how to colour each one.
import { create } from 'zustand';
import { shownRows, type Box } from './model';
import { currentProposal, getState as getMain, groupingOf, hooks, load, modelOf, setState as setMain, useStore } from './store';
import type { GEdge, GModule, GNode, Graph } from './types';

// ---- API shapes ----

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  date: string;
  parents: string[];
  refs: string[];
}
export interface PR {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  author: { login: string };
  updatedAt: string;
}
export interface Revs {
  commits: Commit[];
  branches: string[];
  current: string;
  default: string;
  head: string;
  dirty: boolean;
  prs: PR[];
}
export interface Ref {
  id: string;
  kind: string;
  label: string;
  module: string;
  method?: string;
}
export interface DataRef extends Ref {
  type: string;
  by: string[];
}
export interface Dep {
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
}
export interface ModCounts {
  id: string;
  label: string;
  added: number;
  removed: number;
  changed: number;
}
export interface Summary {
  entriesAdded: Ref[];
  entriesRemoved: Ref[];
  dataAdded: DataRef[];
  dataRemoved: DataRef[];
  externalAdded: Ref[];
  externalRemoved: Ref[];
  depsAdded: Dep[];
  depsRemoved: Dep[];
  modules: ModCounts[];
}
export interface FileChange {
  old?: string;
  new?: string;
}
export interface Diff {
  from: string;
  to: string;
  addedNodes: GNode[];
  removedNodes: GNode[];
  changed: string[];
  renamed: { from: string; to: string }[];
  addedEdges: GEdge[];
  removedEdges: GEdge[];
  addedModules: GModule[];
  removedModules: GModule[];
  files: FileChange[];
  summary: Summary;
}

const enc = encodeURIComponent;

// fetchBuilding retries while the server says the revision is still building (504).
async function fetchBuilding(url: string): Promise<Response> {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.status !== 504 || i > 20) return r;
  }
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    throw new Error(b.error ?? String(r.status));
  }
  return r.json();
}

export const getRevs = async () => json<Revs>(await fetch('/api/revs'));
export const getDiff = async (from: string, to: string) => json<Diff>(await fetchBuilding(`/api/diff?from=${enc(from)}&to=${enc(to)}`));
export const getSourceDiff = async (from: string, to: string, file: string) =>
  json<{ diff: string }>(await fetch(`/api/source/diff?from=${enc(from)}&to=${enc(to)}&file=${enc(file)}&context=100000`));
export const prefetchState = async (rev: string) => fetchBuilding('/api/state?rev=' + enc(rev));

// ---- state ----

export interface Spec {
  from: string;
  to: string;
}

export interface C {
  revs: Revs | null;
  spec: Spec | null; // comparing
  view: string; // the rev being viewed when not comparing
  diff: Diff | null;
  changesOnly: boolean;
  busy: boolean;
  error: string;
  timeline: false | 'compare' | 'since';
  useCode: boolean; // archived proposals: draw over the current code instead of `base`
  phase: string; // build phase from `building` events
}

export const useCompare = create<C>(() => ({
  revs: null,
  spec: null,
  view: 'worktree',
  diff: null,
  changesOnly: false,
  busy: false,
  error: '',
  timeline: false,
  useCode: false,
  phase: '',
}));
const set = useCompare.setState;
const get = useCompare.getState;
export { set as setCompare, get as getCompare };

export const isWorktree = (r: string) => !r || r === 'worktree';
export const shortRev = (r: string) => (/^[0-9a-f]{40}$/.test(r) ? r.slice(0, 7) : r);

// ---- diff index ----

const ekey = (e: { from: string; to: string; type: string }) => e.from + '\0' + e.to + '\0' + e.type;

interface Index {
  added: Set<string>;
  removed: Set<string>;
  changed: Set<string>;
  addedE: Set<string>;
  removedE: Set<string>;
  addedM: Set<string>;
  removedM: Set<string>;
  touched: Set<string>; // module ids with any change
}
let idx: Index | null = null;

function indexOf(d: Diff): Index {
  const i: Index = {
    added: new Set(d.addedNodes.map((n) => n.id)),
    removed: new Set(d.removedNodes.map((n) => n.id)),
    changed: new Set(d.changed),
    addedE: new Set(d.addedEdges.map(ekey)),
    removedE: new Set(d.removedEdges.map(ekey)),
    addedM: new Set(d.addedModules.map((m) => m.id)),
    removedM: new Set(d.removedModules.map((m) => m.id)),
    touched: new Set([...d.addedModules, ...d.removedModules].map((m) => m.id)),
  };
  for (const n of [...d.addedNodes, ...d.removedNodes]) i.touched.add(n.module);
  for (const m of d.summary.modules) i.touched.add(m.id);
  return i;
}

export const nodeStatus = (id: string): '' | 'added' | 'removed' | 'changed' =>
  !idx ? '' : idx.added.has(id) ? 'added' : idx.removed.has(id) ? 'removed' : idx.changed.has(id) ? 'changed' : '';

export function rowCls(id: string): string {
  const s = nodeStatus(id);
  return s ? 'd-' + s.slice(0, 3) : '';
}

function boxHas(b: Box | undefined): boolean {
  if (!b || !idx) return false;
  if (b.module && idx.touched.has(b.module.id) && !b.block) return true;
  return b.rows.some((r) => idx!.added.has(r.id) || idx!.removed.has(r.id) || idx!.changed.has(r.id));
}

export function boxCls(b: Box): string {
  if (!idx) return '';
  if (!b.block && b.module && idx.addedM.has(b.id)) return 'd-add';
  if (!b.block && b.module && idx.removedM.has(b.id)) return 'd-rem';
  if (b.group) return groupCls(b.id);
  return boxHas(b) ? 'd-has' : '';
}

export function groupCls(id: string): string {
  if (!idx) return '';
  const s = getMain();
  const g = groupingOf(s)?.groups.get(id);
  if (!g) return '';
  const m = modelOf(s);
  return g.members.some((x) => boxHas(m.box.get(x))) ? 'd-has' : '';
}

export function edgeCls(e: { from: string; to: string; type: string }): string {
  if (!idx) return '';
  const k = ekey(e);
  return idx.addedE.has(k) ? 'd-add' : idx.removedE.has(k) ? 'd-rem' : '';
}

// ---- the graph the map draws ----

// decorate merges what the "from" side had and the "to" side lost back into g,
// then trims to the changes plus one hop when changesOnly is on.
function decorate(g: Graph): Graph {
  const d = get().diff;
  if (!d || !idx) return g;
  const mods = [...(g.modules ?? [])];
  const have = new Set(mods.map((m) => m.id));
  for (const m of d.removedModules) if (!have.has(m.id)) mods.push(m);
  const nodes = [...(g.nodes ?? [])];
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of d.removedNodes) if (!ids.has(n.id)) (nodes.push(n), ids.add(n.id));
  const edges = [...(g.edges ?? [])];
  for (const e of d.removedEdges) if (ids.has(e.from) && ids.has(e.to)) edges.push(e);
  let out: Graph = { ...g, modules: mods, nodes, edges };
  if (get().changesOnly) out = changesOnly(out);
  return out;
}

function changesOnly(g: Graph): Graph {
  const core = new Set<string>();
  for (const n of g.nodes ?? []) if (nodeStatus(n.id)) core.add(n.id);
  const keep = new Set(core);
  for (const e of g.edges ?? []) {
    if (core.has(e.from) || edgeCls(e)) keep.add(e.to);
    if (core.has(e.to) || edgeCls(e)) keep.add(e.from);
  }
  const nodes = (g.nodes ?? []).filter((n) => keep.has(n.id));
  const mods = new Set(nodes.map((n) => n.module));
  return {
    ...g,
    modules: (g.modules ?? []).filter((m) => mods.has(m.id)),
    nodes,
    edges: (g.edges ?? []).filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}

hooks.graph = decorate;
hooks.head = () => get().revs?.head ?? '';
// changed rows always show; with Changes only, so does their one hop of context
shownRows.has = (id) => !!nodeStatus(id) || (!!idx && get().changesOnly);

// ---- actions ----

export async function loadRevs() {
  try {
    set({ revs: await getRevs() });
  } catch {
    /* not a git repo, or the server is older */
  }
}

let seq = 0;

// compare shows from → to on the map. Both sides are read-only on the map.
export async function compare(from: string, to: string) {
  const run = ++seq;
  set({ spec: { from, to }, busy: true, error: '', timeline: false });
  writeHash();
  try {
    const d = await getDiff(from, to);
    if (run !== seq) return;
    idx = indexOf(d);
    set({ diff: d });
    setMain({ rev: isWorktree(d.to) ? 'worktree' : d.to, readOnly: true, sel: [], mode: 'explore', focus: false });
    await load();
  } catch (e) {
    if (run === seq) set({ error: String(e instanceof Error ? e.message : e) });
  } finally {
    if (run === seq) set({ busy: false });
  }
}

// view shows one revision (read-only unless it's the worktree).
export async function view(rev: string) {
  const run = ++seq;
  idx = null;
  set({ spec: null, diff: null, view: rev, busy: !isWorktree(rev), error: '', timeline: false, changesOnly: false });
  writeHash();
  setMain({ rev: isWorktree(rev) ? 'worktree' : rev, readOnly: !isWorktree(rev), sel: [], focus: false, ...(isWorktree(rev) ? {} : { mode: 'explore' }) });
  try {
    await load();
  } finally {
    if (run === seq) set({ busy: false });
  }
}

export function setChangesOnly(on: boolean) {
  set({ changesOnly: on });
  void load().then(() => setMain({ fitSeq: getMain().fitSeq + 1 }));
}

// ---- presets ----

export interface Preset {
  id: string;
  label: string;
  from: string;
  to: string;
}

export function presets(r: Revs | null): Preset[] {
  const out: Preset[] = [
    { id: 'uncommitted', label: 'Uncommitted changes', from: 'HEAD', to: 'worktree' },
    { id: 'last', label: 'Last commit', from: 'HEAD~1', to: 'HEAD' },
  ];
  if (r?.default && r.current && r.current !== r.default) out.push({ id: 'branch', label: `This branch vs ${r.default}`, from: 'base:' + r.default, to: 'worktree' });
  for (const p of r?.prs ?? []) out.push({ id: 'pr' + p.number, label: `#${p.number} ${p.title}`, from: 'pr:' + p.number, to: '' });
  return out;
}

export function specLabel(s: Spec, r: Revs | null): string {
  const p = presets(r).find((x) => x.from === s.from && x.to === s.to);
  if (p) return p.label;
  return `${shortRev(s.from)} → ${isWorktree(s.to) ? 'worktree' : shortRev(s.to)}`;
}

// ---- URL hash: #compare=from..to or #rev=X ----

export function writeHash() {
  const { spec, view: v } = get();
  const h = spec ? `#compare=${enc(spec.from)}..${enc(spec.to)}` : !isWorktree(v) ? `#rev=${enc(v)}` : '';
  if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
}

export function readHash(): { compare?: Spec; rev?: string } {
  const h = location.hash.slice(1);
  const m = /^compare=(.*?)\.\.(.*)$/.exec(h);
  if (m) return { compare: { from: decodeURIComponent(m[1]), to: decodeURIComponent(m[2]) } };
  const r = /^rev=(.+)$/.exec(h);
  if (r) return { rev: decodeURIComponent(r[1]) };
  return {};
}

// start applies the URL hash and keeps revs and the diff fresh as things change.
// It returns true when it loads the map itself (the hash names a rev or a comparison).
let started = false;
export function start(): boolean {
  void loadRevs();
  const h = readHash();
  if (h.compare) void compare(h.compare.from, h.compare.to);
  else if (h.rev) void view(h.rev);
  const took = !!(h.compare || h.rev);
  if (started) return took;
  started = true;
  useStore.subscribe(syncBase);
  useCompare.subscribe(syncBase);
  if (typeof EventSource === 'undefined') return took;
  const es = new EventSource('/api/events');
  es.addEventListener('graph-changed', () => {
    void loadRevs();
    const s = get().spec;
    if (s && (isWorktree(s.to))) void compare(s.from, s.to);
  });
  es.addEventListener('building', (ev) => {
    try {
      const d = JSON.parse((ev as MessageEvent).data);
      set({ phase: d.phase === 'done' ? '' : String(d.phase ?? '') });
    } catch {
      /* ignore */
    }
  });
  return took;
}

// ---- source ----

// sourceRev is the rev to read a node's source from: the "from" side for removed nodes.
export function sourceRev(file: string, line: number): string | null {
  const d = get().diff;
  if (!d) return null;
  if (d.removedNodes.some((n) => n.file === file && n.line === line)) return d.from;
  return null;
}

// fileChanged reports whether file differs between the compared revisions.
export function fileChanged(file: string): boolean {
  const d = get().diff;
  return !!d && d.files.some((f) => f.new === file || f.old === file);
}

export interface DLine {
  t: ' ' | '+' | '-';
  text: string;
  o: number; // old line number (0 for added)
  n: number; // new line number (0 for removed)
}

// parseDiff reads a unified diff into lines with numbers on both sides.
export function parseDiff(diff: string): DLine[] {
  const out: DLine[] = [];
  let o = 0,
    n = 0,
    inHunk = false;
  for (const l of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      o = +h[1];
      n = +h[2];
      inHunk = true;
      continue;
    }
    if (!inHunk || l.startsWith('\\')) continue;
    if (l.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    const t = l[0] as DLine['t'];
    if (t === '+') out.push({ t, text: l.slice(1), o: 0, n: n++ });
    else if (t === '-') out.push({ t, text: l.slice(1), o: o++, n: 0 });
    else if (t === ' ') out.push({ t, text: l.slice(1), o: o++, n: n++ });
  }
  return out;
}

// sliceRange keeps the diff lines inside [from, to] on the side given.
export function sliceRange(lines: DLine[], from: number, to: number, side: 'old' | 'new'): DLine[] {
  const key = side === 'old' ? 'o' : 'n';
  let first = -1,
    last = -1;
  lines.forEach((l, i) => {
    const v = l[key];
    if (v >= from && v <= to) {
      if (first < 0) first = i;
      last = i;
    }
  });
  if (first < 0) return [];
  // removed lines right after the range's last line still belong to it
  while (last + 1 < lines.length && lines[last + 1][key] === 0) last++;
  return lines.slice(first, last + 1);
}

// ---- archived proposals over their base (PLAN.md §6) ----

let baseFor = '';
// syncBase keeps store.baseGraph set to the archived proposal's base graph.
function syncBase() {
  const s = getMain();
  const p = s.mode === 'propose' ? currentProposal(s) : null;
  const want = p && p.status === 'archived' && p.base && !get().useCode ? p.base : '';
  if (want === baseFor) return;
  baseFor = want;
  if (!want) return setMain({ baseGraph: null });
  prefetchState(want)
    .then((r) => (r.ok ? r.json() : null))
    .then((st) => baseFor === want && setMain({ baseGraph: st?.graph ?? null }))
    .catch(() => {});
}
