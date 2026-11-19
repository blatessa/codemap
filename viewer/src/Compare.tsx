// The compare control, summary panel and code diff (revs.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { CodeBlock, highlight } from './Code';
import { Section } from './panel/common';
import { diffHook, qn, type Model, type Row } from './model';
import type { GEdge } from './types';
import {
  compare,
  getSourceDiff,
  nodeStatus,
  moduleStatus,
  type Diff,
  isWorktree,
  parseDiff,
  presets,
  shortRev,
  sliceRange,
  sourceRev,
  specLabel,
  useCompare,
  stopCompare,
  type DLine,
} from './revs';
import { getState, setState, useModel, useStore } from './store';

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
  const ps = presets(revs);
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
        {ps.map((p) => (
          <button key={p.id} className="res" data-preset={p.id} onClick={() => go(p.from, p.to)}>
            <span>{p.label}</span>
          </button>
        ))}
        {open && <More go={go} />}
      </div>
    </div>
  );
}

const ago = (iso: string) => {
  const d = Math.max(0, Date.now() - Date.parse(iso)) / 36e5;
  return d < 1 ? 'now' : d < 24 ? `${Math.floor(d)}h` : d < 24 * 30 ? `${Math.floor(d / 24)}d` : `${Math.floor(d / 24 / 30)}mo`;
};

