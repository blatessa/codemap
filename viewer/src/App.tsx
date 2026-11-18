import { useEffect, useMemo, useRef, useState } from 'react';
import { CompareControl, SummaryPanel } from './Compare';
import { Drawer } from './Drawer';
import { start as startRevs, useCompare } from './revs';
import { MapView, useAreaRect, zoomCenter } from './MapView';
import { qn } from './model';
import {
  addArea,
  applyView,
  currentProposal,
  deleteView,
  getState,
  load,
  resetLayout,
  saveView,
  select,
  setMode,
  setDetail,
  setState,
  subscribe,
  unhide,
  useModel,
  useStore,
} from './store';

function Search() {
  const m = useModel();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = document.activeElement?.tagName;
      if (e.key === '/' && t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const out: { id: string; text: string; where: string; score: number }[] = [];
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
      out.push({ id, text, where: box.label, score });
    }
    return out.sort((a, b) => a.score - b.score || a.text.localeCompare(b.text)).slice(0, 8);
  }, [q, m]);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const go = (id: string) => {
    const s = getState();
    const box = m.node.get(id)?.box.id;
    const c = new Set(s.collapsed);
    if (box) c.delete(box);
    setQ('');
    setOpen(false);
    ref.current?.blur();
    select(id);
    setState({ collapsed: c, centerOn: id, ...(s.view.k < 0.55 ? { view: { ...s.view, k: 0.9 } } : {}) });
  };
  return (
    <div className="search">
      <input
        id="q"
        ref={ref}
        type="search"
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
          setOpen(true);
        }}
        onBlur={() => {
          clearTimeout(closeTimer.current);
          closeTimer.current = setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[act]) {
            e.preventDefault();
            go(hits[act].id);
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
      <div className="results" id="results" hidden={!open || !q.trim()}>
        {hits.length ? (
          hits.map((h, i) => (
            <button key={h.id} className={`res ${i === act ? 'act' : ''}`} data-go={h.id} onMouseDown={(e) => e.preventDefault()} onClick={() => go(h.id)}>
              <span>{h.text}</span>
              <span className="m">{h.where}</span>
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

// hideName is how a hidden.toml entry reads in the list.
function hideName(m: ReturnType<typeof useModel>, h: { id?: string; match?: string; module?: string }) {
  if (h.match) return h.module ? `${h.match} in ${m.box.get(h.module)?.label ?? h.module}` : h.match;
  const id = h.id ?? '';
  if (m.node.has(id)) return qn(m, id);
  return m.box.get(id)?.label ?? id;
}

function Views() {
  const m = useModel();
  const views = useStore((s) => s.views);
  const hidden = useStore((s) => s.hidden);
  const [showHidden, setShowHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const save = () => {
    if (!name.trim()) return;
    saveView(name.trim());
    setName('');
  };
  return (
    <div className="search" ref={ref}>
      <button className="tool" id="viewsbtn" aria-expanded={open} onClick={() => setOpen(!open)}>
        Views ▾
      </button>
      <div className="pop" id="views" hidden={!open}>
        {views.map((v) => (
          <div className="vrow" key={v.name}>
            <button
              className="res"
              data-view={v.name}
              onClick={() => {
                applyView(v);
                setOpen(false);
              }}
            >
              <span>{v.name}</span>
            </button>
            <button className="del" aria-label="Delete view" onClick={() => deleteView(v.name)}>
              ×
            </button>
          </div>
        ))}
        {hidden.length > 0 && (
          <>
            <button className="res" id="hiddenbtn" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
              <span>Hidden ({hidden.length})</span>
            </button>
            {showHidden &&
              hidden.map((h, i) => (
                <div className="vrow hrow" key={i} data-hidden={h.id ?? h.match}>
                  <span className="hname">{hideName(m, h)}</span>
                  <button className="del" aria-label="Unhide" onClick={() => unhide(i)}>
                    Unhide
                  </button>
                </div>
              ))}
          </>
        )}
        <div className="vsave">
          <input id="v-name" placeholder="Save current as…" autoComplete="off" aria-label="View name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          <button onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

function Tools() {
  const m = useModel();
  const sel = useStore((s) => s.sel);
  const focus = useStore((s) => s.focus);
  const collapsed = useStore((s) => s.collapsed);
  const layoutSaved = useStore((s) => s.layoutSaved);
  const propose = useStore((s) => s.mode === 'propose' && !!currentProposal(s));
  const pos = useStore((s) => s.pos);
  const areas = useStore((s) => s.areas);
  const rectOf = useAreaRect();
  const newArea = () => {
    const sm = sel.length === 1 && m.box.has(sel[0]) && !m.box.get(sel[0])!.prop && !m.box.get(sel[0])!.ghost ? sel[0] : null;
    let bottom = 0;
    for (const b of m.boxes) {
      const p = pos[b.id];
      if (p) bottom = Math.max(bottom, p[1] + b.defH);
    }
    for (const a of areas) {
      const r = rectOf(a);
      if (r) bottom = Math.max(bottom, r.y + r.h);
    }
    addArea(sm ? [sm] : [], rectOf, [20, bottom + 40]);
  };
  return (
    <div className="tools">
      <Search />
      <Views />
      <button className="tool" id="zin" aria-label="Zoom in" onClick={() => zoomCenter(1.2)}>
        +
      </button>
      <button className="tool" id="zout" aria-label="Zoom out" onClick={() => zoomCenter(1 / 1.2)}>
        −
      </button>
      <button className="tool" id="fit" onClick={() => setState({ fitSeq: getState().fitSeq + 1, touchedView: false })}>
        Fit
      </button>
      <button className="tool" id="focus" aria-pressed={focus && sel.length > 0} disabled={!sel.length} onClick={() => setState({ focus: !focus })}>
        Focus
      </button>
      <button
        className="tool"
        id="collapse"
        onClick={() => setState({ collapsed: collapsed.size ? new Set() : new Set(m.boxes.filter((b) => !b.hasEntry).map((b) => b.id)) })}
      >
        {collapsed.size ? 'Expand all' : 'Collapse all'}
      </button>
      <button className="tool" id="reset" hidden={!layoutSaved} onClick={resetLayout}>
        Reset layout
      </button>
      <button className="tool" id="addarea" onClick={newArea}>
        + Area
      </button>
      <button className="tool plan" id="addmod" hidden={!propose} onClick={() => setState({ form: { type: 'mod' }, sel: [], connectFrom: null })}>
        + Module
      </button>
    </div>
  );
}

function Banner() {
  const m = useModel();
  const from = useStore((s) => s.connectFrom);
  if (!from) return null;
  return (
    <div className="banner" id="banner">
      {(m.node.get(from)?.row.label ?? from) + ' calls…'}
    </div>
  );
}



function DetailPick() {
  const detail = useStore((s) => s.detail);
  return (
    <div className="seg" id="detail" role="group" aria-label="Detail">
      <button id="d-features" aria-pressed={detail === 'features'} onClick={() => setDetail('features')}>
        Features
      </button>
      <button id="d-code" aria-pressed={detail === 'code'} onClick={() => setDetail('code')}>
        Code
      </button>
    </div>
  );
}

export function App() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const mode = useStore((s) => s.mode);
  const comparing = useCompare((c) => !!c.spec);
  const summary = useStore((s) => comparing && !s.sel.length && !s.form && s.mode === 'explore');
  const drawerOpen = useStore((s) => s.sel.length > 0 || !!s.form || s.mode === 'propose') || summary;
  useEffect(() => {
    if (!startRevs()) void load();
    subscribe();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement;
      if (t.id === 'q') return;
      const s = getState();
      if (s.connectFrom) return setState({ connectFrom: null });
      if (t.id === 'p-body' || t.id === 'pl-q') return;
      if (!s.sel.length && !s.form && s.mode === 'propose' && s.pslug) return setState({ pslug: null, editing: false });
      setState({ sel: [], form: null, hover: null, focus: false, splitting: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <header className="top">
        <h1>codemap</h1>
        <CompareControl />
        <DetailPick />
        <div className="seg mode" role="group" aria-label="Mode">
          <button id="m-explore" aria-pressed={mode === 'explore'} onClick={() => setMode('explore')}>
            Explore
          </button>
          <button id="m-propose" className="plan" aria-pressed={mode === 'propose'} onClick={() => setMode('propose')}>
            Propose
          </button>
        </div>
      </header>
      <div className="stage">
        <div className="canvas">
          {status === 'ready' ? <MapView drawerOpen={drawerOpen} /> : <div className="loading">{status === 'error' ? error : 'Loading…'}</div>}
          <Tools />
          <Banner />
        </div>
        {status === 'ready' && (summary ? <SummaryPanel /> : <Drawer />)}
      </div>
    </>
  );
}
