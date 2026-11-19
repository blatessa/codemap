// Pieces every panel uses: the heading, sections, entry points, effects and
// tests. Code (names, routes, tables, files) is set in mono; everything else
// in the sans face.
import { useState, type ReactNode } from 'react';
import { Source } from '../Code';
import { qn, sharedFn, testsReaching, type Effect, type Model } from '../model';
import { select, setState, storyOf, useStore } from '../store';

// Section is one part of a panel: a one-word title, an optional count, a rule above.
export const Section = ({ title, count, children }: { title: string; count?: ReactNode; children: ReactNode }) => (
  <section className="sec">
    <h3>
      {title}
      {count !== undefined && <span className="cnt">{count}</span>}
    </h3>
    {children}
  </section>
);

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Head names the thing: its name, a tag saying what kind of thing it is, and
// a summary line of facts.
export function Head({ kind, plan, title, summary, children }: { kind: string; plan?: boolean; title: string; summary?: ReactNode; children?: ReactNode }) {
  return (
    <div className="dhead">
      <div>
        <div className="dtitle">
          <h2>{title}</h2>
          <span className={`ktag ${plan ? 'plan' : ''}`}>{kind}</span>
        </div>
        {summary && <div className="summary">{summary}</div>}
        {children}
      </div>
      <button className="x" aria-label="Close" onClick={() => setState({ sel: null, form: null, connectFrom: null })}>
        ×
      </button>
    </div>
  );
}

// facts joins summary facts with a middle dot, dropping empty ones.
export const facts = (...xs: (string | false | 0 | undefined)[]) => xs.filter(Boolean).join(' · ');
export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

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

// Crumbs shows the story a step belongs to: "/checkout › Service.Place". The
// map keeps the story lit; its name goes back to it.
export function Crumbs({ m, id }: { m: Model; id: string }) {
  const story = useStore(storyOf);
  if (!story || story === id) return null;
  return (
    <nav className="crumbs" aria-label="Story">
      <button className="lnk" data-story={story} data-node={story} onClick={() => select(story)}>
        {qn(m, story)}
      </button>
      <span>›</span>
      <span className="here">{qn(m, id)}</span>
    </nav>
  );
}

// Entries lists entry points inline, "POST /orders · PAGE /checkout · +2",
// each a link; `max` keeps it to a line (the rest open on click).
export function Entries({ m, ids, max = Infinity }: { m: Model; ids: string[]; max?: number }) {
  const [all, setAll] = useState(false);
  if (!ids.length) return <span className="none">No entry point reaches it</span>;
  const shown = all ? ids : ids.slice(0, max);
  return (
    <span className="ents">
      {shown.map((x, i) => (
        <span key={x}>
          {i > 0 && <span className="sep"> · </span>}
          <button className="ent" data-node={x} onClick={() => select(x)}>
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

const VERBS = ['writes', 'reads', 'renders', 'publishes', 'calls', 'fetches'];

// Fx is what something reaches, in the map's colours: "writes orders · calls api.stripe.com".
export function Fx({ m, fs }: { m: Model; fs: Effect[] }) {
  if (!fs.length) return null;
  const by = new Map<string, string[]>();
  for (const f of fs) (by.get(f.type) ?? by.set(f.type, []).get(f.type)!).push(f.to);
  return (
    <span className="fx">
      {VERBS.filter((v) => by.has(v)).map((v, i) => (
        <span key={v}>
          {i > 0 && ' · '}
          <span className="fv">{v === 'renders' ? 'shows' : v}</span>{' '}
          {by.get(v)!.map((t, j) => {
            const r = m.node.get(t)?.row;
            return (
              <span key={t} className={`ft ${r?.tagClass ?? ''}`}>
                {j > 0 && ', '}
                {r ? (r.prefix ? r.prefix + ' ' : '') + r.label : t}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}
