// Wiring a proposal: one box. Type a name and Enter connects to the code that
// matches, or adds a new node and connects it in the same step.
//
//   Enter           add it and stay on this node (the next call goes from here)
//   Shift+Enter     add it and go into it (the next call goes from the new node)
//   Tab             flip between "calls" and "is called by"
//   @orders         put a new node in that part;  POST /path  a route;  table x
import { useEffect, useRef, useState } from 'react';
import { qn, type Model } from '../model';
import { proposeEdge, proposeNode, select, setState, useStore } from '../store';
import { parseSpec, plan } from '../wire';
import { Section } from './common';

type Row = { kind: 'old'; id: string; name: string } | { kind: 'new'; text: string };

export function CallPicker({ m, from }: { m: Model; from: string }) {
  const [q, setQ] = useState('');
  const [into, setInto] = useState(false);
  const [at, setAt] = useState(0);
  const [done, setDone] = useState<string[]>([]);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const wireBox = useStore((s) => s.wireBox);
  const home = (wireBox && m.box.get(wireBox)) || m.node.get(from)?.box;

  const spec = parseSpec(q);
  const pl = spec ? plan(m, spec, home) : null;
  const words = (spec?.label ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const rows: Row[] = [];
  if (words.length)
    for (const h of [...m.node.keys()]
      .filter((x) => x !== from)
      .map((x) => ({ id: x, name: qn(m, x) }))
      .filter((h) => words.every((w) => h.name.toLowerCase().includes(w)))
      .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, 6))
      rows.push({ kind: 'old', ...h });
  if (pl) rows.push({ kind: 'new', text: `New ${pl.kind === 'route' ? pl.method + ' route' : pl.kind} “${pl.label}” in ${pl.box.label}` });
  const cur = Math.min(at, Math.max(rows.length - 1, 0));

  const verb = into ? 'is called by' : 'calls';
  const commit = (r: Row, dive: boolean) => {
    let id: string | null = null;
    if (r.kind === 'old') {
      if (into) proposeEdge(r.id, from);
      else proposeEdge(from, r.id);
      id = r.id;
      setDone((d) => [...d, `${verb} ${r.name}`]);
    } else if (pl) {
      id = proposeNode(pl.box.id, pl.label, pl.kind, pl.method, pl.box.external, { from, into });
      setDone((d) => [...d, `${verb} ${r.text.replace(/^New /, 'new ').replace(/ in .*$/, '')}`]);
    }
    setQ('');
    setAt(0);
    if (dive && id) {
      select(id);
      setState({ connectFrom: id });
    }
  };
  return (
    <Section title={`${qn(m, from)} ${verb}…`}>
      <input
        ref={ref}
        id="pick-q"
        className="pick"
        placeholder="Name it: an existing function, or a new one"
        autoComplete="off"
        value={q}
        onChange={(e) => (setQ(e.target.value), setAt(0))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && rows[cur]) {
            e.preventDefault();
            commit(rows[cur], e.shiftKey);
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setAt((cur + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % Math.max(rows.length, 1));
          } else if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            setInto(!into);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setState({ connectFrom: null });
          }
        }}
      />
      <div className="links picks">
        {rows.map((r, i) => (
          <button
            key={r.kind === 'old' ? r.id : 'new'}
            className={`lnk ${i === cur ? 'on' : ''} ${r.kind === 'new' ? 'mk' : ''}`}
            data-pick={r.kind === 'old' ? r.id : undefined}
            onMouseEnter={() => setAt(i)}
            onClick={(e) => commit(r, e.shiftKey)}
          >
            {r.kind === 'new' ? '+ ' + r.text : r.name}
          </button>
        ))}
        {spec?.at && !pl && <p className="none">No part is named “{spec.at}”.</p>}
      </div>
      {done.length > 0 && (
        <div className="wired">
          {done.map((d, i) => (
            <span key={i}>✓ {d}</span>
          ))}
        </div>
      )}
      <p className="hint">
        Enter adds · Shift+Enter goes into it · Tab: {into ? 'it calls this' : 'this calls it'} · @part · POST /path · table name
      </p>
    </Section>
  );
}
