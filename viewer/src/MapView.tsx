// The map: SVG with areas, boxes (modules/blocks) and edges. Pan, zoom, drag.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FAR, FARH, HEAD, MORE, ROW, heightOf, type Box, type MEdge, type Model, type Row, type Sel } from './model';
import {
  currentProposal,
  dropBox,
  getState,
  movePos,
  moveProposalModule,
  proposeEdge,
  savePositions,
  select,
  setState,
  toggleExpanded,
  toggleMulti,
  useModel,
  useSel,
  useStore,
  type RectOf,
} from './store';
import type { Area } from './types';

// Far-mode text: scaled by 1/k so it stays readable on screen, and cut to fit.
interface FarText {
  name: string;
  sub: string; // '' when it doesn't fit
  fn: number; // font sizes
  fs: number;
  px: number;
  nb: number; // baselines, relative to the box top
  sb: number;
}

export interface DBox {
  b: Box;
  x: number;
  y: number;
  w: number;
  h: number;
  fullH: number; // height with the rows it shows (not collapsed, not far)
  rows: Row[];
  col: boolean;
  more: number; // internal rows: hidden behind "+N internal", or shown (open)
  open: boolean;
  lift: boolean; // drawn above the others: taller than its laid-out height, or dragged
  sub: string;
  far?: FarText;
}
export interface ARect {
  x: number;
  y: number;
  w: number;
  h: number;
  empty: boolean;
}
export interface Disp {
  boxes: DBox[];
  byId: Map<string, DBox>;
  row: Map<string, { d: DBox; idx: number }>;
  edges: MEdge[];
  areas: { a: Area; r: ARect }[];
}

// approximate glyph widths, in em
const MONO = 0.6,
  SANS = 0.56;

// fitText cuts text to `w`. Paths drop leading segments first ("…/extract/goext").
function fitText(t: string, w: number, size: number, ch: number, path: boolean): string {
  const n = Math.floor(w / (size * ch));
  if (t.length <= n) return t;
  if (path) {
    const seg = t.split('/');
    for (let i = 1; i < seg.length; i++) {
      const s = '…/' + seg.slice(i).join('/');
      if (s.length <= n) return s;
    }
    t = seg[seg.length - 1];
    if (t.length <= n * 1.4) return t; // a short name may run a little past the box
  }
  return n > 2 ? t.slice(0, n - 1) + '…' : path ? t : '';
}

// Far mode: labels keep about 12.5px on screen, area labels about 13.5px.
// k is snapped to steps so zooming doesn't redraw every box on every tick.
const snapK = (k: number) => Math.pow(2, Math.round(Math.log2(k) * 6) / 6);
export const farFont = (k: number) => Math.max(17, 12.5 / snapK(k));
const farSub = (k: number) => Math.max(13, 10.5 / snapK(k));
export const farArea = (k: number) => Math.max(21, 13.5 / snapK(k));
// farHeight is a far-mode box's tallest: name and sub line, within what it was laid out for
export function farHeight(fh: number, k: number) {
  const fn = farFont(k),
    fs = farSub(k);
  return Math.max(FARH, Math.min(Math.max(FARH, fh + 20), fs + fn * 1.2 + fs * 1.25));
}
const areaTop = (fa: number | null) => (fa ? Math.max(44, fa * 1.6 + 8) : 44);

export function areaRect(a: Area, byId: Map<string, DBox>, pos: Record<string, [number, number]>, top = 44): ARect | null {
  const ms = (a.modules ?? []).map((id) => byId.get(id)).filter((d): d is DBox => !!d);
  if (!ms.length) {
    const p = pos['area:' + a.name];
    return p ? { x: p[0], y: p[1], w: 260, h: 140, empty: true } : null;
  }
  const x0 = Math.min(...ms.map((m) => m.x)) - 20,
    y0 = Math.min(...ms.map((m) => m.y)) - top;
  const x1 = Math.max(...ms.map((m) => m.x + m.w)) + 20,
    y1 = Math.max(...ms.map((m) => m.y + m.h)) + 20;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, empty: false };
}

