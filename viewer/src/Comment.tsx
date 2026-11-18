// Commenting on the open proposal: select something (and optionally highlight
// code in the panel), write a note, and it is appended to the proposal's body
// with a heading saying what it is about.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { qn, type Model } from './model';
import { comment, commentTarget, setState, useStore } from './store';

export interface Snip {
  file: string;
  from: number;
  to: number;
  code: string;
}

const lang = (file: string) => ({ go: 'go', ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', sql: 'sql', py: 'python' })[file.split('.').pop() ?? ''] ?? '';

// snippetOf reads the highlighted lines when the selection is inside a code block.
export function snippetOf(sel: Selection | null): Snip | null {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const el = (r.commonAncestorContainer instanceof Element ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement)?.closest('.code[data-file]') as HTMLElement | null;
  const pre = el?.querySelector('pre.c');
  if (!el || !pre) return null;
  const lineAt = (node: Node, off: number) => {
    const q = document.createRange();
    q.selectNodeContents(pre);
    if (!pre.contains(node)) return node === el || el.contains(node) ? 0 : -1;
    q.setEnd(node, off);
    return q.toString().split('\n').length - 1;
  };
  const lines = (pre.textContent ?? '').split('\n');
  const a = Math.max(0, lineAt(r.startContainer, r.startOffset));
  let b = lineAt(r.endContainer, r.endOffset);
  if (b < 0) b = lines.length - 1;
  const start = Number(el.dataset.start);
  return { file: el.dataset.file!, from: start + a, to: start + b, code: lines.slice(a, b + 1).join('\n') };
}

// aboutOf is the heading (and quote) a comment gets.
export function aboutOf(m: Model, ids: string[], snip: Snip | null): string {
  const names = ids.map((id) => {
    const x = m.node.get(id);
    if (x) return '`' + qn(m, id) + '`';
    return '`' + (m.box.get(id)?.label ?? id.replace(/^(area|group):/, '')) + '`';
  });
  const one = ids.length === 1 ? m.node.get(ids[0])?.row.node : undefined;
  let where = '';
  if (snip) where = `${snip.file}:${snip.from}${snip.to > snip.from ? '-' + snip.to : ''}`;
  else if (one?.file) where = one.file + (one.line ? ':' + one.line + (one.endLine && one.endLine > one.line ? '-' + one.endLine : '') : '');
  let out = '### ' + (names.join(', ') || 'Comment') + (where ? ' · ' + where : '');
  if (snip) out += '\n\n```' + lang(snip.file) + '\n' + snip.code + '\n```';
  return out;
}

// Comment is pinned to the bottom of the details panel: type and press Enter.
// Highlighting code in the panel quotes it and puts the cursor here; `c` does too.
export function Comment({ m, ids }: { m: Model; ids: string[] }) {
  const p = useStore(commentTarget);
  const all = useStore((s) => s.proposals);
  const open = all.filter((x) => x.status !== 'archived');
  const [text, setText] = useState('');
  const [snip, setSnip] = useState<Snip | null>(null);
  const [sent, setSent] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const key = ids.join('\0');
  useEffect(() => {
    setSnip(null);
    setSent(false);
    const onUp = () => {
      const s = snippetOf(window.getSelection());
      if (!s) return;
      setSnip(s);
      ref.current?.focus({ preventScroll: true });
    };
    const onKey = (e: KeyboardEvent) => {
      const t = document.activeElement?.tagName;
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey && t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    document.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [key]);
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 160) + 'px';
  }, [text]);
  if (!open.length) return null;
  const send = () => {
    if (!text.trim() || !p) return;
    comment(aboutOf(m, ids, snip), text);
    setText('');
    setSnip(null);
    setSent(true);
  };
  return (
    <div className="comment" id="comment">
      <div className="chead">
        <select id="c-to" aria-label="Proposal to comment on" value={p?.slug ?? ''} onChange={(e) => setState({ cslug: e.target.value })}>
          {!p && <option value="">Comment on…</option>}
          {open.map((x) => (
            <option key={x.slug} value={x.slug}>
              {x.name}
            </option>
          ))}
        </select>
        {snip && (
          <span className="about">
            {snip.file.split('/').pop()}:{snip.from}
            {snip.to > snip.from ? '–' + snip.to : ''}
            <button className="lnk" aria-label="Drop the quote" onClick={() => setSnip(null)}>
              ×
            </button>
          </span>
        )}
        {sent && !text && <span className="about">Added</span>}
      </div>
      <textarea
        id="c-text"
        ref={ref}
        rows={1}
        placeholder={p ? (snip ? 'Comment on these lines' : 'Comment (c) — Enter to add') : 'Pick a proposal first'}
        disabled={!p}
        value={text}
        onChange={(e) => (setText(e.target.value), setSent(false))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            ref.current?.blur();
          }
        }}
      />
    </div>
  );
}