// Branches (what each added since it left the main branch) and recent
// commits (what each changed), one click each.
function More({ go }: { go: (f: string, t: string) => void }) {
  const revs = useCompare((c) => c.revs);
  if (!revs) return null;
  const base = revs.default;
  const branches = base ? revs.branches.filter((b) => b !== base && b !== revs.current).slice(0, 6) : [];
  const commits = revs.commits.slice(0, 8);
  return (
    <>
      {branches.length > 0 && (
        <>
          <div className="rhead">Branches</div>
          {branches.map((b) => (
            <button key={b} className="res" data-branch={b} onClick={() => go('base:' + base, b)}>
              <span className="cs">{b}</span>
              <span className="m">vs {base}</span>
            </button>
          ))}
        </>
      )}
      {commits.length > 0 && (
        <>
          <div className="rhead">Commits</div>
          {commits.map((c) => (
            <button key={c.sha} className="res" data-commit={c.short} title={c.author} onClick={() => go(c.sha + '^', c.sha)}>
              <span className="cs">{c.subject}</span>
              <span className="m">{ago(c.date)}</span>
            </button>
          ))}
        </>
      )}
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

interface Group {
  id: string;
  label: string;
  status: '' | 'added' | 'removed';
  rows: { row: Row; status: ReturnType<typeof nodeStatus>; added: GEdge[]; removed: GEdge[] }[];
}

// changeGroups is what the comparison changes, by the part (or group of
// tables, topics, services) it lands in, in the map's order: nodes added,
// removed or changed, and code that gained or lost a call, each with its calls.
// It's the same shape as a proposal's changes.
function changeGroups(m: Model, d: Diff): Group[] {
  const add = new Map<string, GEdge[]>(),
    rem = new Map<string, GEdge[]>();
  for (const e of d.addedEdges) (add.get(e.from) ?? add.set(e.from, []).get(e.from)!).push(e);
  for (const e of d.removedEdges) (rem.get(e.from) ?? rem.set(e.from, []).get(e.from)!).push(e);
  const out: Group[] = [];
  for (const b of m.boxes) {
    const rows = b.rows
      .map((row) => ({ row, status: nodeStatus(row.id), added: add.get(row.id) ?? [], removed: rem.get(row.id) ?? [] }))
      .filter((r) => r.status || r.added.length || r.removed.length);
    const status = moduleStatus(b.id);
    if (rows.length || status) out.push({ id: b.id, label: b.label, status, rows });
  }
  return out.sort((a, b) => Number(!!m.box.get(a.id)?.external) - Number(!!m.box.get(b.id)?.external));
}

const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(+d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

// SummaryPanel is the comparison itself, shaped like the other panels: what is
// compared, the commits in it, then the changes by the part they land in.
// Every name opens its own panel, where the same changes show for that node.
export function SummaryPanel() {
  const { diff, spec, revs, busy } = useCompare();
  const m = useModel();
  if (!spec) return null;
  const groups = diff ? changeGroups(m, diff) : [];
  const count = diff ? diff.addedNodes.length + diff.removedNodes.length + diff.changed.length : 0;
  const empty = diff && !groups.length && !diff.commits.length;
  return (
    <aside className="drawer" id="drawer">
      <div className="dhead">
        <div>
          <div className="kind chg">
            <i />
            Comparing
          </div>
          <h2 id="sum-title">{specLabel(spec, revs)}</h2>
          {diff && (
            <div className="where">
              {shortRev(diff.from)} → {isWorktree(diff.to) ? 'working tree' : shortRev(diff.to)}
            </div>
          )}
        </div>
        <button className="x" aria-label="Back to worktree" onClick={() => void stopCompare()}>
          ×
        </button>
      </div>
      {!diff || busy ? <div className="loading sumload">…</div> : null}
      {empty && <p className="none">No changes</p>}
      {diff && diff.commits.length > 0 && (
        <Section title="Commits" count={diff.commits.length}>
          <div className="clist">
            {diff.commits.map((c) => (
              <button key={c.sha} className="ccommit" title={c.author} onClick={() => void compare(c.sha + '^', c.sha)}>
                <span className="cs">{c.subject}</span>
                <span className="m">
                  {c.short} · {when(c.date)}
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}
      {groups.length > 0 && (
        <Section title="Changes" count={count || undefined}>
          <div className="pgroups">
            {groups.map((g) => (
              <div key={g.id} className="pgroup">
                <div className="pghead">
                  <button className={`iname ${m.box.get(g.id)?.rows[0]?.tagClass ?? ''}`} data-node={g.id} onClick={() => goTo(g.id)}>
                    {g.label}
                  </button>
                  {g.status === 'added' && <span className="ptag dadd">new part</span>}
                  {g.status === 'removed' && <span className="ptag drem">removed part</span>}
                </div>
                {g.rows.map(({ row, status, added, removed }) => (
                  <div key={row.id} className="pchange">
                    <div className="pcrow">
                      <span className={`pmark d-${status.slice(0, 3)}`}>{MARK[status]}</span>
                      <button className={`iname ${row.tagClass} ${status === 'removed' ? 'gone' : ''}`} data-node={row.id} onClick={() => goTo(row.id)}>
                        {(row.prefix ? row.prefix + ' ' : '') + row.label}
                      </button>
                      {status === 'moved' && <span className="ptag">from {diffHook.movedFrom(row.id)}</span>}
                    </div>
                    {status !== 'removed' && <ChangedCalls m={m} added={added} removed={removed} />}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>
      )}
    </aside>
  );
}

// ---- code diff ----

const diffCache = new Map<string, Promise<DLine[]>>();

function DiffLines({ lines }: { lines: DLine[] }) {
  return (
    <div className="code cdiff">
      <pre className="g">{lines.map((l) => (l.n || l.o || '') + '').join('\n')}</pre>
      <pre className="c">
        {lines.map((l, i) => (
          <span key={i} className={`dl${l.t === '+' ? ' la' : l.t === '-' ? ' lr' : ''}`}>
            {l.text ? highlight(l.text) : ' '}
          </span>
        ))}
      </pre>
    </div>
  );
}

// DiffSource shows a node's lines as a diff between the compared revisions,
// with a toggle back to the plain source. Ranges with no changed lines show plain.
export function DiffSource({ file, from, to, plain }: { file: string; from: number; to: number; plain: React.ReactNode }) {
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
      {mode === 'diff' ? <DiffLines lines={lines} /> : old ? <CodeBlock code={lines.filter((l) => l.t !== '+').map((l) => l.text).join('\n')} start={from} /> : plain}
    </div>
  );
}
