// Notes are comments on code: click a line number (shift-click for a range) and
// type; Enter adds it, right under those lines. They go in the open proposal, and
// agents read them with codemap proposal show.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { qn, type Model } from './model';
import { removeNote, select, setState, useStore, commentTarget } from './store';
import type { Note } from './types';

// useCanNote is whether notes can be added: a proposal to put them in, and the live code.
export const useCanNote = () => useStore((s) => !!commentTarget(s) && !s.readOnly && s.rev === 'worktree');

// ToProposal names the proposal a comment goes to, and switches it when several are open.
export function ToProposal() {
  const p = useStore(commentTarget);
  const proposals = useStore((s) => s.proposals);
  const open = proposals.filter((x) => x.status !== 'archived');
  if (!p) return null;
  if (open.length < 2) return <div className="nto">Comment in {p.name}</div>;
  return (
    <label className="nto">
      Comment in
      <select aria-label="Proposal to comment in" value={p.slug} onChange={(e) => setState({ cslug: e.target.value })}>
        {open.map((x) => (
          <option key={x.slug} value={x.slug}>
            {x.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// NoteBox is the one-line-to-start box a note is typed in.
export function NoteBox({ id, placeholder, onSubmit, onCancel, autoFocus }: { id?: string; placeholder: string; onSubmit: (text: string) => void; onCancel?: () => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: false });
  }, [autoFocus]);
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
  }, [text]);
  return (
    <textarea
      className="notebox"
      id={id}
      ref={ref}
      rows={1}
      value={text}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (text.trim()) {
            onSubmit(text);
            setText('');
          }
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          setText('');
          ref.current?.blur();
          onCancel?.();
        }
      }}
    />
  );
}

export function NoteBubble({ note, children }: { note: Note; children?: React.ReactNode }) {
  const can = useCanNote();
  return (
    <div className="note">
      {children}
      <p>{note.text}</p>
      {can && (
        <button className="prm" aria-label="Delete the note" title="Delete the note" onClick={() => removeNote(note)}>
          ×
        </button>
      )}
    </div>
  );
}

// where is "file:25-27".
export const where = (n: Note) => (n.file ? n.file + (n.from ? ':' + n.from + (n.to && n.to > n.from! ? '-' + n.to : '') : '') : '');

// NotesList is every note of a proposal, in the proposal's panel: the whole
// brief in one place, each opening what it's about.
export function NotesList({ m, notes }: { m: Model; notes: Note[] }) {
  return (
    <div className="notelist">
      {notes.map((n, i) => (
        <NoteBubble key={i} note={n}>
          <div className="nwhere">
            {n.on && (
              <button className="lnk" data-node={n.on} onClick={() => (m.node.has(n.on!) || m.box.has(n.on!)) && select(n.on!)}>
                {m.node.has(n.on) ? qn(m, n.on) : (m.box.get(n.on)?.label ?? n.on)}
              </button>
            )}
            {n.file && <span className="q">{where(n)}</span>}
            {!n.on && !n.file && <span className="q">the proposal</span>}
          </div>
          {n.quote && <pre className="nquote">{n.quote}</pre>}
        </NoteBubble>
      ))}
          </div>
  );
}

// selectedLines reads which lines of a code block the user just highlighted, as
// [first, last] line numbers. `root` is the block's container; null when the
// selection isn't inside it, or is empty.
export function selectedLines(root: HTMLElement): [number, number] | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.commonAncestorContainer)) return null;
  // a diff: its lines are elements numbered on the new side
  const ns = [...root.querySelectorAll<HTMLElement>('.dl[data-n]')].filter((e) => r.intersectsNode(e) && e.dataset.n);
  if (root.querySelector('.dl')) return ns.length ? [Number(ns[0].dataset.n), Number(ns[ns.length - 1].dataset.n)] : null;
  // plain source: one block of text, so count the lines before each end
  const lineAt = (node: Node, off: number, end: boolean): number | null => {
    const el = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.code[data-start]');
    const pre = el?.querySelector('pre.c');
    if (!el || !pre || !pre.contains(node)) return null;
    const q = document.createRange();
    q.selectNodeContents(pre);
    q.setEnd(node, off);
    const text = q.toString();
    // a selection that ends at the very start of a line (a triple click) doesn't include it
    return Number(el.dataset.start) + text.split('\n').length - 1 - (end && text.endsWith('\n') ? 1 : 0);
  };
  let a = lineAt(r.startContainer, r.startOffset, false);
  let b = lineAt(r.endContainer, r.endOffset, true);
  if (a == null && b == null) return null;
  a ??= b;
  b ??= a;
  return [Math.min(a!, b!), Math.max(a!, b!)];
}
