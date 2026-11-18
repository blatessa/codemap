// The compare control, timeline, summary panel and code diff (revs.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { CodeBlock, highlight } from './Code';
import {
  compare,
  getSourceDiff,
  isWorktree,
  parseDiff,
  presets,
  setChangesOnly,
  setCompare,
  shortRev,
  sliceRange,
  sourceRev,
  specLabel,
  useCompare,
  view,
  type Commit,
  type DataRef,
  type Dep,
  type DLine,
  type Ref,
} from './revs';
import { currentProposal, getState, setState, useModel, useStore } from './store';
import './compare.css';

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


function RevSelect({ id, value, onChange, worktree, label }: { id: string; value: string; onChange: (v: string) => void; worktree: boolean; label: string }) {
  const revs = useCompare((s) => s.revs);
  const known = new Set<string>(['worktree', ...(revs?.branches ?? []), ...(revs?.commits ?? []).map((c) => c.sha)]);
  return (
    <select id={id} className="revsel" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {worktree && <option value="worktree">worktree</option>}
      {!known.has(value) && <option value={value}>{shortRev(value)}</option>}
      {(revs?.branches ?? []).map((b) => (
        <option key={'b' + b} value={b}>
          {b}
        </option>
      ))}
      {(revs?.commits ?? []).map((c) => (
        <option key={c.sha} value={c.sha}>
          {c.short} {c.subject.slice(0, 48)}
        </option>
      ))}
    </select>
  );
}

// CompareControl sits in the top bar: what's on the map, and the ways to change it.
export function CompareControl() {
  const { revs, spec, view: v, busy, error, changesOnly, timeline, phase } = useCompare();
  const readOnly = useStore((s) => s.readOnly);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('HEAD');
  const [to, setTo] = useState('worktree');
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useOutside(open, close);
  useEffect(() => {
    document.body.classList.toggle('ro', readOnly);
  }, [readOnly]);
  useEffect(() => {
    if (spec) {
      setFrom(spec.from);
      setTo(spec.to || 'worktree');
    }
  }, [spec]);
  const label = spec ? specLabel(spec, revs) : isWorktree(v) ? 'worktree' : shortRev(v);
  const go = (f: string, t: string) => {
    setOpen(false);
    void compare(f, t);
  };
  const ps = presets(revs);
  return (
    <div className="cmp" ref={ref}>
      <button id="cmp" className={`cmpbtn${spec ? ' on' : ''}${!spec && !isWorktree(v) ? ' past' : ''}${busy ? ' busy' : ''}`} aria-expanded={open} title={error || (busy && phase) || undefined} onClick={() => setOpen(!open)}>
        {revs?.current && <span className="br">⎇ {revs.current}</span>}
        <span className="cl">{spec || !isWorktree(v) ? label : 'Compare…'}</span>
        {error ? <span className="cerr">!</span> : null}
        <span className="caret">▾</span>
      </button>
      {spec && (
        <button id="changes-only" className="tool" aria-pressed={changesOnly} onClick={() => setChangesOnly(!changesOnly)}>
          Changes only
        </button>
      )}
      {(spec || !isWorktree(v)) && (
        <button id="cmp-x" className="x" aria-label="Back to worktree" onClick={() => void view('worktree')}>
          ×
        </button>
      )}
      <div className="pop cmppop" id="cmp-pop" hidden={!open}>
        {ps.map((p) => (
          <button key={p.id} className="res" data-preset={p.id} onClick={() => go(p.from, p.to)}>
            <span>{p.label}</span>
          </button>
        ))}
        <button className="res" data-preset="since" onClick={() => (setOpen(false), setCompare({ timeline: 'since' }))}>
          <span>Since…</span>
        </button>
        <button className="res" id="tl-open" onClick={() => (setOpen(false), setCompare({ timeline: timeline ? false : 'compare' }))}>
          <span>Timeline</span>
        </button>
        <div className="cmprow">
          <RevSelect id="cmp-from" label="From" value={from} onChange={setFrom} worktree={false} />
          <span className="m">→</span>
          <RevSelect id="cmp-to" label="To" value={to} onChange={setTo} worktree />
          <button className="btn" id="cmp-go" onClick={() => go(from, to)}>
            Compare
          </button>
        </div>
        <div className="cmprow">
          <RevSelect id="cmp-view" label="View" value={spec ? 'worktree' : v} onChange={(x) => (setOpen(false), void view(x))} worktree />
        </div>
      </div>
      {timeline && <Timeline />}
    </div>
  );
}

function ago(date: string): string {
  const s = (Date.now() - new Date(date).getTime()) / 1000;
  if (!isFinite(s)) return '';
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd';
  if (s < 86400 * 365) return Math.floor(s / 86400 / 30) + 'mo';
  return Math.floor(s / 86400 / 365) + 'y';
}

