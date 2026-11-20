// The compare control, summary panel and code diff (revs.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { CodeBlock, highlight } from './Code';
import { Head, Section } from './panel/common';
import { diffHook, qn, type Model, type Row } from './model';
import type { GEdge, Note } from './types';
import {
  compare,
  getSourceDiff,
  nodeStatus,
  moduleStatus,
  type Diff,
  isWorktree,
  parseDiff,
  presets,
  type Preset,
  shortRev,
  sliceRange,
  sourceRev,
  specLabel,
  useCompare,
  stopCompare,
  type DLine,
} from './revs';
import { NoteBox, NoteBubble, ToProposal, selectedLines, useCanNote, where } from './Notes';
import { addNote, commentTarget, getState, setState, useStore } from './store';

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}



// CompareControl sits in the top bar: what's on the map, and the ways to change it.
// The popover has the common comparisons one click away, then any two
// revisions (a branch, a commit, the working tree), and recent commits to
// compare around.
export function CompareControl() {
  const { revs, spec, busy, error, phase } = useCompare();
  const readOnly = useStore((s) => s.readOnly);
  const [open, setOpen] = useState(false);
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useOutside(open, close);
  useEffect(() => {
    document.body.classList.toggle('ro', readOnly);
  }, [readOnly]);
  const go = (f: string, t: string) => {
    setOpen(false);
    void compare(f, t);
  };
  return (
    <div className="cmp" ref={ref}>
      <button id="cmp" className={`cmpbtn${spec ? ' on' : ''}${busy ? ' busy' : ''}`} aria-expanded={open} title={error || (busy && phase) || undefined} onClick={() => setOpen(!open)}>
        {revs?.current && <span className="br">⎇ {revs.current}</span>}
        <span className="cl">{spec ? specLabel(spec, revs) : 'Compare…'}</span>
        {error ? <span className="cerr">!</span> : null}
        <span className="caret">▾</span>
      </button>
      {spec && (
        <button id="cmp-x" className="x" aria-label="Back to worktree" onClick={() => void stopCompare()}>
          ×
        </button>
      )}
      <div className="pop cmppop" id="cmp-pop" hidden={!open}>
        {open && <Menu go={go} />}
      </div>
    </div>
  );
}

// Menu is what the picker offers, in groups: this work, pull requests, other
// branches, releases. The comparison on the map is marked.
function Menu({ go }: { go: (f: string, t: string) => void }) {
  const { revs, spec } = useCompare();
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  if (!revs) return null;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (...t: string[]) => words.every((w) => t.join(' ').toLowerCase().includes(w));
  const ps = presets(revs).filter((p) => hit(p.label, p.sub));
  const on = (f: string, t: string) => !!spec && spec.from === f && spec.to === t;
  const base = revs.default;
  const branches = base ? revs.branches.filter((b) => b !== base && b !== revs.current && hit(b, 'branch')) : [];
  const of = (g: Preset['group']) => ps.filter((p) => p.group === g);
  // what Enter picks: the first thing shown
  const first = ps[0] ? () => go(ps[0].from, ps[0].to) : branches[0] ? () => go('base:' + base, branches[0]) : null;
  const item = (p: Preset) => (
    <button key={p.id} className={`cmpi${on(p.from, p.to) ? ' on' : ''}`} data-preset={p.id} onClick={() => go(p.from, p.to)}>
      <span className="t">{p.label}</span>
      <span className="s">{p.sub}</span>
    </button>
  );
  const group = (title: string, items: React.ReactNode) => (
    <div className="cmpg">
      <div className="cmph">{title}</div>
      {items}
    </div>
  );
  return (
    <>
      <input
        ref={input}
        className="cmpq"
        id="cmp-q"
        type="text"
        placeholder="Find a branch, PR or release"
        autoComplete="off"
        aria-label="Find a comparison"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && first?.()}
      />
      <div className="cmplist">
        {of('main').length > 0 && <div className="cmpg">{of('main').map(item)}</div>}
        {of('pr').length > 0 && group('Pull requests', of('pr').map(item))}
        {branches.length > 0 &&
          group(
            'Branches',
            branches.map((b) => (
              <button key={b} className={`cmpi row${on('base:' + base, b) ? ' on' : ''}`} data-branch={b} onClick={() => go('base:' + base, b)}>
                <span className="t">{b}</span>
                <span className="s">vs {base}</span>
              </button>
            )),
          )}
        {of('tag').length > 0 && group('Releases', of('tag').map(item))}
        {!first && <div className="cmph none">Nothing matches</div>}
      </div>
    </>
  );
}

// ---- summary ----

