// Viewing past revisions and comparing two (/api/revs, /api/diff).
// The map draws the "to" graph with the diff's removed modules, nodes and edges
// merged back in; MapView asks rowCls/boxCls/edgeCls how to colour each one.
import { create } from 'zustand';
import { diffHook, type Box, type DiffMark } from './model';
import { currentProposal, getState as getMain, hooks, load, setState as setMain, useStore } from './store';
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
  tags?: string[];
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
  commits: Commit[]; // the commits between the two sides, newest first
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
  diff: Diff | null;
  busy: boolean;
  error: string;
  phase: string; // build phase from `building` events
}

export const useCompare = create<C>(() => ({
  revs: null,
  spec: null,
  diff: null,
  busy: false,
  error: '',
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
  moved: Map<string, string>; // node id -> the file it came from (its file was renamed)
}
let idx: Index | null = null;

// placeOf is where a node id lives, short: its file for "ts:web/x.ts#Name",
// its package for "go:shop/internal/orders.(*Repo).Find".
function placeOf(id: string): string {
  const s = id.replace(/^[a-z]+:/, '');
  const [path] = s.split('#');
  const last = path.split('/').pop() ?? path;
  return s.includes('#') ? last : last.split('.')[0];
}

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
    moved: new Map(),
  };
  for (const r of d.renamed ?? []) i.moved.set(r.to, placeOf(r.from));
  for (const n of [...d.addedNodes, ...d.removedNodes]) i.touched.add(n.module);
  for (const m of d.summary.modules) i.touched.add(m.id);
  return i;
}

export const nodeStatus = (id: string): DiffMark =>
  !idx ? '' : idx.added.has(id) ? 'added' : idx.removed.has(id) ? 'removed' : idx.moved.has(id) ? 'moved' : idx.changed.has(id) ? 'changed' : '';

diffHook.node = (id) => nodeStatus(id);
diffHook.edge = (e) => (!idx ? '' : idx.addedE.has(ekey(e)) ? 'added' : idx.removedE.has(ekey(e)) ? 'removed' : '');
diffHook.movedFrom = (id) => idx?.moved.get(id) ?? '';

export function rowCls(id: string): string {
  const s = nodeStatus(id);
  return s ? 'd-' + s.slice(0, 3) : '';
}

export const moduleStatus = (id: string): '' | 'added' | 'removed' => (!idx ? '' : idx.addedM.has(id) ? 'added' : idx.removedM.has(id) ? 'removed' : '');

// edgeChanges is the calls (and reads, writes, …) a node gained or lost, and
// the same for what uses it.
export interface EdgeChanges {
  outAdded: GEdge[];
  outRemoved: GEdge[];
  inAdded: GEdge[];
  inRemoved: GEdge[];
}
export function edgeChanges(id: string): EdgeChanges {
  const d = get().diff;
  const r: EdgeChanges = { outAdded: [], outRemoved: [], inAdded: [], inRemoved: [] };
  if (!d) return r;
  for (const e of d.addedEdges) (e.from === id ? r.outAdded : e.to === id ? r.inAdded : []).push(e);
  for (const e of d.removedEdges) (e.from === id ? r.outRemoved : e.to === id ? r.inRemoved : []).push(e);
  return r;
}

function boxHas(b: Box | undefined): boolean {
  if (!b || !idx) return false;
  if (b.module && idx.touched.has(b.module.id)) return true;
  return b.rows.some((r) => nodeStatus(r.id));
}

export function boxCls(b: Box): string {
  if (!idx) return '';
  if (b.module && idx.addedM.has(b.id)) return 'd-add';
  if (b.module && idx.removedM.has(b.id)) return 'd-rem';
  return boxHas(b) ? 'd-has' : '';
}

export function edgeCls(e: { from: string; to: string; type: string }): string {
  if (!idx) return '';
  const k = ekey(e);
  return idx.addedE.has(k) ? 'd-add' : idx.removedE.has(k) ? 'd-rem' : '';
}

// ---- the graph the map draws ----

// decorate merges what the "from" side had and the "to" side lost back into g.
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
  return { ...g, modules: mods, nodes, edges };
}

hooks.graph = decorate;

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
  set({ spec: { from, to }, busy: true, error: '' });
  writeHash();
  try {
    const d = await getDiff(from, to);
    if (run !== seq) return;
    idx = indexOf(d);
    set({ diff: d });
    setMain({ rev: isWorktree(d.to) ? 'worktree' : d.to, readOnly: !isWorktree(d.to), sel: null });
    await load();
  } catch (e) {
    if (run === seq) set({ error: String(e instanceof Error ? e.message : e) });
  } finally {
    if (run === seq) set({ busy: false });
  }
}

// stopCompare goes back to the working tree.
export async function stopCompare() {
  seq++; // a comparison still loading is dropped
  idx = null;
  set({ spec: null, diff: null, busy: false, error: '' });
  writeHash();
  setMain({ rev: 'worktree', readOnly: false, sel: null });
  await load();
}

