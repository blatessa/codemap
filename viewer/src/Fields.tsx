// Renders a node's fields by what their values look like (rules in fields.ts).
import type { ReactNode } from 'react';
import { CodeBlock, Where } from './Code';
import { classify, humanize, isBlockKind } from './fields';
import type { Model } from './model';
import { qn } from './model';
import { select } from './store';
import { Section } from './panel/common';

type O = Record<string, unknown>;
const text = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function Ref({ m, id }: { m: Model; id: string }) {
  return (
    <button className="lnk" data-node={id} onClick={() => select(id)}>
      {qn(m, id)}
    </button>
  );
}

function Links({ v }: { v: unknown }) {
  const list = (Array.isArray(v) ? v : [v]) as { label: string; url: string }[];
  return (
    <>
      {list.map((l, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          <a href={l.url} target="_blank" rel="noopener noreferrer">
            {l.label}
          </a>
        </span>
      ))}
    </>
  );
}

function Table({ v }: { v: unknown[] }) {
  if (Array.isArray(v[0]))
    return (
      <table className="cols-t">
        <tbody>
          {(v as unknown[][]).map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{text(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  const keys = Object.keys(v[0] as O);
  return (
    <table className="cols-t">
      <thead>
        <tr>
          {keys.map((k) => (
            <th key={k}>{humanize(k)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(v as O[]).map((r, i) => (
          <tr key={i}>
            {keys.map((k) => (
              <td key={k}>{text(r[k])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Value({ m, v, depth }: { m: Model; v: unknown; depth: number }): ReactNode {
  const isNode = (id: string) => m.node.has(id);
  const k = classify(v, isNode);
  switch (k) {
    case 'none':
      return null;
    case 'link':
      return (
        <a href={v as string} target="_blank" rel="noopener noreferrer">
          {v as string}
        </a>
      );
    case 'links':
      return <Links v={v} />;
    case 'ref':
      return <Ref m={m} id={v as string} />;
    case 'refs':
      return (
        <div className="links">
          {(v as string[]).map((id) => (
            <Ref key={id} m={m} id={id} />
          ))}
        </div>
      );
    case 'table':
      return <Table v={v as unknown[]} />;
    case 'code': {
      const c = v as { code: string; lang?: string; file?: string; line?: number };
      return (
        <>
          {c.file && <Where file={c.file} line={c.line} />}
          <div style={{ height: 6 }} />
          <CodeBlock code={c.code} start={c.line ?? 1} />
        </>
      );
    }
    case 'text':
      return Array.isArray(v) ? (v as unknown[]).map(text).join(', ') : text(v);
    case 'object': {
      if (depth > 4) return text(v);
      const entries = Array.isArray(v) ? v.map((x, i) => [String(i + 1), x] as const) : Object.entries(v as O);
      return (
        <dl className="kv">
          {entries.map(([kk, vv]) => (
            <Pair key={kk} label={Array.isArray(v) ? kk : humanize(kk)}>
              <Value m={m} v={vv} depth={depth + 1} />
            </Pair>
          ))}
        </dl>
      );
    }
  }
}

const Pair = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </>
);

// Fields renders fields in insertion order: simple values gather into a fact
// list, tables, code and nested objects get their own titled section.
// codemap's own marks on a node (graph.AssignRoles, graph.FoldScreens): they
// shape what the map and traces show, and aren't facts about the code
const OWN = new Set(['role', 'shared', 'entry_reason', 'screen', 'screen_root']);

export function Fields({ m, fields, skip = [] }: { m: Model; fields?: O; skip?: string[] }) {
  if (!fields) return null;
  const out: ReactNode[] = [];
  let facts: ReactNode[] = [];
  const flush = () => {
    if (facts.length)
      out.push(
        <dl className="facts" key={'f' + out.length}>
          {facts}
        </dl>,
      );
    facts = [];
  };
  for (const [k, v] of Object.entries(fields)) {
    if (skip.includes(k) || OWN.has(k)) continue;
    const kind = classify(v, (id) => m.node.has(id));
    if (kind === 'none') continue;
    if (isBlockKind(kind)) {
      flush();
      out.push(
        <Section key={k} title={humanize(k)}>
          <Value m={m} v={v} depth={0} />
        </Section>,
      );
    } else
      facts.push(
        <Pair key={k} label={humanize(k)}>
          <Value m={m} v={v} depth={0} />
        </Pair>,
      );
  }
  flush();
  return <>{out}</>;
}
