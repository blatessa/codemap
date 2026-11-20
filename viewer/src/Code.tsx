import { memo, useEffect, useState, type ReactNode } from 'react';
import { getSource, openInEditor } from './api';
import { addNote, commentTarget, useStore } from './store';
import { NoteBox, NoteBubble, ToProposal, selectedLines, useCanNote, where } from './Notes';
import type { Note } from './types';
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

export const CodeBlock = memo(function CodeBlock({ code, start, file, onLine, mark }: { code: string; start: number; file?: string; onLine?: (n: number, shift: boolean) => void; mark?: [number, number] | null }) {
  const n = code.split('\n').length;
  return (
    <div className="code" data-file={file} data-start={start}>
      <pre className="g">
        {onLine
          ? Array.from({ length: n }, (_, i) => start + i).map((x) => (
              <span key={x}>
                <span className={`ln ${mark && x >= mark[0] && x <= mark[1] ? 'sel' : ''}`} data-ln={x} role="button" title="Add a note here" onClick={(e) => onLine(x, e.shiftKey)}>
                  {x}
                </span>
                {x < start + n - 1 ? '\n' : ''}
              </span>
            ))
          : Array.from({ length: n }, (_, i) => start + i).join('\n')}
      </pre>
      <pre className="c">{highlight(code)}</pre>
    </div>
  );
});

// NotedCode is code you can leave notes in: click a line number (shift-click
// another for a range) and type under it. Notes already there show under their
// lines, so the code reads with the author's remarks in it.
function NotedCode({ code, start, file, on }: { code: string; start: number; file: string; on?: string }) {
  const p = useStore(commentTarget);
  const can = useCanNote();
  const [draft, setDraft] = useState<[number, number] | null>(null);
  const lines = code.split('\n');
  const end = start + lines.length - 1;
  const notes = (p?.notes ?? []).filter((n) => n.file === file && n.from != null && n.from >= start && n.from <= end);
  const endOf = (n: Note) => Math.min(Math.max(n.to ?? n.from!, n.from!), end);
  const cuts = [...new Set([...notes.map(endOf), ...(draft ? [draft[1]] : [])])].sort((a, b) => a - b);
  if (!cuts.includes(end)) cuts.push(end);
  const onLine = (n: number, shift: boolean) =>
    setDraft((d) => (shift && d ? [Math.min(d[0], n), Math.max(d[1], n)] : d && d[0] === n && d[1] === n ? null : [n, n]));
  let from = start;
  // highlighting code comments on it, as clicking a line number does
  const onUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!can || (e.target as Element).closest('.note')) return;
    const r = selectedLines(e.currentTarget);
    if (!r) return;
    window.getSelection()?.removeAllRanges();
    setDraft([Math.max(r[0], start), Math.min(r[1], end)]);
  };
  return (
    <div className="lined" onMouseUp={onUp}>
      {cuts.map((cut) => {
        const part = lines.slice(from - start, cut - start + 1).join('\n');
        const first = from;
        from = cut + 1;
        return (
          <div key={cut}>
            <CodeBlock code={part} start={first} file={file} onLine={can ? onLine : undefined} mark={draft} />
            {notes
              .filter((n) => endOf(n) === cut)
              .map((n, i) => (
                <NoteBubble key={i} note={n}>
                  {n.to && n.to > n.from! && <div className="nwhere">{where(n)}</div>}
                </NoteBubble>
              ))}
            {draft && draft[1] === cut && (
              <div className="note draft">
                <ToProposal />
                <NoteBox
                  autoFocus
                  placeholder={`Note on ${file.split('/').pop()}:${draft[0]}${draft[1] > draft[0] ? '–' + draft[1] : ''}`}
                  onCancel={() => setDraft(null)}
                  onSubmit={(text) => {
                    const [a, b] = draft;
                    addNote({ on, file, from: a, to: b > a ? b : undefined, quote: lines.slice(a - start, b - start + 1).join('\n'), text });
                    setDraft(null);
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
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
export function Source(p: { file: string; from: number; to?: number; on?: string }) {
  const diff = useCompare((s) => s.diff);
  const rev = diff ? sourceRev(p.file, p.from) ?? undefined : undefined;
  const plain = <PlainSource {...p} rev={rev} />;
  if (!diff || !fileChanged(p.file)) return plain;
  return <DiffSource file={p.file} from={p.from} to={p.to && p.to >= p.from ? p.to : p.from} plain={plain} on={p.on} />;
}

function PlainSource({ file, from, to, on, rev: at }: { file: string; from: number; to?: number; on?: string; rev?: string }) {
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
  return <NotedCode code={code} start={from} file={file} on={on} />;
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