function goTo(id: string) {
  const s = getState();
  const m = s.graph;
  if (!(m.nodes ?? []).some((n) => n.id === id) && !(m.modules ?? []).some((x) => x.id === id)) return;
  setState({ sel: id, form: null, hover: null });
}

const MARK = { added: '+', removed: '−', changed: '~', moved: '↳', '': '·' } as const;

// ChangedCalls lists the calls, reads and writes a node gained or lost, each a
// link, as a proposal lists its new calls. Shared by the summary and the node panel.
export function ChangedCalls({ m, added, removed, side = 'to' }: { m: Model; added: GEdge[]; removed: GEdge[]; side?: 'to' | 'from' }) {
  const row = (e: GEdge, on: boolean) => {
    const id = e[side];
    return (
      <div key={(on ? '+' : '-') + e.from + e.to + e.type} className={`pcall ${on ? 'cadd' : 'crem'}`}>
        <span className="cmk">{on ? '+' : '−'}</span>
        <span className="dv">{e.type === 'calls' ? (side === 'to' ? '→' : '←') : e.type}</span>
        <button className="lnk" data-node={id} onClick={() => goTo(id)}>
          {qn(m, id)}
        </button>
        {e.detail && <span className="q">{e.detail}</span>}
      </div>
    );
  };
  return (
    <>
      {added.map((e) => row(e, true))}
      {removed.map((e) => row(e, false))}
    </>
  );
}

type Kind = 'added' | 'removed' | 'moved' | 'changed';
interface ChangeRow {
  row: Row;
  kind: Kind; // a node whose only change is a call it gained or lost is "changed"
  added: GEdge[];
  removed: GEdge[];
}
interface Group {
  id: string;
  label: string;
  status: '' | 'added' | 'removed';
  rows: ChangeRow[];
}

const ORDER: Record<Kind, number> = { added: 0, removed: 1, moved: 2, changed: 3 };

// changeGroups is what the comparison changes, by the part (or group of
// tables, topics, services) it lands in, in the map's order. In a part, entry
// points first, then new, gone, moved and changed code, each with its calls.
// It's the same shape as a proposal's changes.
function changeGroups(m: Model, d: Diff): Group[] {
  const add = new Map<string, GEdge[]>(),
    rem = new Map<string, GEdge[]>();
  for (const e of d.addedEdges) (add.get(e.from) ?? add.set(e.from, []).get(e.from)!).push(e);
  for (const e of d.removedEdges) (rem.get(e.from) ?? rem.set(e.from, []).get(e.from)!).push(e);
  const out: Group[] = [];
  for (const b of m.boxes) {
    const rows: ChangeRow[] = [];
    for (const row of b.rows) {
      const st = nodeStatus(row.id);
      const added = add.get(row.id) ?? [],
        removed = rem.get(row.id) ?? [];
      if (st || added.length || removed.length) rows.push({ row, kind: st || 'changed', added, removed });
    }
    rows.sort((x, y) => Number(!!y.row.node.entry) - Number(!!x.row.node.entry) || ORDER[x.kind] - ORDER[y.kind]);
    const status = moduleStatus(b.id);
    if (rows.length || status) out.push({ id: b.id, label: b.label, status, rows });
  }
  return out.sort((a, b) => Number(!!m.box.get(a.id)?.external) - Number(!!m.box.get(b.id)?.external));
}

const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(+d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

type Filter = 'all' | Kind;
const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['added', 'Added'],
  ['changed', 'Changed'],
  ['moved', 'Moved'],
  ['removed', 'Removed'],
];

// RowCalls: what one node gained or lost. A few show inline; more fold behind a count.
function RowCalls({ m, r }: { m: Model; r: ChangeRow }) {
  const n = r.added.length + r.removed.length;
  const [open, setOpen] = useState(n <= 3);
  if (!n || r.kind === 'removed') return null;
  return (
    <div className="pcalls">
      {!open && (
        <button className="more" onClick={() => setOpen(true)}>
          {r.added.length > 0 && <span className="ca">+{r.added.length}</span>} {r.removed.length > 0 && <span className="cr">−{r.removed.length}</span>} calls ▸
        </button>
      )}
      {open && <ChangedCalls m={m} added={r.added} removed={r.removed} />}
    </div>
  );
}

