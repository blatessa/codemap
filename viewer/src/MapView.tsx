// The map: SVG with areas, boxes (modules/blocks) and edges. Pan, zoom, drag.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FAR, FARH, HEAD, PAD, ROW, type Box, type MEdge, type Model, type Row, type Sel } from './model';
import {
  currentProposal,
  dropInto,
  getState,
  movePos,
  moveProposalModule,
  proposeEdge,
  savePositions,
  select,
  setState,
  toggleMulti,
  useModel,
  useSel,
  useStore,
  type RectOf,
} from './store';
import type { Area } from './types';

export interface DBox {
  b: Box;
  x: number;
  y: number;
  w: number;
  h: number;
  fullH: number;
  rows: Row[];
  col: boolean;
}
export interface Disp {
  boxes: DBox[];
  byId: Map<string, DBox>;
  row: Map<string, { d: DBox; idx: number }>;
  edges: MEdge[];
  areas: { a: Area; r: { x: number; y: number; w: number; h: number; empty: boolean } }[];
}

const fullH = (n: number) => HEAD + Math.max(n, 1) * ROW + PAD;

export function areaRect(a: Area, byId: Map<string, DBox>, pos: Record<string, [number, number]>, exclude?: string) {
  const ms = (a.modules ?? []).filter((id) => id !== exclude).map((id) => byId.get(id)).filter((d): d is DBox => !!d);
  if (!ms.length) {
    const p = pos['area:' + a.name];
    return p ? { x: p[0], y: p[1], w: 260, h: 140, empty: true } : null;
  }
  const x0 = Math.min(...ms.map((m) => m.x)) - 20,
    y0 = Math.min(...ms.map((m) => m.y)) - 44;
  const x1 = Math.max(...ms.map((m) => m.x + m.w)) + 20,
    y1 = Math.max(...ms.map((m) => m.y + m.h)) + 20;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, empty: false };
}

function buildDisp(
  m: Model,
  S: Sel | null,
  pos: Record<string, [number, number]>,
  over: Record<string, [number, number]>,
  collapsed: Set<string>,
  focus: boolean,
  far: boolean,
  areas: Area[],
): Disp {
  const boxes: DBox[] = [];
  const byId = new Map<string, DBox>();
  const row = new Map<string, { d: DBox; idx: number }>();
  const focusOn = focus && S;
  const later: Box[] = [];
  for (const b of m.boxes) {
    const rows = focusOn ? b.rows.filter((r) => S.nodes.has(r.id)) : b.rows;
    if (focusOn && !rows.length) continue;
    const p = over[b.id] ?? (b.prop ? b.propPos : undefined) ?? pos[b.id];
    if (!p) {
      if (b.prop || b.ghost) later.push(b);
      continue;
    }
    add(b, rows, p);
  }
  function add(b: Box, rows: Row[], p: [number, number]) {
    const col = far || collapsed.has(b.id);
    const fh = fullH(rows.length);
    const d: DBox = { b, x: p[0], y: p[1], w: b.w, h: far ? FARH : collapsed.has(b.id) ? HEAD : fh, fullH: fh, rows, col };
    boxes.push(d);
    byId.set(b.id, d);
    rows.forEach((r, idx) => row.set(r.id, { d, idx }));
  }
  // proposed and missing boxes without a position: under their area, or under everything
  for (const b of later) {
    const rows = focusOn ? b.rows.filter((r) => S.nodes.has(r.id)) : b.rows;
    const a = b.propArea ? areas.find((x) => x.name === b.propArea) : undefined;
    const mem = a ? (a.modules ?? []).map((id) => byId.get(id)).filter((d): d is DBox => !!d) : [];
    let p: [number, number];
    if (mem.length) {
      const low = mem.reduce((x, y) => (y.y + y.fullH > x.y + x.fullH ? y : x));
      p = [low.x, low.y + low.fullH + 24];
    } else {
      const bottom = boxes.length ? Math.max(...boxes.map((d) => d.y + d.fullH)) : 0;
      const left = boxes.length ? Math.min(...boxes.map((d) => d.x)) : 20;
      p = [left, bottom + 70];
    }
    add(b, rows, p);
  }
  const edges = m.edges.filter((e) => row.has(e.from) && row.has(e.to) && (!focusOn || S.edges.has(e.i)));
  const out: Disp['areas'] = [];
  let bottom = boxes.length ? Math.max(...boxes.map((d) => d.y + d.fullH)) + 60 : 80;
  for (const a of areas) {
    let r = areaRect(a, byId, pos);
    if (focusOn && (!r || r.empty)) continue;
    if (!r && !(a.modules ?? []).some((id) => m.box.has(id))) {
      r = { x: 20, y: bottom, w: 260, h: 140, empty: true };
      bottom += 160;
    }
    if (r) out.push({ a, r });
  }
  return { boxes, byId, row, edges, areas: out };
}

