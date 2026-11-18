import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { getSource, openInEditor } from './api';
import { setState, useStore } from './store';
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

// LineCode is a code block whose lines can be picked (click and shift-click on
// line numbers, or a text selection) and marked (lines with requests on them).
function LineCode({ code, start, file, target }: { code: string; start: number; file: string; target?: string }) {
  const lines = code.split('\n');
  const [pick, setPick] = useState<[number, number] | null>(null);
  const anchorRef = useRef<number | null>(null);
  const ro = useStore((s) => s.readOnly);
  const items = useStore((s) => {
    const p = s.pslug ? s.proposals.find((x) => x.slug === s.pslug) : null;
    return s.mode === 'propose' ? p?.items : null;
  });
  const focus = useStore((s) => s.focusLines);
  const box = useRef<HTMLDivElement>(null);
  const marked = new Set<number>();
  for (const it of items ?? []) {
    if (it.status === 'done') continue;
    const f = it.anchor?.file ?? it.file,
      l = it.anchor?.lines ?? it.lines;
    if (f !== file || !l?.length) continue;
    for (let i = l[0]; i <= l[l.length - 1]; i++) marked.add(i);
  }
  const end = start + lines.length - 1;
  const focused = focus && focus.file === file && focus.a <= end && focus.b >= start ? focus : null;
  useEffect(() => {
    if (!focused || !box.current) return;
    box.current.querySelector(`[data-ln="${Math.max(focused.a, start)}"]`)?.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused?.seq]);
  const onLine = (n: number, shift: boolean) => {
    if (ro) return;
    if (shift && anchorRef.current !== null) {
      const a = anchorRef.current;
      setPick([Math.min(a, n), Math.max(a, n)]);
    } else {
      anchorRef.current = n;
      setPick(pick && pick[0] === n && pick[1] === n ? null : [n, n]);
    }
  };
  const onMouseUp = () => {
    if (ro) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !box.current) return;
    const ln = (node: Node | null) => {
      const el = (node instanceof Element ? node : node?.parentElement)?.closest('[data-ln]') as HTMLElement | null;
      return el && box.current!.contains(el) ? Number(el.dataset.ln) : null;
    };
    const a = ln(sel.anchorNode),
      b = ln(sel.focusNode);
    if (a && b) setPick([Math.min(a, b), Math.max(a, b)]);
  };
  const request = () => {
    if (!pick) return;
    const quote = lines
      .slice(pick[0] - start, pick[1] - start + 1)
      .map((l) => l.trim())
      .join('\n')
      .trim();
    setState({ req: { kind: 'change', target: target ?? file, file, lines: pick, quote } });
    setPick(null);
  };
  const cls = (n: number) => [pick && n >= pick[0] && n <= pick[1] && 'pk', marked.has(n) && 'rq', focused && n >= focused.a && n <= focused.b && 'fx'].filter(Boolean).join(' ');
  return (
    <div ref={box}>
      <div className="code lines">
        <pre className="g">
          {lines.map((_, i) => (
            <span key={i} className={`ln ${cls(start + i)}`} data-gl={start + i} onClick={(e) => onLine(start + i, e.shiftKey)}>
              {start + i}
              {'\n'}
            </span>
          ))}
        </pre>
        <pre className="c" onMouseUp={onMouseUp}>
          {lines.map((l, i) => (
            <span key={i} className={`ln ${cls(start + i)}`} data-ln={start + i}>
              {highlight(l)}
              {'\n'}
            </span>
          ))}
        </pre>
      </div>
      {pick && (
        <div className="btns pickbar">
          <button className="btn sm primary" id="req-code" onClick={request}>
            Request change
          </button>
          <span className="m">
            {pick[0] === pick[1] ? `line ${pick[0]}` : `lines ${pick[0]}-${pick[1]}`}
          </span>
          <button className="ib" aria-label="Clear" onClick={() => setPick(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

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
export function Source(p: { file: string; from: number; to?: number; target?: string }) {
  const diff = useCompare((s) => s.diff);
  const rev = diff ? sourceRev(p.file, p.from) ?? undefined : undefined;
  const plain = <PlainSource {...p} rev={rev} />;
  if (!diff || !fileChanged(p.file)) return plain;
  return <DiffSource file={p.file} from={p.from} to={p.to && p.to >= p.from ? p.to : p.from} plain={plain} />;
}

function PlainSource({ file, from, to, rev: at, target }: { file: string; from: number; to?: number; rev?: string; target?: string }) {
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
  if (rev !== 'worktree') return <CodeBlock code={code} start={from} />;
  return <LineCode code={code} start={from} file={file} target={target} />;
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
