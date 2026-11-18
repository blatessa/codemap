import { memo, useEffect, useState, type ReactNode } from 'react';
import { getSource, openInEditor } from './api';
import { useStore } from './store';
import { fileChanged, sourceRev, useCompare } from './revs';
import { DiffSource } from './Compare';

const RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|\b(func|return|if|else|for|range|defer|go|type|struct|var|nil|map|any|string|int|int64|bool|error|new|const|let|async|await|function|export|import|from|true|false|package|interface|class|extends|switch|case|default|break|continue|select|SELECT|FROM|WHERE|INSERT|INTO|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|VALUES|RETURNING)\b|(\b\d+\b)/g;

export function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0,
    k = 0;
  RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = RE.exec(code)); ) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls = m[1] ? 'c-com' : m[2] ? 'c-str' : m[3] ? 'c-kw' : 'c-num';
    out.push(
      <span key={k++} className={cls}>
        {m[0]}
      </span>,
    );
    last = RE.lastIndex;
  }
  out.push(code.slice(last));
  return out;
}

export const CodeBlock = memo(function CodeBlock({ code, start }: { code: string; start: number }) {
  const n = code.split('\n').length;
  return (
    <div className="code">
      <pre className="g">{Array.from({ length: n }, (_, i) => start + i).join('\n')}</pre>
      <pre className="c">{highlight(code)}</pre>
    </div>
  );
});

const cache = new Map<string, Promise<string>>();
let cacheFor: unknown = null;

// load caches snippets until the graph changes (the code may have changed with it).
function load(rev: string, file: string, from: number, to: number, graph: unknown) {
  if (graph !== cacheFor) {
    cache.clear();
    cacheFor = graph;
  }
  const key = [rev, file, from, to].join('\0');
  let p = cache.get(key);
  if (!p) {
    p = getSource(rev, file, from, to).then((s) => s.lines.join('\n').replace(/\s+$/, ''));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

// Source fetches lines from /api/source. When comparing and the file changed,
// it shows the range as a diff (Compare.tsx).
export function Source(p: { file: string; from: number; to?: number }) {
  const diff = useCompare((s) => s.diff);
  const rev = diff ? sourceRev(p.file, p.from) ?? undefined : undefined;
  const plain = <PlainSource {...p} rev={rev} />;
  if (!diff || !fileChanged(p.file)) return plain;
  return <DiffSource file={p.file} from={p.from} to={p.to && p.to >= p.from ? p.to : p.from} plain={plain} />;
}

function PlainSource({ file, from, to, rev: at }: { file: string; from: number; to?: number; rev?: string }) {
  const cur = useStore((s) => s.rev);
  const rev = at ?? cur;
  const graph = useStore((s) => s.graph); // refetch when the graph changes
  const [code, setCode] = useState<string | null>(null);
  const end = to && to >= from ? to : from; // no end line: show the one line (a route registration, say)
  useEffect(() => {
    let live = true;
    setCode(null);
    load(rev, file, from, end, graph).then(
      (c) => live && setCode(c),
      () => live && setCode(''),
    );
    return () => {
      live = false;
    };
  }, [rev, file, from, end, graph]);
  if (code === null) return <div className="code" style={{ minHeight: 40 }} />;
  if (!code) return <p>—</p>;
  return <CodeBlock code={code} start={from} />;
}

export function Where({ file, line }: { file?: string; line?: number }) {
  if (!file) return null;
  return (
    <div
      className="where open"
      role="link"
      tabIndex={0}
      title="Open in editor"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void openInEditor(file, line ?? 1);
      }}
      onKeyDown={(e) => e.key === 'Enter' && void openInEditor(file, line ?? 1)}
    >
      {file}
      {line ? ':' + line : ''}
    </div>
  );
}