// SummaryPanel is the comparison itself, shaped like the other panels (it
// shows in the same drawer): what is compared, how much changed (a filter),
// the commits in it, then the changes by the part they land in. Every name
// opens its own panel, where the same changes show for that node.
export function SummaryPanel({ m }: { m: Model }) {
  const { diff, spec, revs, busy } = useCompare();
  const [filter, setFilter] = useState<Filter>('all');
  if (!spec) return null;
  const all = diff ? changeGroups(m, diff) : [];
  const count = (k: Kind) => all.reduce((n, g) => n + g.rows.filter((r) => r.kind === k).length, 0);
  const groups = all
    .map((g) => ({ ...g, rows: filter === 'all' ? g.rows : g.rows.filter((r) => r.kind === filter) }))
    .filter((g) => (filter === 'all' ? g.rows.length || g.status : g.rows.length));
  const total = all.reduce((n, g) => n + g.rows.length, 0);
  const empty = diff && !all.length && !diff.commits.length;
  return (
    <>
      <Head
        kind="Comparing"
        cls="chg"
        title={specLabel(spec, revs)}
        onClose={() => void stopCompare()}
      >
        {diff && (
          <div className="where">
            {shortRev(diff.from)} → {isWorktree(diff.to) ? 'working tree' : shortRev(diff.to)}
          </div>
        )}
      </Head>
      {!diff || busy ? <div className="loading sumload">…</div> : null}
      {empty && <p className="none">No changes</p>}
      {diff && diff.commits.length > 0 && (
        <Section title="Commits" count={diff.commits.length}>
          <div className="clist">
            {diff.commits.map((c) => {
              const body = (
                <>
                  <span className="cs">{c.subject}</span>
                  <span className="m">
                    {c.short} · {when(c.date)}
                  </span>
                </>
              );
              // a range of one commit is that commit: nothing to narrow to
              return diff.commits.length === 1 ? (
                <div key={c.sha} className="ccommit static" title={c.author}>
                  {body}
                </div>
              ) : (
                <button key={c.sha} className="ccommit" title={c.author} onClick={() => void compare(c.sha + '^', c.sha)}>
                  {body}
                </button>
              );
            })}
          </div>
        </Section>
      )}
      {total > 0 && (
        <Section title="Changes" count={total}>
          <div className="seg sm cfilter" role="group" aria-label="Show">
            {FILTERS.filter(([k]) => k === 'all' || count(k as Kind) > 0).map(([k, label]) => (
              <button key={k} aria-pressed={filter === k} data-filter={k} onClick={() => setFilter(k)}>
                {label}
                <span className="n">{k === 'all' ? total : count(k as Kind)}</span>
              </button>
            ))}
          </div>
          <div className="pgroups">
            {groups.map((g) => (
              <div key={g.id} className="pgroup">
                <div className="pghead">
                  <button className={`iname ${m.box.get(g.id)?.rows[0]?.tagClass ?? ''}`} data-node={g.id} onClick={() => goTo(g.id)}>
                    {g.label}
                  </button>
                  {g.status === 'added' && <span className="ptag dadd">new part</span>}
                  {g.status === 'removed' && <span className="ptag drem">removed part</span>}
                  <span className="ptag gn">{g.rows.length}</span>
                </div>
                {g.rows.map((r) => (
                  <div key={r.row.id} className="pchange">
                    <div className="pcrow">
                      <span className={`pmark d-${r.kind.slice(0, 3)}`}>{MARK[r.kind]}</span>
                      <button className={`iname ${r.row.tagClass} ${r.kind === 'removed' ? 'gone' : ''}`} data-node={r.row.id} onClick={() => goTo(r.row.id)}>
                        {(r.row.prefix ? r.row.prefix + ' ' : '') + r.row.label}
                      </button>
                      {r.kind === 'moved' && <span className="ptag">from {diffHook.movedFrom(r.row.id)}</span>}
                    </div>
                    <RowCalls m={m} r={r} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

// ---- code diff ----

const diffCache = new Map<string, Promise<DLine[]>>();

// DiffLines is a diff you can comment on, like the plain source: click a line
// number (of the new side) and type under it.
function DiffLines({ lines, file, on }: { lines: DLine[]; file: string; on?: string }) {
  const p = useStore(commentTarget);
  const can = useCanNote();
  const [draft, setDraft] = useState<[number, number] | null>(null);
  const notes = (p?.notes ?? []).filter((n) => n.file === file && n.from != null);
  const endOf = (n: Note) => Math.max(n.to ?? n.from!, n.from!);
  const idx = new Map<number, number>(); // new-side line number -> its index in lines
  lines.forEach((l, i) => l.n && idx.set(l.n, i));
  // a comment sits under the line that ends it, when the diff shows that line
  const cuts = [...new Set([...notes.map(endOf), ...(draft ? [draft[1]] : [])])].filter((n) => idx.has(n)).sort((a, b) => idx.get(a)! - idx.get(b)!);
  const onLine = (n: number, shift: boolean) => setDraft((d) => (shift && d ? [Math.min(d[0], n), Math.max(d[1], n)] : d && d[0] === n && d[1] === n ? null : [n, n]));
  const chunks: { lines: DLine[]; cut?: number }[] = [];
  let at = 0;
  for (const c of cuts) {
    chunks.push({ lines: lines.slice(at, idx.get(c)! + 1), cut: c });
    at = idx.get(c)! + 1;
  }
  if (at < lines.length) chunks.push({ lines: lines.slice(at) });
  return (
    <div
      className={cuts.length || can ? 'lined' : undefined}
      onMouseUp={(e) => {
        if (!can || (e.target as Element).closest('.note')) return;
        const r = selectedLines(e.currentTarget);
        if (!r) return;
        window.getSelection()?.removeAllRanges();
        setDraft(r);
      }}
    >
      {chunks.map((ch, k) => (
        <div key={k}>
          <div className="code cdiff">
            <pre className="g">
              {ch.lines.map((l, i) => (
                <span key={i}>
                  {l.n && can ? (
                    <span className={`ln ${draft && l.n >= draft[0] && l.n <= draft[1] ? 'sel' : ''}`} role="button" title="Add a comment here" onClick={(e) => onLine(l.n!, e.shiftKey)}>
                      {l.n}
                    </span>
                  ) : (
                    (l.n || l.o || '') + ''
                  )}
                  {i < ch.lines.length - 1 ? '\n' : ''}
                </span>
              ))}
            </pre>
            <pre className="c">
              {ch.lines.map((l, i) => (
                <span key={i} data-n={l.n || undefined} className={`dl${l.t === '+' ? ' la' : l.t === '-' ? ' lr' : ''}`}>
                  {l.text ? highlight(l.text) : ' '}
                </span>
              ))}
            </pre>
          </div>
          {ch.cut != null &&
            notes
              .filter((n) => endOf(n) === ch.cut)
              .map((n, i) => (
                <NoteBubble key={i} note={n}>
                  {n.to && n.to > n.from! && <div className="nwhere">{where(n)}</div>}
                </NoteBubble>
              ))}
          {ch.cut != null && draft && draft[1] === ch.cut && (
            <div className="note draft">
              <ToProposal />
              <NoteBox
                autoFocus
                placeholder={`Comment on ${file.split('/').pop()}:${draft[0]}${draft[1] > draft[0] ? '–' + draft[1] : ''}`}
                onCancel={() => setDraft(null)}
                onSubmit={(text) => {
                  const [a, b] = draft;
                  const quote = lines
                    .filter((l) => l.n && l.n >= a && l.n <= b && l.t !== '-')
                    .map((l) => l.text)
                    .join('\n');
                  addNote({ on, file, from: a, to: b > a ? b : undefined, quote, text });
                  setDraft(null);
                }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// DiffSource shows a node's lines as a diff between the compared revisions,
// with a toggle back to the plain source. Ranges with no changed lines show plain.
export function DiffSource({ file, from, to, plain, on }: { file: string; from: number; to: number; plain: React.ReactNode; on?: string }) {
  const diff = useCompare((s) => s.diff);
  const [mode, setMode] = useState<'diff' | 'source'>('diff');
  const [lines, setLines] = useState<DLine[] | null>(null);
  const old = !!sourceRev(file, from);
  useEffect(() => {
    if (!diff) return;
    let live = true;
    const key = [diff.from, diff.to, file].join('\0');
    let p = diffCache.get(key);
    if (!p) {
      p = getSourceDiff(diff.from, diff.to, file).then((r) => parseDiff(r.diff));
      p.catch(() => diffCache.delete(key));
      diffCache.set(key, p);
    }
    p.then(
      (all) => live && setLines(sliceRange(all, from, to, old ? 'old' : 'new')),
      () => live && setLines([]),
    );
    return () => {
      live = false;
    };
  }, [diff, file, from, to, old]);
  if (lines === null) return <div className="code" style={{ minHeight: 40 }} />;
  if (!lines.some((l) => l.t !== ' ')) return <>{plain}</>;
  return (
    <div className="dsrc">
      <div className="seg dseg" role="group" aria-label="Show">
        <button id="src-diff" aria-pressed={mode === 'diff'} onClick={() => setMode('diff')}>
          Diff
        </button>
        <button id="src-full" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>
          Source
        </button>
      </div>
      {mode === 'diff' ? <DiffLines lines={lines} file={file} on={on} /> : old ? <CodeBlock code={lines.filter((l) => l.t !== '+').map((l) => l.text).join('\n')} start={from} /> : plain}
    </div>
  );
}