function anchor(disp: Disp, id: string, side: 'l' | 'r', far: boolean): [number, number] {
  const { d, idx } = disp.row.get(id)!;
  const y = d.col ? d.y + (far ? FARH : HEAD) / 2 : d.y + HEAD + idx * ROW + ROW / 2;
  return [side === 'r' ? d.x + d.w + 1 : d.x - 1, y];
}

function edgePath(disp: Disp, e: MEdge, far: boolean): string | null {
  const a = disp.row.get(e.from)!.d,
    b = disp.row.get(e.to)!.d;
  if (a === b) {
    if (a.col) return null;
    const [x1, y1] = anchor(disp, e.from, 'l', far),
      [x2, y2] = anchor(disp, e.to, 'l', far),
      bl = 16 + Math.abs(y2 - y1) * 0.14;
    return `M${x1},${y1} C${x1 - bl},${y1} ${x2 - bl},${y2} ${x2 - 2},${y2}`;
  }
  if (b.x > a.x + a.w / 2) {
    const [x1, y1] = anchor(disp, e.from, 'r', far),
      [x2, y2] = anchor(disp, e.to, 'l', far),
      dx = Math.max(30, (x2 - x1) * 0.5);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }
  if (b.x + b.w < a.x) {
    const [x1, y1] = anchor(disp, e.from, 'l', far),
      [x2, y2] = anchor(disp, e.to, 'r', far),
      dx = Math.max(30, (x1 - x2) * 0.5);
    return `M${x1},${y1} C${x1 - dx},${y1} ${x2 + dx},${y2} ${x2},${y2}`;
  }
  const [x1, y1] = anchor(disp, e.from, 'r', far),
    [x2, y2] = anchor(disp, e.to, 'r', far);
  return `M${x1},${y1} C${x1 + 40},${y1} ${x2 + 40},${y2} ${x2 + 2},${y2}`;
}

const Edges = memo(function Edges({ disp, S, far }: { disp: Disp; S: Sel | null; far: boolean }) {
  const base: React.ReactNode[] = [],
    top: React.ReactNode[] = [];
  const agg = new Map<string, { e: MEdge; n: number; on: boolean; prop: boolean; net: boolean }>();
  for (const e of disp.edges) {
    const a = disp.row.get(e.from)!.d,
      b = disp.row.get(e.to)!.d,
      on = !!S && S.edges.has(e.i);
    if (a !== b && a.col && b.col) {
      const key = a.b.id + '>' + b.b.id;
      const g = agg.get(key) ?? { e, n: 0, on: false, prop: true, net: e.net };
      g.n++;
      g.on ||= on;
      g.prop &&= e.prop;
      agg.set(key, g);
      continue;
    }
    const d = edgePath(disp, e, far);
    if (!d) continue;
    const ghost = disp.row.get(e.from)!.d.b.ghost || disp.row.get(e.to)!.d.b.ghost;
    const cls = ['edge', e.net && 'net', e.declared && 'decl', e.prop && 'prop', ghost && 'ghost', S ? (on ? 'on' : 'dim') : ''].filter(Boolean).join(' ');
    const p = (
      <path
        key={e.i}
        className={cls}
        d={d}
        data-edge={e.i}
        markerEnd={`url(#${e.prop ? 'mk-p' : on ? 'mk-h' : 'mk-n'})`}
      />
    );
    (on || e.prop ? top : base).push(p);
  }
  for (const [key, g] of agg) {
    const w = (g.on ? 2 : 1.2) + Math.log2(g.n) * 1.4;
    const cls = ['edge', g.net && 'net', g.prop && 'prop', S ? (g.on ? 'on' : 'dim') : ''].filter(Boolean).join(' ');
    const p = (
      <path
        key={key}
        className={cls}
        d={edgePath(disp, g.e, far) ?? ''}
        style={{ strokeWidth: w + 'px' }}
        data-agg={g.n}
        markerEnd={`url(#${g.prop ? 'mk-p' : g.on ? 'mk-h' : 'mk-n'})`}
      >
        <title>{`${g.n} call${g.n === 1 ? '' : 's'}`}</title>
      </path>
    );
    (g.on || g.prop ? top : base).push(p);
  }
  return (
    <g>
      {base}
      {top}
    </g>
  );
});

