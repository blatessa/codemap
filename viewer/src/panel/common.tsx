// Pieces every panel uses: section headings, links to nodes, tests.
import { useState, type ReactNode } from 'react';
import { Source } from '../Code';
import { qn, sharedFn, testsReaching, type MEdge, type Model } from '../model';
import { select, setState } from '../store';

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

export function NodeLink({ m, id, edge, detail }: { m: Model; id: string; edge?: MEdge; detail?: boolean }) {
  const x = m.node.get(id);
  return (
    <button className={`lnk ${edge?.prop || x?.row.prop ? 'prop' : ''}`} data-node={id} onClick={() => select(id)}>
      {qn(m, id)}
      {detail && edge?.detail && <span className="q">{edge.detail}</span>}
    </button>
  );
}

export function EdgeList({ m, edges, end, detail }: { m: Model; edges: MEdge[]; end: 'from' | 'to'; detail?: boolean }) {
  if (!edges.length) return <p>—</p>;
  return (
    <div className="links">
      {edges.map((e) => (
        <NodeLink key={e.i} m={m} id={e[end]} edge={e} detail={detail} />
      ))}
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
