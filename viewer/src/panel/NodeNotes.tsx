// The Notes section of a node's or part's panel.
import { useEffect } from 'react';
import { NoteBox, NoteBubble, useCanNote } from '../Notes';
import { qn, type Model } from '../model';
import { addNote, commentTarget, setState, useStore } from '../store';
import { Section } from './common';

// NodeNotes is the Notes section of a node's or part's panel: what's pinned to it,
// and a box to add more. `c` goes to the box.
export function NodeNotes({ m, id }: { m: Model; id: string }) {
  const p = useStore(commentTarget);
  const can = useCanNote();
  const open = useStore((s) => s.proposals).filter((x) => x.status !== 'archived');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = document.activeElement?.tagName;
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey && t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') {
        const box = document.getElementById('note-text');
        if (!box) return;
        e.preventDefault();
        box.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const mine = (p?.notes ?? []).filter((n) => n.on === id && !n.file);
  if (!can && !mine.length) return null;
  return (
    <Section title="Notes" count={mine.length || undefined}>
      {mine.map((n, i) => (
        <NoteBubble key={i} note={n} />
      ))}
      {can && (
        <>
          {open.length > 1 && (
            <select className="noteto" aria-label="Proposal to note on" value={p?.slug ?? ''} onChange={(e) => setState({ cslug: e.target.value })}>
              {open.map((x) => (
                <option key={x.slug} value={x.slug}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
          <NoteBox id="note-text" placeholder={`Tell the agent something about ${m.node.has(id) ? qn(m, id) : (m.box.get(id)?.label ?? id)} (c)`} onSubmit={(text) => addNote({ on: id, text })} />
        </>
      )}
    </Section>
  );
}

