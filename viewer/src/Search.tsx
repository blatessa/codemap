import { useEffect, useMemo, useRef, useState } from 'react';
import { qn } from './model';
import { match, runs, type Field } from './search';
import { select, setMode, setState, useModel, useStore } from './store';

// ---- search and commands: / or ⌘K ----
//
// One list. Typing ranks the map's nodes, modules and proposals by how well the
// words match their names first, then paths and docs. With nothing typed it
// offers what you opened last.

interface Hit {
  id: string;
  text: string;
  kind: string; // the badge: route, func, table, module, proposal…
  where: string;
  score: number;
  marks: number[];
  run: () => void;
  dim?: boolean;
}

const MAX = 12;
const RECENT_KEY = 'codemap.recent';

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function pushRecent(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 6)));
  } catch {
    /* private window: no history */
  }
}

const openProposal = (slug: string) => {
  setMode('propose');
  setState({ pslug: slug, editing: false, sel: null });
};

export function Search({ mod }: { mod: string }) {
  const m = useModel();
  const proposals = useStore((s) => s.proposals);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const ref = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = document.activeElement?.tagName;
      const typing = t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setRecent(readRecent());
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // every place the map can go, by id, for ranking and for "recent"
  const targets = useMemo(() => {
    const out = new Map<string, Omit<Hit, 'score' | 'marks'> & { fields: Field[] }>();
    for (const [id, { row, box }] of m.node) {
      if (row.ghost) continue;
      const n = row.node;
      const text = qn(m, id);
      out.set(id, {
        id,
        text,
        kind: n.entry ? row.prefix || n.kind : n.external ? row.tag || n.kind : n.kind,
        where: box.label,
        dim: !!row.role,
        run: () => select(id, true),
        fields: [
          { text, weight: 0, fuzzy: true },
          { text: row.label, weight: 0.2, fuzzy: true },
          { text: box.label, weight: 2 },
          { text: n.file ?? '', weight: 2.5 },
          { text: n.doc ?? '', weight: 3.5 },
        ],
      });
    }
    for (const b of m.boxes) {
      if (b.ghost) continue;
      out.set(b.id, {
        id: b.id,
        text: b.label,
        kind: b.external ? 'service' : 'module',
        where: '',
        run: () => select(b.id, true),
        fields: [
          { text: b.label, weight: 0, fuzzy: true },
          { text: b.doc ?? '', weight: 3.5 },
        ],
      });
    }
    for (const p of proposals) {
      out.set('proposal:' + p.slug, {
        id: 'proposal:' + p.slug,
        text: p.name,
        kind: 'proposal',
        where: p.status === 'archived' ? 'archived' : '',
        dim: p.status === 'archived',
        run: () => openProposal(p.slug),
        fields: [
          { text: p.name, weight: 0.5, fuzzy: true },
          { text: p.body ?? '', weight: 4 },
        ],
      });
    }
    return out;
  }, [m, proposals]);

  const hits = useMemo<Hit[]>(() => {
    const s = q.trim();
    if (!s) {
      return recent.flatMap((id) => {
        const t = targets.get(id);
        return t ? [{ ...t, score: 0, marks: [] as number[] }] : [];
      }).slice(0, 6);
    }
    const out: Hit[] = [];
    for (const t of targets.values()) {
      const r = match(s, t.fields);
      if (r) out.push({ ...t, score: r.score, marks: r.marks });
    }
    // best match first; ties go to what you can start a story from, then shorter names
    return out.sort((a, b) => a.score - b.score || +!!a.dim - +!!b.dim || a.text.length - b.text.length || a.text.localeCompare(b.text)).slice(0, MAX);
  }, [q, targets, recent]);

  useEffect(() => {
    list.current?.querySelector('.hit.act')?.scrollIntoView({ block: 'nearest' });
  }, [act, hits]);

  const go = (h: Hit) => {
    setQ('');
    setOpen(false);
    ref.current?.blur();
    pushRecent(h.id);
    h.run();
  };
  const showing = open && (hits.length > 0 || !!q.trim());
  const empty = !q.trim();

  return (
    <div className="search">
      <input
        id="q"
        ref={ref}
        type="search"
        role="combobox"
        aria-expanded={showing}
        aria-controls="results"
        placeholder="Search"
        autoComplete="off"
        aria-label="Search the map"
        value={q}
        onChange={(e) => {
          clearTimeout(closeTimer.current);
          setQ(e.target.value);
          setOpen(true);
          setAct(0);
        }}
        onFocus={() => {
          clearTimeout(closeTimer.current);
          setRecent(readRecent());
          setOpen(true);
        }}
        onBlur={() => {
          clearTimeout(closeTimer.current);
          closeTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[act]) {
            e.preventDefault();
            go(hits[act]);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setAct((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setAct((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Escape') {
            setQ('');
            setOpen(false);
            ref.current?.blur();
          }
        }}
      />
      <kbd className="kbd">{mod}K</kbd>
      <div className="results" id="results" role="listbox" ref={list} hidden={!showing}>
        {empty && hits.length > 0 && <div className="rhead">Recent</div>}
        {hits.map((h, i) => (
          <div key={h.id}>
            <button
              role="option"
              aria-selected={i === act}
              className={`hit ${i === act ? 'act' : ''} ${h.dim ? 'dim' : ''}`}
              data-go={h.id}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== act && setAct(i)}
              onClick={() => go(h)}
            >
              <span className="k">{h.kind}</span>
              <span className="t">
                {runs(h.text, h.marks).map((r, j) => (r.hit ? <mark key={j}>{r.t}</mark> : r.t))}
              </span>
              <span className="w">{h.where}</span>
            </button>
          </div>
        ))}
        {!hits.length && q.trim() && <div className="rnone">No matches for “{q.trim()}”</div>}
      </div>
    </div>
  );
}