const AreaG = memo(function AreaG({ a, r, sel, far }: { a: Area; r: Disp['areas'][0]['r']; sel: boolean; far: boolean }) {
  return (
    <g className={`area ${sel ? 'asel' : ''} ${r.empty ? 'empty' : ''}`} data-area-box={a.name}>
      <rect className="arect" x={r.x} y={r.y} width={r.w} height={r.h} rx={14} />
      <g className="ahead" data-area={a.name}>
        <rect className="hit" x={r.x} y={r.y} width={r.w} height={far ? 42 : 34} rx={14} />
        <text className="alabel" x={r.x + 16} y={r.y + (far ? 31 : 23)} style={far ? { fontSize: 21 } : undefined}>
          {a.name}
        </text>
      </g>
    </g>
  );
});

interface BoxProps {
  d: DBox;
  far: boolean;
  S: Sel | null;
  selKey: string; // selection ids touching this box, joined
  hover: string | null;
  connectFrom: string | null;
  canAdd: boolean;
}

const BoxG = memo(function BoxG({ d, far, S, selKey, hover, connectFrom, canAdd }: BoxProps) {
  const { b, x, y, w, h } = d;
  const touched = S && d.rows.some((r) => S.nodes.has(r.id));
  const sels = selKey ? selKey.split('\0') : [];
  const cls = ['mod', b.external && 'ext', b.prop && 'prop', b.ghost && 'ghost', sels.includes(b.id) && 'msel', S ? (touched ? 'touched' : 'dim') : '']
    .filter(Boolean)
    .join(' ');
  return (
    <g className={cls} data-box={b.id}>
      <rect className="box" x={x} y={y} width={w} height={h} rx={8} />
      <g className="mhead" data-mod={b.id}>
        <rect className="hit" x={x} y={y} width={w} height={far ? h : HEAD} rx={8} />
        <text className="mname" x={x + (far ? 16 : 24)} y={y + (far ? 29 : 16)} style={far ? { fontSize: 17 } : undefined}>
          {b.label}
        </text>
        <text className="msub" x={x + (far ? 16 : 24)} y={y + (far ? 50 : 29)} style={far ? { fontSize: 13 } : undefined}>
          {b.sub}
        </text>
      </g>
      {!far && (
        <g className="tgl" data-toggle={b.id}>
          <rect className="hit" x={x + 3} y={y + 4} width={19} height={19} rx={4} />
          <text className="caret" x={x + 9} y={y + 16}>
            {d.col ? '▸' : '▾'}
          </text>
        </g>
      )}
      {canAdd && !far && !b.ghost && (
        <g className="add" data-add={b.id}>
          <rect x={x + w - 30} y={y + 8} width={20} height={20} rx={5} />
          <text x={x + w - 20} y={y + 23} textAnchor="middle">
            +
          </text>
        </g>
      )}
      {!d.col && (
        <>
          <line className="sep" x1={x} x2={x + w} y1={y + HEAD} y2={y + HEAD} />
          {d.rows.map((r, i) => {
            const ry = y + HEAD + i * ROW,
              cy = ry + ROW / 2 + 4;
            const c = ['fn', S ? (S.nodes.has(r.id) ? 'on' : 'dim') : '', r.prop && 'prop', r.ghost && 'ghost', sels.includes(r.id) && 'sel', connectFrom === r.id && 'from', hover === r.id && 'hov']
              .filter(Boolean)
              .join(' ');
            return (
              <g key={r.id} className={c} data-node={r.id}>
                <rect className="hit" x={x + 4} y={ry + 2} width={w - 8} height={ROW - 4} rx={5} />
                <circle className="dot" cx={x + 12} cy={ry + ROW / 2} r={3} />
                {r.prefix && (
                  <text className="fm" x={x + 22} y={cy}>
                    {r.prefix}
                  </text>
                )}
                <text className="lbl" x={x + (r.prefix ? 60 : 22)} y={cy}>
                  {r.label}
                </text>
                {r.tag && (
                  <text className={`tag ${r.tagClass}`} x={x + w - 12} y={cy} textAnchor="end">
                    {r.tag}
                  </text>
                )}
              </g>
            );
          })}
        </>
      )}
    </g>
  );
});