// The box being dragged: its areas keep the rectangles they had when the drag
// started, so the box can visibly leave them; it can't stretch any area.
interface DragBox {
  id: string;
  frozen: Map<string, ARect>;
}

function buildDisp(
  m: Model,
  S: Sel | null,
  pos: Record<string, [number, number]>,
  over: Record<string, [number, number]>,
  collapsed: Set<string>,
  expanded: Set<string>,
  focus: boolean,
  k: number | null, // set in far mode
  areas: Area[],
  dragBox: DragBox | null,
): Disp {
  const boxes: DBox[] = [];
  const byId = new Map<string, DBox>();
  const row = new Map<string, { d: DBox; idx: number }>();
  const focusOn = focus && S;
  const later: Box[] = [];
  const fn = k ? farFont(k) : 0,
    fs = k ? farSub(k) : 0;
  const visible = (b: Box): { rows: Row[]; more: number; open: boolean } => {
    if (focusOn) return { rows: b.rows.filter((r) => S.nodes.has(r.id)), more: 0, open: false };
    const more = b.rows.length - b.pub;
    if (!more) return { rows: b.rows, more: 0, open: false };
    if (expanded.has(b.id)) return { rows: b.rows, more, open: true };
    const rows = b.rows.filter((r) => r.pub || S?.path.has(r.id));
    return { rows, more: b.rows.length - rows.length, open: false };
  };
  for (const b of m.boxes) {
    const p = over[b.id] ?? (b.prop ? b.propPos : undefined) ?? pos[b.id];
    if (!p) {
      if (b.prop || b.ghost) later.push(b);
      continue;
    }
    add(b, p);
  }
  function add(b: Box, p: [number, number]) {
    const v = visible(b);
    if (focusOn && !v.rows.length) return;
    const fh = heightOf(v.rows.length, v.more > 0);
    const sub = b.shared && !S ? `used by ${b.usedBy} module${b.usedBy === 1 ? '' : 's'}` : b.sub;
    let h = collapsed.has(b.id) ? HEAD : fh;
    let far: FarText | undefined;
    if (k) {
      const px = Math.max(16, fs * 0.5),
        py = fs * 0.5,
        tw = b.w - px * 1.5;
      // the sub line shows only whole, and only when the box has room for it
      const fits = (t: string) => t.length * fs * SANS <= tw;
      const short = b.shared && !S ? `used by ${b.usedBy}` : '';
      const subT = fits(sub) ? sub : fits(short) ? short : '';
      const withSub = py * 2 + fn * 1.2 + fs * 1.25;
      const cap = Math.max(FARH, fh + 20);
      const room = !!subT && withSub <= cap;
      h = room ? Math.max(FARH, withSub) : Math.max(FARH, Math.min(cap, py * 2 + fn * 1.2));
      far = {
        name: fitText(b.label, tw, fn, MONO, true),
        sub: room ? subT : '',
        fn,
        fs,
        px,
        nb: (room ? py : (h - fn * 1.2) / 2) + fn * 0.95,
        sb: py + fn * 1.2 + fs,
      };
    }
    const d: DBox = {
      b,
      x: p[0],
      y: p[1],
      w: b.w,
      h,
      fullH: fh,
      rows: v.rows,
      col: !!k || collapsed.has(b.id),
      more: v.more,
      open: v.open,
      lift: dragBox?.id === b.id || (!k && h > b.defH),
      sub,
      far,
    };
    boxes.push(d);
    byId.set(b.id, d);
    if (!d.col) v.rows.forEach((r, idx) => row.set(r.id, { d, idx }));
    else v.rows.forEach((r) => row.set(r.id, { d, idx: -1 }));
  }
  // proposed and missing boxes without a position: under their area, or under everything
  for (const b of later) {
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
    add(b, p);
  }
  // edges into shared modules only draw when the selection uses them
  const edges = m.edges.filter((e) => {
    const a = row.get(e.from),
      b = row.get(e.to);
    if (!a || !b) return false;
    if (focusOn) return S.edges.has(e.i);
    if (b.d.b.shared && a.d !== b.d && !e.prop) return !!S && S.edges.has(e.i);
    return true;
  });
  const out: Disp['areas'] = [];
  let bottom = boxes.length ? Math.max(...boxes.map((d) => d.y + d.fullH)) + 60 : 80;
  const top = areaTop(k ? farArea(k) : null);
  for (const a of areas) {
    let r = dragBox?.frozen.get(a.name) ?? areaRect(a, byId, pos, top);
    if (focusOn && (!r || r.empty)) continue;
    if (!r && !(a.modules ?? []).some((id) => m.box.has(id))) {
      r = { x: 20, y: bottom, w: 260, h: 140, empty: true };
      bottom += 160;
    }
    if (r) out.push({ a, r });
  }
  // expanded and dragged boxes draw above their neighbours
  boxes.sort((x, y) => Number(x.lift) - Number(y.lift));
  return { boxes, byId, row, edges, areas: out };
}

