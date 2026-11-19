// Pieces every panel uses: section headings, links to nodes, tests.
import { useState, type ReactNode } from 'react';
import { Source } from '../Code';
import { effectSummary, qn, sharedFn, testsReaching, type Effect, type Model } from '../model';
import { select, setState, storyOf, useStore } from '../store';

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div>
    <p className="eyebrow">{title}</p>
    {children}
  </div>
);

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function Head({ eyebrow, plan, title, children }: { eyebrow: string; plan?: boolean; title: string; children?: ReactNode }) {
  return (
    <div className="dhead">
      <div>
        <p className={`eyebrow ${plan ? 'plan' : ''}`}>{eyebrow}</p>
        <h2>{title}</h2>
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

export function Tests({ m, ids }: { m: Model; ids: Iterable<string> }) {
  const list = testsReaching(m, ids);
  if (!list.length) return <span className="chip">No tests</span>;
  return (
    <>
      {list.map(({ test, direct, via }) => (
        <TestRow key={test.id} file={test.file} line={test.line} endLine={test.endLine} name={test.label} via={direct ? '' : via} />
      ))}
    </>
  );
}

function TestRow({ name, file, line, endLine, via }: { name: string; file?: string; line?: number; endLine?: number; via: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="test" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span>{name}</span>
        <span className="m">
          {file}
          {line ? ':' + line : ''}
          {via ? ' · via ' + via : ''}
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

// Entries lists entry points, each a link.
export function Entries({ m, ids }: { m: Model; ids: string[] }) {
  if (!ids.length) return <span className="chip">No entry point reaches it</span>;
  return (
    <div className="ents">
      {ids.map((x) => (
        <button key={x} className="ent" data-node={x} onClick={() => select(x)}>
          {qn(m, x)}
        </button>
      ))}
    </div>
  );
}

// Reach is what something reaches, coloured like the map: "writes orders · calls api.stripe.com".
export function Reach({ m, fs }: { m: Model; fs: Effect[] }) {
  if (!fs.length) return null;
  return <span className="reach">→ {effectSummary(m, fs)}</span>;
}