// ---- presets ----

export interface Preset {
  id: string;
  label: string;
  sub: string; // one line saying what it shows
  from: string;
  to: string;
  group: 'main' | 'pr' | 'tag';
}

// ago is a time as "now", "3h", "2d", "4mo".
export function ago(iso: string): string {
  const h = Math.max(0, Date.now() - Date.parse(iso)) / 36e5;
  if (isNaN(h)) return '';
  return h < 1 ? 'now' : h < 24 ? `${Math.floor(h)}h` : h < 24 * 30 ? `${Math.floor(h / 24)}d` : `${Math.floor(h / 24 / 30)}mo`;
}

// presets are the comparisons most workflows start from: work not committed
// yet, the last commit, the branch against the main branch, open PRs, and
// everything since a release.
export function presets(r: Revs | null): Preset[] {
  const out: Preset[] = [{ id: 'uncommitted', label: 'Uncommitted changes', sub: r?.dirty === false ? 'Nothing uncommitted right now' : 'Edits not committed yet', from: 'HEAD', to: 'worktree', group: 'main' }];
  const head = r?.commits.find((c) => c.sha === r.head) ?? r?.commits[0];
  if (head) out.push({ id: 'last', label: 'Last commit', sub: `${head.subject} · ${ago(head.date)}`, from: 'HEAD^', to: 'HEAD', group: 'main' });
  if (r?.default && r.current && r.current !== r.default)
    out.push({ id: 'branch', label: `This branch vs ${r.default}`, sub: `${r.current}, from where it left ${r.default}`, from: 'base:' + r.default, to: 'worktree', group: 'main' });
  for (const p of r?.prs ?? []) out.push({ id: 'pr' + p.number, label: `#${p.number} ${p.title}`, sub: `${p.author.login} · ${ago(p.updatedAt)}`, from: 'pr:' + p.number, to: '', group: 'pr' });
  for (const t of (r?.tags ?? []).slice(0, 3)) out.push({ id: 'tag:' + t, label: `Since ${t}`, sub: 'Everything after that release', from: t, to: 'worktree', group: 'tag' });
  return out;
}

// the commit one is: a full sha, or its parent ("<sha>^")
const commitOf = (r: Revs | null, rev: string) => r?.commits.find((c) => c.sha === rev);

// refName is how a revision reads in a label: a branch as itself, a commit by
// its short sha, the worktree as "working tree".
export function refName(rev: string, r: Revs | null): string {
  if (isWorktree(rev)) return 'working tree';
  const c = commitOf(r, rev);
  return c ? c.short : shortRev(rev);
}

export function specLabel(s: Spec, r: Revs | null): string {
  const p = presets(r).find((x) => x.from === s.from && x.to === s.to);
  if (p) return p.label;
  // one commit on its own: "<sha>^ → <sha>"
  const one = commitOf(r, s.to);
  if (one && s.from === s.to + '^') return `${one.short} ${one.subject}`;
  const base = s.from.startsWith('base:');
  const from = refName(base ? s.from.slice(5) : s.from, r);
  return base ? `${refName(s.to, r)} vs ${from}` : `${from} → ${refName(s.to, r)}`;
}

// ---- URL hash: #compare=from..to ----

export function writeHash() {
  const { spec } = get();
  const h = spec ? `#compare=${enc(spec.from)}..${enc(spec.to)}` : '';
  if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
}

export function readHash(): Spec | null {
  const m = /^#compare=(.*?)\.\.(.*)$/.exec(location.hash);
  return m ? { from: decodeURIComponent(m[1]), to: decodeURIComponent(m[2]) } : null;
}

// start applies the URL hash and keeps revs and the diff fresh as things change.
// It returns true when it loads the map itself (the hash names a comparison).
let started = false;
export function start(): boolean {
  const h = readHash();
  void loadRevs();
  if (h) void compare(h.from, h.to);
  const took = !!h;
  if (started) return took;
  started = true;
  // On a branch, the map opens on what the branch changed, unless the URL has
  // a hash (any hash: #plain opens the plain map).
  if (!took && !location.hash)
    void loadRevs().then(() => {
      const r = get().revs;
      if (!get().spec && r?.current && r.default && r.current !== r.default) void compare('base:' + r.default, 'worktree');
    });
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

// ---- archived proposals over their base ----

let baseFor = '';
// syncBase keeps store.baseGraph set to the archived proposal's base graph.
function syncBase() {
  const s = getMain();
  const p = s.mode === 'propose' ? currentProposal(s) : null;
  const want = p && p.status === 'archived' && p.base ? p.base : '';
  if (want === baseFor) return;
  baseFor = want;
  if (!want) return setMain({ baseGraph: null });
  prefetchState(want)
    .then((r) => (r.ok ? r.json() : null))
    .then((st) => baseFor === want && setMain({ baseGraph: st?.graph ?? null }))
    .catch(() => {});
}