const mk = (id: string) => (
  <marker key={id} id={id} viewBox="0 0 8 8" refX={7.5} refY={4} markerUnits="userSpaceOnUse" markerWidth={9} markerHeight={9} orient="auto">
    <path className={id} d="M0,0.5 L8,4 L0,7.5z" />
  </marker>
);

type Drag =
  | { kind: 'pan'; x: number; y: number; vx: number; vy: number; moved: boolean }
  | { kind: 'box'; id: string; prop: boolean; x: number; y: number; bx: number; by: number; moved: boolean }
  | { kind: 'area'; name: string; x: number; y: number; start: { id: string; x: number; y: number }[]; ax: number; ay: number; moved: boolean };

export function MapView({ drawerOpen }: { drawerOpen: boolean }) {
  const m = useModel();
  const S = useSel();
  const pos = useStore((s) => s.pos);
  const collapsed = useStore((s) => s.collapsed);
  const focus = useStore((s) => s.focus);
  const areas = useStore((s) => s.areas);
  const view = useStore((s) => s.view);
  const sel = useStore((s) => s.sel);
  const hover = useStore((s) => s.hover);
  const connectFrom = useStore((s) => s.connectFrom);
  const canAdd = useStore((s) => s.mode === 'propose' && !!currentProposal(s));
  const fitSeq = useStore((s) => s.fitSeq);
  const centerOnId = useStore((s) => s.centerOn);
  const far = view.k < FAR;
  const [over, setOverState] = useState<Record<string, [number, number]>>({});
  const overRef = useRef(over);
  const setOver = (o: Record<string, [number, number]>) => {
    overRef.current = o;
    setOverState(o);
  };
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);

  const disp = useMemo(() => buildDisp(m, S, pos, over, collapsed, focus, far, areas), [m, S, pos, over, collapsed, focus, far, areas]);
  const dispRef = useRef(disp);
  dispRef.current = disp;


  // ---- view: fit, center, zoom ----
  const size = () => {
    const r = svgRef.current!.getBoundingClientRect();
    const dw = document.getElementById("drawer");
    const W = r.width - (drawerOpen && r.width > 900 ? dw?.offsetWidth || 436 : 0);
    return { r, W };
  };
  const fit = useCallback(() => {
    const d = dispRef.current;
    if (!svgRef.current || !d.boxes.length) return;
    const { r, W } = size();
    let x0 = 1e9,
      y0 = 1e9,
      x1 = -1e9,
      y1 = -1e9;
    for (const b of d.boxes) {
      x0 = Math.min(x0, b.x - 50);
      y0 = Math.min(y0, b.y - 44);
      x1 = Math.max(x1, b.x + b.w + 20);
      y1 = Math.max(y1, b.y + b.fullH + 20);
    }
    for (const { r: ar } of d.areas) {
      x0 = Math.min(x0, ar.x);
      y0 = Math.min(y0, ar.y);
      x1 = Math.max(x1, ar.x + ar.w);
      y1 = Math.max(y1, ar.y + ar.h);
    }
    const pad = W < 600 ? 12 : 28,
      top = 58;
    const k = Math.max(0.05, Math.min((W - pad * 2) / (x1 - x0), (r.height - top - pad) / (y1 - y0), 1.4));
    setState({ view: { k, x: (W - (x1 - x0) * k) / 2 - x0 * k, y: top - y0 * k } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen]);

  useLayoutEffect(() => {
    if (fitSeq) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSeq]);
  const fitPending = useRef(false);
  useEffect(() => {
    // the first layout can land after the fit request
    if (!fitPending.current && disp.boxes.length && fitSeq) {
      fitPending.current = true;
      fit();
    }
  }, [disp.boxes.length, fitSeq, fit]);
  useEffect(() => {
    if (fitSeq) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  useEffect(() => {
    if (!centerOnId || !svgRef.current) return;
    const at = dispRef.current.row.get(centerOnId);
    const bd = at?.d ?? dispRef.current.byId.get(centerOnId);
    if (bd) {
      const { r, W } = size();
      const k = Math.max(getState().view.k, 0.9);
      const cy = at ? bd.y + HEAD + at.idx * ROW + ROW / 2 : bd.y + 18;
      setState({ view: { k, x: W / 2 - (bd.x + bd.w / 2) * k, y: r.height / 2 - cy * k }, touchedView: true });
    }
    setState({ centerOn: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerOnId, disp]);

  useEffect(() => {
    const onResize = () => !getState().touchedView && fit();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fit]);

  useEffect(() => {
    const el = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- dragging ----
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const g = drag.current;
      if (!g) return;
      const dx = e.clientX - g.x,
        dy = e.clientY - g.y;
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      if (!g.moved) setDragging(true);
      g.moved = true;
      const k = getState().view.k;
      if (g.kind === 'pan') setState({ view: { ...getState().view, x: g.vx + dx, y: g.vy + dy }, touchedView: true });
      else if (g.kind === 'box') setOver({ [g.id]: [Math.round(g.bx + dx / k), Math.round(g.by + dy / k)] });
      else {
        const o: Record<string, [number, number]> = {};
        for (const s of g.start) o[s.id] = [Math.round(s.x + dx / k), Math.round(s.y + dy / k)];
        if (!g.start.length) o['area:' + g.name] = [Math.round(g.ax + dx / k), Math.round(g.ay + dy / k)];
        if (g.start.length) setOver(o);
        else movePos(o);
      }
    };
    const up = () => {
      const g = drag.current;
      setDragging(false);
      if (g && g.moved && g.kind !== 'pan') {
        commitDrag(g, overRef.current);
        setOver({});
      }
      setTimeout(() => (drag.current = null), 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commitDrag(g: Drag, o: Record<string, [number, number]>) {
    if (g.kind === 'box') {
      const p = o[g.id];
      if (!p) return;
      if (g.prop) {
        moveProposalModule(g.id, p);
        return;
      }
      movePos({ [g.id]: p });
      // which area is the box's header over now?
      const d = dispRef.current.byId.get(g.id);
      const cx = p[0] + (d?.w ?? 200) / 2,
        cy = p[1] + 18;
      const s = getState();
      const target = s.areas.find((a) => {
        const r = areaRect(a, dispRef.current.byId, s.pos, g.id);
        return r && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
      });
      dropInto(g.id, target?.name ?? null, (a) => areaRect(a, dispRef.current.byId, getState().pos, g.id));
      savePositions();
    } else if (g.kind === 'area') {
      const real: Record<string, [number, number]> = {};
      for (const [id, p] of Object.entries(o)) {
        const b = dispRef.current.byId.get(id)?.b;
        if (b?.prop) moveProposalModule(id, p);
        else if (b && !b.ghost) real[id] = p;
      }
      movePos(real);
      savePositions();
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    const ah = t.closest('[data-area]') as HTMLElement | null;
    const s = getState();
    if (ah) {
      const name = ah.dataset.area!;
      const a = s.areas.find((x) => x.name === name);
      const r = a && areaRect(a, disp.byId, s.pos);
      if (a && r) {
        const start = (a.modules ?? []).map((id) => disp.byId.get(id)).filter((d): d is DBox => !!d).map((d) => ({ id: d.b.id, x: d.x, y: d.y }));
        drag.current = { kind: 'area', name, x: e.clientX, y: e.clientY, start, ax: r.x, ay: r.y, moved: false };
        return;
      }
    }
    const mh = t.closest('[data-mod]') as HTMLElement | null;
    if (mh && !t.closest('[data-add]') && !t.closest('[data-toggle]')) {
      const d = disp.byId.get(mh.dataset.mod!);
      if (d && !d.b.ghost) {
        drag.current = { kind: 'box', id: d.b.id, prop: d.b.prop, x: e.clientX, y: e.clientY, bx: d.x, by: d.y, moved: false };
        return;
      }
    }
    drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, vx: s.view.x, vy: s.view.y, moved: false };
  };

  const onClick = (e: React.MouseEvent) => {
    if (drag.current?.moved) return;
    const t = e.target as Element;
    const s = getState();
    const add = t.closest('[data-add]') as HTMLElement | null;
    if (add) {
      setState({ form: { type: 'fn', box: add.dataset.add! }, sel: [], connectFrom: null });
      return;
    }
    const tg = t.closest('[data-toggle]') as HTMLElement | null;
    if (tg) {
      const id = tg.dataset.toggle!;
      const c = new Set(s.collapsed);
      if (c.has(id)) c.delete(id);
      else c.add(id);
      setState({ collapsed: c });
      return;
    }
    const pick = (id: string) => (e.shiftKey ? toggleMulti(id) : select(id));
    const n = t.closest('[data-node]') as HTMLElement | null;
    if (s.connectFrom) {
      const from = s.connectFrom,
        to = n?.dataset.node;
      if (to && to !== from) proposeEdge(from, to);
      setState({ connectFrom: null });
      select(from);
      return;
    }
    const ar = t.closest('[data-area]') as HTMLElement | null;
    if (ar) return pick('area:' + ar.dataset.area);
    const mh = t.closest('[data-mod]') as HTMLElement | null;
    if (mh) return pick(mh.dataset.mod!);
    if (n) return pick(n.dataset.node!);
    setState({ sel: [], form: null, focus: false, splitting: null });
  };

  const selKeyOf = (d: DBox) => {
    if (!sel.length) return '';
    return sel.filter((id) => id === d.b.id || d.rows.some((r) => r.id === id)).join('\0');
  };

  return (
    <svg
      id="map"
      ref={svgRef}
      className={`${dragging ? 'dragging' : ''} ${connectFrom ? 'connecting' : ''}`}
      aria-label="Architecture map"
      onPointerDown={onPointerDown}
      onClick={onClick}
      data-zoom={view.k.toFixed(3)}
      data-far={far ? '1' : '0'}
    >
      <defs>{['mk-n', 'mk-h', 'mk-p'].map(mk)}</defs>
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
        {disp.areas.map(({ a, r }) => (
          <AreaG key={a.name} a={a} r={r} sel={sel.includes('area:' + a.name)} far={far} />
        ))}
        <Edges disp={disp} S={S} far={far} />
        {disp.boxes.map((d) => (
          <BoxG
            key={d.b.id}
            d={d}
            far={far}
            S={S}
            selKey={selKeyOf(d)}
            hover={hover && d.rows.some((r) => r.id === hover) ? hover : null}
            connectFrom={connectFrom && d.rows.some((r) => r.id === connectFrom) ? connectFrom : null}
            canAdd={canAdd}
          />
        ))}
      </g>
    </svg>
  );
}

export function zoomAt(cx: number, cy: number, f: number) {
  const v = getState().view;
  const k = Math.min(3, Math.max(0.05, v.k * f));
  setState({ view: { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) }, touchedView: true });
}

export function zoomCenter(f: number) {
  const el = document.getElementById('map');
  if (!el) return;
  const r = el.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, f);
}

// mapRectOf gives drawer actions the same area rectangles the map draws.
export function useAreaRect(): RectOf {
  const m = useModel();
  const pos = useStore((s) => s.pos);
  return useCallback(
    (a: Area) => {
      const byId = new Map<string, DBox>();
      for (const b of m.boxes) {
        const p = pos[b.id];
        if (p) byId.set(b.id, { b, x: p[0], y: p[1], w: b.w, h: fullH(b.rows.length), fullH: fullH(b.rows.length), rows: b.rows, col: false });
      }
      return areaRect(a, byId, pos);
    },
    [m, pos],
  );
}