// Timeline lists commits. Click compares a commit with its parent; shift-click
// two to compare them. In "since" mode a click compares that commit with the worktree.
export function Timeline() {
  const { revs, timeline, spec } = useCompare();
  const [first, setFirst] = useState<string | null>(null);
  const commits = revs?.commits ?? [];
  const close = useMemo(() => () => setCompare({ timeline: false }), []);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
  const pos = new Map(commits.map((c, i) => [c.sha, i]));
  const click = (c: Commit, shift: boolean) => {
    if (timeline === 'since') return void compare(c.sha, 'worktree');
    if (shift) {
      if (!first || first === c.sha) return setFirst(c.sha);
      const [a, b] = (pos.get(first) ?? 0) > (pos.get(c.sha) ?? 0) ? [first, c.sha] : [c.sha, first];
      setFirst(null);
      return void compare(a, b);
    }
    setFirst(null);
    if (!c.parents.length) return void view(c.sha);
    void compare(c.parents[0], c.sha);
  };
  const inRange = (sha: string) => {
    if (!spec) return false;
    const a = commits.findIndex((c) => c.sha === spec.from || c.short === spec.from);
    const b = isWorktree(spec.to) ? -1 : commits.findIndex((c) => c.sha === spec.to || c.short === spec.to);
    const i = pos.get(sha) ?? -2;
    return a >= 0 && i < a && i >= b;
  };
  return (
    <div className="timeline" id="timeline" ref={ref}>
      <div className="tlhead">
        <span className="eyebrow">{timeline === 'since' ? 'Since…' : 'Timeline'}</span>
        <button className="x" aria-label="Close timeline" onClick={close}>
          ×
        </button>
      </div>
      {revs?.dirty && timeline !== 'since' && (
        <button className="tlrow wt" data-sha="worktree" onClick={() => void compare('HEAD', 'worktree')}>
          <span className="s">Uncommitted changes</span>
        </button>
      )}
      {commits.map((c) => (
        <button
          key={c.sha}
          className={`tlrow${first === c.sha ? ' picked' : ''}${inRange(c.sha) ? ' inr' : ''}`}
          data-sha={c.sha}
          title={`${c.author} · ${new Date(c.date).toLocaleString()}`}
          onClick={(e) => click(c, e.shiftKey)}
        >
          <span className="s">{c.subject}</span>
          <span className="meta">
            <span className="sha">{c.short}</span>
            <span>{ago(c.date)}</span>
            {c.refs.map((r) => (
              <span key={r} className="ref">
                {r}
              </span>
            ))}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---- summary ----

function goTo(id: string) {
  const s = getState();
  const m = s.graph;
  if (!(m.nodes ?? []).some((n) => n.id === id) && !(m.modules ?? []).some((x) => x.id === id)) return;
  const c = new Set(s.collapsed);
  const n = (m.nodes ?? []).find((x) => x.id === id);
  if (n) c.delete(n.module);
  setState({ sel: [id], collapsed: c, centerOn: id, form: null, hover: null, ...(s.view.k < 0.55 && n ? { view: { ...s.view, k: 0.9 } } : {}) });
}

const refText = (r: Ref) => (r.method ? r.method + ' ' : '') + r.label;

function Items<T>({ title, add, rem, text, id }: { title: string; add: T[]; rem: T[]; text: (x: T) => string; id: (x: T) => string }) {
  if (!add.length && !rem.length) return null;
  return (
    <div className="sumsec">
      <p className="eyebrow">{title}</p>
      <div className="links">
        {add.map((x, i) => (
          <button key={'a' + i} className="lnk sadd" data-go={id(x)} onClick={() => goTo(id(x))}>
            <span className="sg">+</span>
            {text(x)}
          </button>
        ))}
        {rem.map((x, i) => (
          <button key={'r' + i} className="lnk srem" data-go={id(x)} onClick={() => goTo(id(x))}>
            <span className="sg">−</span>
            {text(x)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SummaryPanel() {
  const { diff, spec, revs, busy } = useCompare();
  useModel();
  if (!spec) return null;
  const s = diff?.summary;
  const empty = diff && !diff.addedNodes.length && !diff.removedNodes.length && !diff.changed.length && !diff.addedEdges.length && !diff.removedEdges.length;
  return (
    <aside className="drawer" id="drawer">
      <div className="dhead">
        <div>
          <h2 id="sum-title">{specLabel(spec, revs)}</h2>
          {diff && (
            <div className="where">
              {shortRev(diff.from)} → {isWorktree(diff.to) ? 'worktree' : shortRev(diff.to)}
            </div>
          )}
        </div>
      </div>
      {!diff || busy ? <div className="loading sumload">…</div> : null}
      {empty && <p>No changes</p>}
      {s && (
        <>
          <Items title="Entry points" add={s.entriesAdded} rem={s.entriesRemoved} text={refText} id={(r) => r.id} />
          <Items<DataRef> title="Data" add={s.dataAdded} rem={s.dataRemoved} text={(r) => `${r.type} ${r.label}`} id={(r) => r.id} />
          <Items title="External" add={s.externalAdded} rem={s.externalRemoved} text={refText} id={(r) => r.id} />
          <Items<Dep> title="Dependencies" add={s.depsAdded} rem={s.depsRemoved} text={(d) => `${d.fromLabel} → ${d.toLabel}`} id={(d) => d.from} />
          {s.modules.length > 0 && (
            <div className="sumsec">
              <p className="eyebrow">Modules</p>
              <div className="links">
                {s.modules.map((m) => (
                  <button key={m.id} className="lnk smod" data-go={m.id} onClick={() => goTo(m.id)}>
                    <span className="ml">{m.label}</span>
                    <span className="cnt">
                      {m.added ? <span className="ca">+{m.added}</span> : null}
                      {m.removed ? <span className="cr">−{m.removed}</span> : null}
                      {m.changed ? <span className="cc">~{m.changed}</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
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

// ---- archived proposals over their base ----

// ArchivedBase toggles whether an archived proposal draws over its base rev or the current code.
export function ArchivedBase() {
  const p = useStore(currentProposal);
  const useCode = useCompare((s) => s.useCode);
  if (!p || p.status !== 'archived' || !p.base) return null;
  return (
    <label className="basetgl">
      <input id="p-usecode" type="checkbox" checked={useCode} onChange={(e) => setCompare({ useCode: e.target.checked })} />
      Current code
    </label>
  );
}