// dropTarget is the smallest area rectangle containing the point.
function dropTarget(disp: Disp, x: number, y: number): string | null {
  let best: { name: string; s: number } | null = null;
  for (const { a, r } of disp.areas) {
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
    const s = r.w * r.h;
    if (!best || s < best.s) best = { name: a.name, s };
  }
  return best?.name ?? null;
}

function anchor(disp: Disp, id: string, side: 'l' | 'r'): [number, number] {
  const { d, idx } = disp.row.get(id)!;
  const y = d.col || idx < 0 ? d.y + (d.col ? d.h : HEAD) / 2 : d.y + HEAD + idx * ROW + ROW / 2;
  return [side === 'r' ? d.x + d.w + 1 : d.x - 1, y];
}

function edgePath(disp: Disp, e: MEdge): string | null {
  const a = disp.row.get(e.from)!.d,
    b = disp.row.get(e.to)!.d;
  if (a === b) {
    if (a.col) return null;
    const [x1, y1] = anchor(disp, e.from, 'l'),
      [x2, y2] = anchor(disp, e.to, 'l'),
      bl = 16 + Math.abs(y2 - y1) * 0.14;
    return `M${x1},${y1} C${x1 - bl},${y1} ${x2 - bl},${y2} ${x2 - 2},${y2}`;
  }
  if (b.x > a.x + a.w / 2) {
    const [x1, y1] = anchor(disp, e.from, 'r'),
      [x2, y2] = anchor(disp, e.to, 'l'),
      dx = Math.max(30, (x2 - x1) * 0.5);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }
  if (b.x + b.w < a.x) {
    const [x1, y1] = anchor(disp, e.from, 'l'),
      [x2, y2] = anchor(disp, e.to, 'r'),
      dx = Math.max(30, (x1 - x2) * 0.5);
    return `M${x1},${y1} C${x1 - dx},${y1} ${x2 + dx},${y2} ${x2},${y2}`;
  }
  const [x1, y1] = anchor(disp, e.from, 'r'),
    [x2, y2] = anchor(disp, e.to, 'r');
  return `M${x1},${y1} C${x1 + 40},${y1} ${x2 + 40},${y2} ${x2 + 2},${y2}`;
}

