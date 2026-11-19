// Notes are comments on code: click a line number (shift-click for a range) and
// type; Enter adds it, right under those lines. They go in the open proposal, and
// agents read them with codemap proposal show.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { qn, type Model } from './model';
import { removeNote, select, useStore, commentTarget } from './store';
import type { Note } from './types';

// useCanNote is whether notes can be added: a proposal to put them in, and the live code.
export const useCanNote = () => useStore((s) => !!commentTarget(s) && !s.readOnly && s.rev === 'worktree');

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
