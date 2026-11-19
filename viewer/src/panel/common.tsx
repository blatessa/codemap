// Pieces every panel uses: the heading, sections, entry points, effects and
// tests. Code (names, routes, tables, files) is set in mono; everything else
// in the sans face.
import { useState, type ReactNode } from 'react';
import { Source } from '../Code';
import { openInEditor } from '../api';
import { qn, sharedFn, testsReaching, type Model } from '../model';
import { select, setState, storyOf, toggleSection, useStore } from '../store';

// Section is one part of a panel: a one-word title, an optional count, a rule
// above. Clicking the title folds it, on every panel, until it's unfolded.
export function Section({ title, count, children }: { title: string; count?: ReactNode; children: ReactNode }) {
  const folded = useStore((s) => s.folded.includes(title));
  return (
    <section className={`sec ${folded ? 'folded' : ''}`} data-sec={title}>
      <h3>
        <button className="stog" aria-expanded={!folded} onClick={() => toggleSection(title)}>
          <span className="car">{folded ? '▸' : '▾'}</span>
          {title}
          {count !== undefined && <span className="cnt">{count}</span>}
        </button>
      </h3>
      {!folded && children}
    </section>
  );
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Head names the thing: what kind it is, in the map's colour for that kind
// ("Table", "Route", "Function · internal/orders"), then its name the way the
// map writes it ("POST /orders", "PAGE /checkout"). `cls` is db, http, queue,
// entry or fn.
export function Head({ kind, plan, diff, title, cls, children }: { kind?: ReactNode; plan?: boolean; diff?: string; title: string; cls?: string; children?: ReactNode }) {
  return (
    <div className="dhead">
      <div>
        {kind && (
          <div className={`kind ${diff ? 'd-' + diff : plan ? 'plan' : (cls ?? 'fn')}`}>
            <i />
            {kind}
          </div>
        )}
        <h2 className={`${cls ?? ''} ${plan ? 'plan' : ''}`}>{title}</h2>
        {children}
      </div>
      <button className="x" aria-label="Close" onClick={() => setState({ sel: null, form: null, connectFrom: null })}>
        ×
      </button>
    </div>
  );
}

// onPath is what an entry point's tests are checked against, as in codemap
// show: the code on the path, without shared functions (they're on every path)
// or external nodes (other code uses them too).
export function onPath(m: Model, ids: Iterable<string>): string[] {
  return [...ids].filter((id) => {
    const n = m.full.node.get(id);
    return n && !n.external && !sharedFn(n);
  });
}

// Tests is a compact list: the test, its file and line; opening one shows its source.
export function Tests({ m, ids }: { m: Model; ids: Iterable<string> }) {
  const list = testsReaching(m, ids);
  if (!list.length) return <p className="none">None</p>;
  return (
    <div className="tlist">
      {list.map(({ test, direct, via }) => (
        <TestRow key={test.id} file={test.file} line={test.line} endLine={test.endLine} name={test.label} via={direct ? '' : via} />
      ))}
    </div>
  );
}

function TestRow({ name, file, line, endLine, via }: { name: string; file?: string; line?: number; endLine?: number; via: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="test" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary title={via ? 'Through ' + via : undefined}>
        <span className="tn">{name}</span>
        <span className="tf">
          {file?.split('/').pop()}
          {line ? ':' + line : ''}
        </span>
      </summary>
      {open && file && line ? <Source file={file} from={line} to={endLine} /> : null}
    </details>
  );
}

export function kindClass(m: Model, id: string) {
  return m.node.get(id)?.row.tagClass ?? '';
}

// Entries lists entry points inline, "POST /orders · PAGE /checkout · +2",
// each a link; `max` keeps it to a line (the rest open on click). The story
// the map is showing, if it's one of them, comes first and is marked: it's
// where you came from, and clicking it goes back.
export function Entries({ m, ids, max = Infinity }: { m: Model; ids: string[]; max?: number }) {
  const [all, setAll] = useState(false);
  const story = useStore(storyOf);
  if (!ids.length) return <span className="none">No entry point reaches it</span>;
  const sorted = story && ids.includes(story) ? [story, ...ids.filter((x) => x !== story)] : ids;
  const shown = all ? sorted : sorted.slice(0, max);
  return (
    <span className="ents">
      {shown.map((x, i) => (
        <span key={x}>
          {i > 0 && <span className="sep"> · </span>}
          <button className={`ent ${x === story ? 'story' : ''}`} data-node={x} data-story={x === story ? x : undefined} title={x === story ? 'Back to its story' : undefined} onClick={() => select(x)}>
            {x === story && '‹ '}
            {qn(m, x)}
          </button>
        </span>
      ))}
      {shown.length < ids.length && (
        <button className="more" onClick={() => setAll(true)}>
          +{ids.length - shown.length}
        </button>
      )}
    </span>
  );
}

// FileLink is a file:line that opens in the editor.
export function FileLink({ file, line }: { file?: string; line?: number }) {
  if (!file) return null;
  return (
    <button className="flink" title="Open in editor" onClick={() => void openInEditor(file, line ?? 1)}>
      {file}
      {line ? ':' + line : ''}
    </button>
  );
}
