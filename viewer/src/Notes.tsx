// Notes are comments on code: click a line number (shift-click for a range) and
// type; Enter adds it, right under those lines. They go in the open proposal, and
// agents read them with codemap proposal show.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { qn, type Model } from './model';
import { editNote, removeNote, select, setState, useStore, commentTarget } from './store';
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

// NoteBox is where a comment is typed: Enter (or the button) adds it, Shift+Enter
// is a new line, Esc cancels. It also edits one: pass `initial`.
export function NoteBox({ id, placeholder, initial = '', label = 'Comment', onSubmit, onCancel, autoFocus }: { id?: string; placeholder: string; initial?: string; label?: string; onSubmit: (text: string) => void; onCancel?: () => void; autoFocus?: boolean }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.focus();
    ref.current?.setSelectionRange(initial.length, initial.length);
  }, [autoFocus, initial]);
  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
  }, [text]);
  const submit = () => text.trim() && (onSubmit(text), setText(''));
  return (
    <div className="nbox">
      <textarea
        className="notebox"
        id={id}
        ref={ref}
        rows={2}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel?.();
          }
        }}
      />
      <div className="nfoot">
        <span>Enter to {label.toLowerCase()} · Esc to cancel</span>
        {onCancel && (
          <button className="btn sm" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary sm" disabled={!text.trim()} onClick={submit}>
          {label}
        </button>
      </div>
    </div>
  );
}

// NoteBubble is a comment, under the code it is about. Click it to edit.
export function NoteBubble({ note, children }: { note: Note; children?: React.ReactNode }) {
  const can = useCanNote();
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <div className="note draft">
        <NoteBox
          autoFocus
          initial={note.text}
          label="Save"
          placeholder="Comment"
          onCancel={() => setEditing(false)}
          onSubmit={(text) => {
            editNote(note, text);
            setEditing(false);
          }}
        />
      </div>
    );
  return (
    <div className="note">
      {children}
      <p className={can ? 'editable' : undefined} title={can ? 'Click to edit' : undefined} onClick={() => can && setEditing(true)}>
        {note.text}
      </p>
      {can && (
        <button className="prm" aria-label="Delete the comment" title="Delete the comment" onClick={() => removeNote(note)}>
          ×
        </button>
      )}
    </div>
  );
}

// useLineDrag is the gutter's add-comment icon, as on GitHub and in VS Code:
// press on a line's + and drag down the numbers for a range (or just click for
// one line, or shift-click to extend); the comment box opens under the last.
export function useLineDrag(done: (lines: [number, number], shift: boolean) => void) {
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const cur = useRef<[number, number] | null>(null);
  const shift = useRef(false);
  const fin = useRef(done);
  fin.current = done;
  return {
    drag: drag && ([Math.min(drag[0], drag[1]), Math.max(drag[0], drag[1])] as [number, number]),
    gutter: {
      down: (n: number, shiftKey: boolean) => {
        cur.current = [n, n];
        shift.current = shiftKey;
        setDrag([n, n]);
        window.addEventListener(
          'pointerup',
          () => {
            const r = cur.current;
            cur.current = null;
            setDrag(null);
            if (r) fin.current([Math.min(r[0], r[1]), Math.max(r[0], r[1])], shift.current);
          },
          { once: true },
        );
      },
      enter: (n: number) => {
        if (!cur.current) return;
        cur.current = [cur.current[0], n];
        setDrag([cur.current[0], n]);
      },
    },
  };
}

// useCommentChip is highlighting code to comment on it: selecting lines shows a
// small "Comment" button by the selection (so selecting to copy is left alone),
// and clicking it opens the comment box under those lines.
export function useCommentChip(open: (lines: [number, number]) => void, enabled: boolean) {
  const [chip, setChip] = useState<{ x: number; y: number; lines: [number, number] } | null>(null);
  useEffect(() => {
    if (!chip) return;
    const gone = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.('.schip')) setChip(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setChip(null);
    document.addEventListener('mousedown', gone);
    document.addEventListener('scroll', gone, true);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', gone);
      document.removeEventListener('scroll', gone, true);
      window.removeEventListener('keydown', esc);
    };
  }, [chip]);
  const onMouseUp = (e: React.MouseEvent<HTMLElement>) => {
    if (!enabled || (e.target as Element).closest('.note, .schip')) return;
    const lines = selectedLines(e.currentTarget);
    const sel = window.getSelection();
    if (!lines || !sel?.rangeCount) return setChip(null);
    const r = sel.getRangeAt(0).getBoundingClientRect();
    setChip({ x: Math.min(r.right, window.innerWidth - 120), y: r.bottom + 6, lines });
  };
  const el = chip && (
    <button
      className="schip"
      style={{ left: chip.x, top: chip.y }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        window.getSelection()?.removeAllRanges();
        open(chip.lines);
        setChip(null);
      }}
    >
      Comment
    </button>
  );
  return { onMouseUp, chip: el };
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
