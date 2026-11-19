import { useEffect, useMemo, useRef, useState } from 'react';
import { openInEditor } from './api';
import { CompareControl, SummaryPanel } from './Compare';
import { Drawer } from './Drawer';
import { compare, presets, start as startRevs, useCompare, view as viewRev } from './revs';
import { PartMap, zoomCenter } from './PartMap';
import { qn } from './model';
import {
  currentProposal,
  getState,
  load,
  select,
  storyOf,
  setMode,
  setState,
  subscribe,
  useModel,
  useStore,
} from './store';

// ---- commands: what ⌘K and the right-click menus can do ----

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
  off?: boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl ';

const fit = () => setState({ fitSeq: getState().fitSeq + 1, touchedView: false });

function useMapCommands(): Cmd[] {
  const ro = useStore((s) => s.readOnly);
  const revs = useCompare((c) => c.revs);
  const spec = useCompare((c) => c.spec);
  const propose = useStore((s) => s.mode === 'propose' && !!currentProposal(s));
  return [
    { id: 'addmod', label: 'Propose a new module', run: () => setState({ form: { type: 'mod' }, sel: [], connectFrom: null }), off: !propose || ro },
    { id: 'fit', label: 'Fit map to screen', hint: '0', run: fit },
    { id: 'proposals', label: 'Proposals', run: () => setMode('propose') },
    ...presets(revs).map((p) => ({ id: 'cmp-' + p.id, label: 'Compare: ' + p.label, run: () => void compare(p.from, p.to) })),
    { id: 'cmp-off', label: 'Stop comparing', run: () => void viewRev('worktree'), off: !spec },
  ].filter((c) => !c.off);
}

// ---- search, with commands: / or ⌘K ----

