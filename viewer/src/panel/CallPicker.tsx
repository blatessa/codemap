// Wiring from the panel: find what a proposed call goes to by name. (On the map,
// clicking a part does the same where it is: see MapPopup.)
import { useEffect, useRef, useState } from 'react';
import { qn, type Model } from '../model';
import { proposeEdge, setState } from '../store';
import { Section } from './common';

// CallPicker: what a proposed call goes to, found by name.
export function CallPicker({ m, from }: { m: Model; from: string }) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length
    ? [...m.node.keys()]
        .filter((x) => x !== from)
        .map((x) => ({ id: x, name: qn(m, x) }))
        .filter((h) => words.every((w) => h.name.toLowerCase().includes(w)))
        .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
        .slice(0, 8)
    : [];
  const pick = (to: string) => {
    proposeEdge(from, to);
    setState({ connectFrom: null });
  };
  return (
    <Section title={`${qn(m, from)} calls…`}>
      <input
        ref={ref}
        id="pick-q"
        className="pick"
        placeholder="Function, table or service"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[0]) pick(hits[0].id);
          if (e.key === 'Escape') setState({ connectFrom: null });
        }}
      />
      <div className="links">
        {hits.map((h) => (
          <button key={h.id} className="lnk" data-pick={h.id} onClick={() => pick(h.id)}>
            {h.name}
          </button>
        ))}
      </div>
    </Section>
  );
}