const Edges = memo(function Edges({ disp, S, shown }: { disp: Disp; S: Sel | null; shown: Set<string> | null }) {
  const base: React.ReactNode[] = [],
    top: React.ReactNode[] = [];
  const agg = new Map<string, { e: MEdge; n: number; on: boolean; prop: boolean; net: boolean }>();
  for (const e of disp.edges) {
    const a = disp.row.get(e.from)!.d,
      b = disp.row.get(e.to)!.d,
      on = !!S && S.edges.has(e.i);
    if (shown && !shown.has(a.b.id) && !shown.has(b.b.id)) continue;
    if (a !== b && a.col && b.col) {
      const key = a.b.id + '>' + b.b.id;
      const g = agg.get(key) ?? { e, n: 0, on: false, prop: true, net: e.net };
      g.n++;
      g.on ||= on;
      g.prop &&= e.prop;
      agg.set(key, g);
      continue;
    }
    const d = edgePath(disp, e);
    if (!d) continue;
    const ghost = a.b.ghost || b.b.ghost;
    const cls = ['edge', e.net && 'net', e.declared && 'decl', e.prop && 'prop', ghost && 'ghost', S ? (on ? 'on' : 'dim') : ''].filter(Boolean).join(' ');
    const p = <path key={e.i} className={cls} d={d} data-edge={e.i} markerEnd={`url(#${e.prop ? 'mk-p' : on ? 'mk-h' : 'mk-n'})`} />;
    (on || e.prop ? top : base).push(p);
  }
  for (const [key, g] of agg) {
    const w = (g.on ? 2 : 1.2) + Math.log2(g.n) * 1.4;
    const cls = ['edge', g.net && 'net', g.prop && 'prop', S ? (g.on ? 'on' : 'dim') : ''].filter(Boolean).join(' ');
    const p = (
      <path
        key={key}
        className={cls}
        d={edgePath(disp, g.e) ?? ''}
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

const AreaG = memo(function AreaG({ a, r, sel, drop, fa }: { a: Area; r: ARect; sel: boolean; drop: boolean; fa: number | null }) {
  const hh = fa ? fa * 1.6 : 34;
  return (
    <g className={`area${sel ? ' asel' : ''}${r.empty ? ' empty' : ''}${drop ? ' drop' : ''}`} data-area-box={a.name}>
      <rect className="arect" x={r.x} y={r.y} width={r.w} height={r.h} rx={14} />
      <g className="ahead" data-area={a.name}>
        <rect className="hit" x={r.x} y={r.y} width={r.w} height={hh} rx={14} />
        <text className="alabel" x={r.x + (fa ? fa * 0.7 : 16)} y={r.y + (fa ? fa * 1.15 : 23)} style={fa ? { fontSize: fa } : undefined}>
          {fa ? fitText(a.name, r.w - fa * 1.4, fa, SANS, false) || a.name : a.name}
        </text>
      </g>
    </g>
  );
});

interface BoxProps {
  d: DBox;
  S: Sel | null;
  selKey: string; // selection ids touching this box, joined
  hover: string | null;
  connectFrom: string | null;
  canAdd: boolean;
}

const BoxG = memo(function BoxG({ d, S, selKey, hover, connectFrom, canAdd }: BoxProps) {
  const { b, x, y, w, h, far } = d;
  const touched = S && b.rows.some((r) => S.nodes.has(r.id));
  const sels = selKey ? selKey.split('\0') : [];
  const cls = ['mod', b.external && 'ext', b.prop && 'prop', b.ghost && 'ghost', b.shared && 'shared', sels.includes(b.id) && 'msel', S ? (touched ? 'touched' : 'dim') : '']
    .filter(Boolean)
    .join(' ');
  const moreY = y + HEAD + d.rows.length * ROW;
  return (
    <g className={cls} data-box={b.id}>
      <rect className="box" x={x} y={y} width={w} height={h} rx={8} />
      <g className="mhead" data-mod={b.id}>
        <rect className="hit" x={x} y={y} width={w} height={far ? h : HEAD} rx={8} />
        {far ? (
          <>
            <text className="mname" x={x + far.px} y={y + far.nb} style={{ fontSize: far.fn }}>
              {far.name}
            </text>
            {far.sub && (
              <text className="msub" x={x + far.px} y={y + far.sb} style={{ fontSize: far.fs }}>
                {far.sub}
              </text>
            )}
          </>
        ) : (
          <>
            <text className="mname" x={x + 24} y={y + 16}>
              {b.label}
            </text>
            <text className="msub" x={x + 24} y={y + 29}>
              {d.sub}
            </text>
          </>
        )}
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
          {d.more > 0 && (
            <g className="more" data-more={b.id}>
              <rect className="hit" x={x + 4} y={moreY + 1} width={w - 8} height={MORE - 2} rx={5} />
              <text x={x + 22} y={moreY + MORE / 2 + 4}>
                {d.open ? `− ${d.more} internal` : `+${d.more} internal`}
              </text>
            </g>
          )}
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
  | { kind: 'box'; id: string; prop: boolean; x: number; y: number; bx: number; by: number; moved: boolean; px: number; py: number }
  | { kind: 'area'; name: string; x: number; y: number; start: { id: string; x: number; y: number }[]; ax: number; ay: number; moved: boolean };

export function MapView({ drawerOpen }: { drawerOpen: boolean }) {
  const m = useModel();
  const S = useSel();
  const pos = useStore((s) => s.pos);
  const collapsed = useStore((s) => s.collapsed);
  const expanded = useStore((s) => s.expanded);
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
  // far mode sizes text by zoom; snapped so only real zoom steps redraw
  const farK = far ? snapK(view.k) : null;
  const [over, setOverState] = useState<Record<string, [number, number]>>({});
  const overRef = useRef(over);
  const setDragBox = (d: DragBox | null) => setDragBoxState(d);
  const setOver = (o: Record<string, [number, number]>) => {
    overRef.current = o;
    setOverState(o);
  };
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragBox, setDragBoxState] = useState<DragBox | null>(null);
  const [drop, setDropState] = useState<string | null>(null);
  const dropRef = useRef<string | null>(null);
  const setDrop = (t: string | null) => {
    dropRef.current = t;
    setDropState(t);
  };

  const disp = useMemo(
    () => buildDisp(m, S, pos, over, collapsed, expanded, focus, farK, areas, dragBox),
    [m, S, pos, over, collapsed, expanded, focus, farK, areas, dragBox],
  );

  // Big maps only draw what's near the viewport. The culling window moves in
  // whole-screen steps, so panning re-renders rarely.
  const [vsize, setVsize] = useState({ w: 1500, h: 900 });
  useEffect(() => {
    const el = svgRef.current!;
    const ro = new ResizeObserver(() => setVsize({ w: el.clientWidth || 1500, h: el.clientHeight || 900 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const big = disp.row.size > 800;
  const cw = vsize.w / view.k,
    ch = vsize.h / view.k;
  const tx = big ? Math.floor(-view.x / view.k / cw) : 0,
    ty = big ? Math.floor(-view.y / view.k / ch) : 0;
  const shown = useMemo(() => {
    if (!big) return null;
    const x0 = (tx - 1) * cw,
      y0 = (ty - 1) * ch,
      x1 = (tx + 3) * cw,
      y1 = (ty + 3) * ch;
    return new Set(disp.boxes.filter((d) => d.x < x1 && d.x + d.w > x0 && d.y < y1 && d.y + d.h > y0).map((d) => d.b.id));
  }, [big, disp, tx, ty, cw, ch]);
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
    const pad = W < 600 ? 12 : 28,
      top = 58;
    // fits the map with each box `hOf` tall; areas end below their lowest member
    const fitWith = (hOf: (b: DBox) => number, maxK = 1.4) => {
      let x0 = 1e9,
        y0 = 1e9,
        x1 = -1e9,
        y1 = -1e9;
      for (const b of d.boxes) {
        x0 = Math.min(x0, b.x - 50);
        y0 = Math.min(y0, b.y - 44);
        x1 = Math.max(x1, b.x + b.w + 20);
        y1 = Math.max(y1, b.y + hOf(b) + 20);
      }
      for (const { a, r: ar } of d.areas) {
        const ms = (a.modules ?? []).map((id) => d.byId.get(id)).filter((x): x is DBox => !!x);
        x0 = Math.min(x0, ar.x);
        y0 = Math.min(y0, ar.y);
        x1 = Math.max(x1, ar.x + ar.w);
        y1 = Math.max(y1, ms.length ? Math.max(...ms.map((m) => m.y + hOf(m) + 20)) : ar.y + ar.h);
      }
      const k = Math.max(0.02, Math.min((W - pad * 2) / (x1 - x0), (r.height - top - pad) / (y1 - y0), maxK));
      return { k, x: (W - (x1 - x0) * k) / 2 - x0 * k, y: top - y0 * k };
    };
    let v = fitWith((b) => b.fullH);
    // zoomed out, boxes are drawn short: fit what's drawn, staying zoomed out
    if (v.k < FAR) {
      const k = v.k;
      const far = fitWith((b) => farHeight(b.fullH, k), FAR * 0.99);
      if (far.k > k) v = far;
    }
    setState({ view: v });
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
      if (!g.moved) {
        setDragging(true);
        if (g.kind === 'box' && !g.prop) {
          const frozen = new Map<string, ARect>();
          for (const { a, r } of dispRef.current.areas) if ((a.modules ?? []).includes(g.id)) frozen.set(a.name, r);
          setDragBox({ id: g.id, frozen });
        }
      }
      g.moved = true;
      const v = getState().view,
        k = v.k;
      if (g.kind === 'pan') setState({ view: { ...v, x: g.vx + dx, y: g.vy + dy }, touchedView: true });
      else if (g.kind === 'box') {
        setOver({ [g.id]: [Math.round(g.bx + dx / k), Math.round(g.by + dy / k)] });
        const r = svgRef.current!.getBoundingClientRect();
        g.px = (e.clientX - r.left - v.x) / k;
        g.py = (e.clientY - r.top - v.y) / k;
        // the rectangles don't depend on where the box is, so the last frame's will do
        if (!g.prop) setDrop(dropTarget(dispRef.current, g.px, g.py));
      } else {
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
        // one update: the committed state is the last drag frame
        commitDrag(g, overRef.current);
        setOver({});
        setDragBox(null);
        setDrop(null);
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
      // the drop target is the area under the pointer, as highlighted
      const areas = dispRef.current.areas;
      const rectOf: RectOf = (a) => areas.find((x) => x.a.name === a.name)?.r ?? null;
      dropBox(g.id, p, dropTarget(dispRef.current, g.px, g.py), rectOf);
      return;
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
      const r = disp.areas.find((x) => x.a.name === name)?.r;
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
        drag.current = { kind: 'box', id: d.b.id, prop: d.b.prop, x: e.clientX, y: e.clientY, bx: d.x, by: d.y, moved: false, px: 0, py: 0 };
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
    const more = t.closest('[data-more]') as HTMLElement | null;
    if (more) {
      toggleExpanded(more.dataset.more!);
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
          <AreaG key={a.name} a={a} r={r} sel={sel.includes('area:' + a.name)} drop={drop === a.name} fa={farK ? farArea(farK) : null} />
        ))}
        <Edges disp={disp} S={S} shown={shown} />
        {(shown ? disp.boxes.filter((d) => shown.has(d.b.id)) : disp.boxes).map((d) => (
          <BoxG
            key={d.b.id}
            d={d}
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
  const k = Math.min(3, Math.max(0.02, v.k * f));
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
        if (p) byId.set(b.id, { b, x: p[0], y: p[1], w: b.w, h: b.defH, fullH: b.defH, rows: b.rows, col: false, more: 0, open: false, lift: false, sub: b.sub });
      }
      return areaRect(a, byId, pos);
    },
    [m, pos],
  );
}