function Search() {
  const m = useModel();
  const cmds = useMapCommands();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = document.activeElement?.tagName;
      const typing = t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // tier: features first, then data and outside systems, modules, functions, support code
  type Hit = { id: string; text: string; where: string; score: number; tier: number; cmd?: Cmd };
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [] as Hit[];
    const out: Hit[] = [];
    for (const [id, { row, box }] of m.node) {
      if (row.ghost) continue;
      const text = qn(m, id);
      const n = row.node;
      const lab = text.toLowerCase();
      let score = lab === s ? 0 : lab.startsWith(s) || row.label.toLowerCase().startsWith(s) ? 1 : lab.includes(s) ? 2 : -1;
      if (score < 0) {
        const hay = (box.label + ' ' + (n.file ?? '') + ' ' + (n.doc ?? '')).toLowerCase();
        if (!hay.includes(s)) continue;
        score = 3;
      }
      out.push({ id, text, where: box.label, score, tier: n.entry ? 0 : n.external ? 1 : row.role ? 4 : 3 });
    }
    for (const b of m.boxes) {
      const lab = b.label.toLowerCase();
      if (b.ghost || !lab.includes(s)) continue;
      out.push({ id: b.id, text: b.label, where: 'module', score: lab === s ? 0 : lab.endsWith('/' + s) || lab.startsWith(s) ? 1 : 2, tier: 2 });
    }
    const words = s.split(/\s+/);
    for (const c of cmds) {
      const l = c.label.toLowerCase();
      if (words.every((w) => l.includes(w))) out.push({ id: 'cmd:' + c.id, text: c.label, where: '', score: l.startsWith(s) ? 1.5 : 2.5, tier: 2, cmd: c });
    }
    // an exact name first, then name matches by tier, then the rest by tier
    const bucket = (h: Hit) => (h.score === 0 ? 0 : h.score < 3 ? 1 : 2);
    return out.sort((a, b) => bucket(a) - bucket(b) || a.tier - b.tier || a.score - b.score || a.text.localeCompare(b.text)).slice(0, 9);
  }, [q, m, cmds]);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const go = (h: Hit) => {
    setQ('');
    setOpen(false);
    ref.current?.blur();
    if (h.cmd) return h.cmd.run();
    select(h.id, true);
  };
  return (
    <div className="search">
      <input
        id="q"
        ref={ref}
        type="search"
        placeholder="Search or run a command"
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
      <kbd className="kbd">{MOD}K</kbd>
      <div className="results" id="results" hidden={!open || !q.trim()}>
        {hits.length ? (
          hits.map((h, i) => (
            <button key={h.id} className={`res ${i === act ? 'act' : ''} ${h.cmd ? 'cmd' : ''}`} data-go={h.id} onMouseDown={(e) => e.preventDefault()} onClick={() => go(h)}>
              <span>{h.text}</span>
              <span className="m">{h.cmd ? 'command' : h.where}</span>
            </button>
          ))
        ) : (
          <div className="res">
            <span className="m">No matches</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- map controls, bottom right ----

function useOutside<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function MapControls() {
  return (
    <div className="mapctl">
      <div className="ctlgrp">
        <button className="ctl" id="zout" aria-label="Zoom out" onClick={() => zoomCenter(1 / 1.2)}>
          −
        </button>
        <button className="ctl" id="fit" title="Fit (0)" onClick={fit}>
          Fit
        </button>
        <button className="ctl" id="zin" aria-label="Zoom in" onClick={() => zoomCenter(1.2)}>
          +
        </button>
      </div>
    </div>
  );
}

// ---- right-click menus ----

interface Menu {
  x: number;
  y: number;
  kind: 'node' | 'box' | 'canvas';
  id: string;
}

function ContextMenu({ menu, close }: { menu: Menu; close: () => void }) {
  const m = useModel();
  const ro = useStore((s) => s.readOnly);
  const map = useMapCommands();
  const ref = useOutside<HTMLDivElement>(true, close);
  let items: (Cmd | null)[] = [];
  if (menu.kind === 'node') {
    const x = m.node.get(menu.id)!;
    const n = x.row.node;
    items = [
      { id: 'comment', label: 'Comment', hint: 'C', run: () => (select(menu.id), setTimeout(() => document.getElementById('c-text')?.focus(), 50)), off: ro },
      { id: 'editor', label: 'Open in editor', run: () => void openInEditor(n.file!, n.line ?? 1), off: !n.file },
      { id: 'copy', label: 'Copy ID', run: () => void navigator.clipboard?.writeText(menu.id) },
    ];
  } else if (menu.kind === 'box') {
    items = [
      { id: 'open', label: 'Show what’s inside', run: () => select(menu.id) },
      { id: 'comment', label: 'Comment', hint: 'C', run: () => (select(menu.id), setTimeout(() => document.getElementById('c-text')?.focus(), 50)), off: ro },
    ];
  } else items = map.filter((c) => !c.id.startsWith('cmp-') && c.id !== 'proposals');
  const shown = items.filter((c) => c === null || !c.off);
  // no separator at the ends
  while (shown.length && shown[shown.length - 1] === null) shown.pop();
  return (
    <div className="ctxmenu" id="ctxmenu" ref={ref} style={{ left: menu.x, top: menu.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {shown.map((c, i) =>
        c ? (
          <button
            key={c.id}
            role="menuitem"
            data-cmd={c.id}
            onClick={() => {
              close();
              c.run();
            }}
          >
            <span>{c.label}</span>
            {c.hint && <kbd>{c.hint}</kbd>}
          </button>
        ) : (
          <hr key={'s' + i} />
        ),
      )}
    </div>
  );
}

// ---- top bar ----

function ProposalsButton() {
  const mode = useStore((s) => s.mode);
  const n = useStore((s) => s.proposals.filter((p) => p.status !== 'archived').length);
  return (
    <button className={`topbtn plan`} id="m-propose" aria-pressed={mode === 'propose'} onClick={() => setMode(mode === 'propose' ? 'explore' : 'propose')}>
      Proposals{n ? <span className="count">{n}</span> : null}
    </button>
  );
}


export function App() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const comparing = useCompare((c) => !!c.spec);
  const summary = useStore((s) => comparing && !s.sel.length && !s.form && s.mode === 'explore');
  const drawerOpen = useStore((s) => s.sel.length > 0 || !!s.form || s.mode === 'propose') || summary;
  const [menu, setMenu] = useState<Menu | null>(null);
  const m = useModel();
  useEffect(() => {
    if (!startRevs()) void load();
    subscribe();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === '0') return fit();
      }
      if (e.key !== 'Escape') return;
      if (t.id === 'q') return;
      const s = getState();
      if (s.connectFrom) return setState({ connectFrom: null });
      if (t.id === 'p-body' || t.id === 'pl-q') return;
      if (!s.sel.length && !s.form && s.mode === 'propose' && s.pslug) return setState({ pslug: null, editing: false });
      if (!s.sel.length && !s.form && s.mode === 'propose') return setMode('explore');
      // a step of a story goes back to the story
      if (s.story && s.sel[0] !== s.story && storyOf(s)) return setState({ sel: [s.story], form: null, hover: null });
      setState({ sel: [], form: null, hover: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const onContext = (e: React.MouseEvent) => {
    const t = e.target as Element;
    if (!t.closest('#map')) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = { x: Math.min(e.clientX - r.left, r.width - 240), y: Math.min(e.clientY - r.top, r.height - 260) };
    const n = (t.closest('[data-node]') as HTMLElement | null)?.dataset.node;
    const b = (t.closest('[data-box]') as HTMLElement | null)?.dataset.box;
    if (n && m.node.has(n)) setMenu({ ...at, kind: 'node', id: n });
    else if (b && m.box.has(b)) setMenu({ ...at, kind: 'box', id: b });
    else setMenu({ ...at, kind: 'canvas', id: '' });
  };
  return (
    <>
      <header className="top">
        <h1>codemap</h1>
        <CompareControl />
        <Search />
        <ProposalsButton />
      </header>
      <div className="stage">
        <div className={`canvas${drawerOpen ? ' dopen' : ''}`} onContextMenu={onContext}>
          {status === 'ready' ? <PartMap drawerOpen={drawerOpen} /> : <div className="loading">{status === 'error' ? error : 'Loading…'}</div>}
          {status === 'ready' && <MapControls />}
          {menu && <ContextMenu menu={menu} close={() => setMenu(null)} />}
        </div>
        {status === 'ready' && (summary ? <SummaryPanel /> : <Drawer />)}
      </div>
    </>
  );
}
