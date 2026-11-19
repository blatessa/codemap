// The map: programs and their parts, the resources they use, and how they
// talk (parts.ts). One layout for the whole session: selecting and hovering
// only change what's lit and which lines draw, so nothing moves under you.
// Functions never draw here; the panel has them.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { linksOf, partSub, partsOf, atRest, type Link, type Rect } from './parts';
import type { Model, Sel } from './model';
import { getState, select, setState, storyOf, useModel, useSel, useStore } from './store';
import { boxCls, rowCls } from './revs';

// what's lit: the selection's things and lines, or the hovered thing's
interface Lit {
  things: Set<string>;
  links: Link[];
}

function litFor(m: Model, S: Sel | null, P: ReturnType<typeof partsOf>, hover: string | null): Lit | null {
  if (S) {
    const things = new Set<string>();
    for (const n of S.nodes) {
      const t = P.thingOf(n);
      if (t) things.add(t);
    }
    const on = P.links.filter((l) => l.edges.some((i) => S.edges.has(i)));
    // calls through skipped code, and effects reached below what the trace shows
    const have = new Set(on.map((l) => l.key));
    for (const l of linksOf(m, S.extra)) if (!have.has(l.key)) on.push(l);
    return { things, links: on };
  }
  if (hover) {
    const links = P.links.filter((l) => l.from === hover || l.to === hover);
    const things = new Set([hover, ...links.flatMap((l) => [l.from, l.to])]);
    return { things, links };
  }
  return null;
}

function linePath(a: Rect, b: Rect): string {
  const ay = a.y + a.h / 2,
    by = b.y + b.h / 2;
  if (b.x >= a.x + a.w) {
    const x1 = a.x + a.w,
      x2 = b.x,
      dx = Math.max(30, (x2 - x1) / 2);
    return `M${x1},${ay} C${x1 + dx},${ay} ${x2 - dx},${by} ${x2},${by}`;
  }
  if (b.x + b.w <= a.x) {
    const x1 = a.x,
      x2 = b.x + b.w,
      dx = Math.max(30, (x1 - x2) / 2);
    return `M${x1},${ay} C${x1 - dx},${ay} ${x2 + dx},${by} ${x2},${by}`;
  }
  // one above the other: out of the right side and back in
  const x1 = a.x + a.w,
    x2 = b.x + b.w,
    bulge = 36 + Math.abs(by - ay) * 0.12;
  return `M${x1},${ay} C${x1 + bulge},${ay} ${x2 + bulge},${by} ${x2},${by}`;
}

const VERB: Record<Link['kind'], string> = { calls: 'calls', http: 'HTTP', event: 'event', reads: 'reads', writes: 'writes', shows: 'shows' };

export function PartMap({ drawerOpen }: { drawerOpen: boolean }) {
  const m = useModel();
  const S = useSel();
  const P = partsOf(m);
  const view = useStore((s) => s.view);
  const sel = useStore((s) => s.sel);
  const story = useStore(storyOf);
  const connectFrom = useStore((s) => s.connectFrom);
  const canAdd = useStore((s) => s.mode === 'propose' && !!s.pslug);
  const fitSeq = useStore((s) => s.fitSeq);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const lit = useMemo(() => litFor(m, S, P, hover), [m, S, P, hover]);
  const selThings = useMemo(() => new Set(sel.map((id) => P.thingOf(id) ?? id)), [sel, P]);

  // ---- camera ----
  // the map's visible width: the panel covers its right side when it's open
  const size = () => {
    const r = svgRef.current!.getBoundingClientRect();
    const dw = document.getElementById('drawer')?.offsetWidth ?? 0;
    return { r, W: r.width - (r.width > 900 ? dw : 0) };
  };
  const fitTo = useCallback(
    (rs: Rect[], maxK: number) => {
      if (!svgRef.current || !rs.length) return;
      const { r, W } = size();
      const x0 = Math.min(...rs.map((q) => q.x)) - 30,
        y0 = Math.min(...rs.map((q) => q.y)) - 30,
        x1 = Math.max(...rs.map((q) => q.x + q.w)) + 30,
        y1 = Math.max(...rs.map((q) => q.y + q.h)) + 30;
      const k = Math.max(0.05, Math.min((W - 40) / (x1 - x0), (r.height - 70) / (y1 - y0), maxK));
      setState({ view: { k, x: (W - (x1 - x0) * k) / 2 - x0 * k, y: 58 + (r.height - 70 - (y1 - y0) * k) / 2 - y0 * k } });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawerOpen],
  );
  useLayoutEffect(() => {
    if (fitSeq) fitTo(P.frames, 1.3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSeq, P]);
  // The camera moves only when something new is selected and what it lights
  // isn't all on screen: then it frames it, beside the panel. A story's
  // steps, hovering and the rest never move it.
  const focusKey = story ?? (sel.length === 1 ? sel[0] : '');
  useEffect(() => {
    if (!focusKey || !lit) return;
    const rs = [...lit.things].map((t) => P.at.get(t)).filter((x): x is Rect => !!x);
    if (!rs.length) return;
    // after the panel has opened, so its width counts
    const raf = requestAnimationFrame(() => {
      if (!svgRef.current) return;
      const { r, W } = size(),
        v = getState().view;
      const off = rs.some((q) => q.x * v.k + v.x < 0 || (q.x + q.w) * v.k + v.x > W || q.y * v.k + v.y < 50 || (q.y + q.h) * v.k + v.y > r.height);
      if (off) fitTo(rs, Math.max(v.k, 0.6));
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);
  useEffect(() => {
    const onResize = () => !getState().touchedView && fitTo(P.frames, 1.3);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fitTo, P]);
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
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x,
        dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) setDragging(true);
      d.moved = true;
      setState({ view: { ...getState().view, x: d.vx + dx, y: d.vy + dy }, touchedView: true });
    };
    const up = () => {
      setDragging(false);
      setTimeout(() => (drag.current = null), 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  // ---- input ----
  const target = (t: Element) => {
    const n = (t.closest('[data-node]') as HTMLElement | null)?.dataset.node;
    if (n) return n;
    return (t.closest('[data-box]') as HTMLElement | null)?.dataset.box ?? null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const v = getState().view;
    drag.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: false };
  };
  const onClick = (e: React.MouseEvent) => {
    if (drag.current?.moved) return;
    const t = e.target as Element;
    const add = (t.closest('[data-add]') as HTMLElement | null)?.dataset.add;
    if (add) return setState({ form: { type: 'fn', box: add }, sel: [], connectFrom: null });
    const id = target(t);
    if (!id) return setState({ sel: [], form: null, connectFrom: null });
    select(id);
  };
  const onPointerOver = (e: React.PointerEvent) => {
    if (drag.current?.moved) return;
    const id = target(e.target as Element);
    const t = id ? (P.thingOf(id) ?? id) : null;
    if (t !== hover) setHover(t);
  };

  // ---- what draws ----
  // at rest every connection draws: how parts talk across programs and over
  // events strongly, the rest faintly
  const shown = lit ? lit.links : P.links;
  const lineCls = (l: Link) =>
    ['edge', 'k-' + l.kind, l.kind === 'http' && 'net', l.prop && 'prop', lit ? 'on' : atRest(P, l) || l.prop ? '' : 'faint'].filter(Boolean).join(' ');
  const dimOf = (t: string) => (lit ? (lit.things.has(t) ? 'touched' : 'dim') : '');

  return (
    <svg
      id="map"
      ref={svgRef}
      className={`${dragging ? 'dragging' : ''} ${connectFrom ? 'connecting' : ''}`}
      aria-label="Architecture map"
      onPointerDown={onPointerDown}
      onPointerOver={onPointerOver}
      onPointerLeave={() => setHover(null)}
      onClick={onClick}
      data-zoom={view.k.toFixed(3)}
      data-hover={hover ?? ''}
    >
      <defs>
        {['mk-n', 'mk-h', 'mk-p'].map((id) => (
          <marker key={id} id={id} viewBox="0 0 8 8" refX={7.5} refY={4} markerUnits="userSpaceOnUse" markerWidth={9} markerHeight={9} orient="auto">
            <path className={id} d="M0,0.5 L8,4 L0,7.5z" />
          </marker>
        ))}
      </defs>
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
        {P.frames.map((f) => (
          <g key={f.id} className={`frame${f.resource ? ' res' : ''}`} data-frame={f.id}>
            <rect className="frect" x={f.x} y={f.y} width={f.w} height={f.h} rx={14} />
            <text className="flabel" x={f.x + 18} y={f.y + 25}>
              {f.label}
            </text>
          </g>
        ))}
        <g>
          {shown.map((l) => {
            const a = P.at.get(l.from),
              b = P.at.get(l.to);
            if (!a || !b) return null;
            return (
              <path key={l.key} className={lineCls(l)} d={linePath(a, b)} data-link={l.key} style={{ strokeWidth: 1.2 + Math.log2(l.edges.length) * 0.8 + 'px' }} markerEnd={`url(#${l.prop ? 'mk-p' : lit ? 'mk-h' : 'mk-n'})`}>
                <title>{`${VERB[l.kind]} · ${l.edges.length}`}</title>
              </path>
            );
          })}
        </g>
        {m.boxes
          .filter((b) => !b.external)
          .map((b) => {
            const q = P.at.get(b.id);
            if (!q) return null;
            const cls = ['mod', b.prop && 'prop', !b.prop && b.rows.some((r) => r.prop || r.moved) && 'pchg', b.ghost && 'ghost', boxCls(b), selThings.has(b.id) && 'msel', hover === b.id && 'hov', dimOf(b.id)].filter(Boolean).join(' ');
            return (
              <g key={b.id} className={cls} data-box={b.id}>
                <rect className="box" x={q.x} y={q.y} width={q.w} height={q.h} rx={8} />
                <g className="mhead" data-mod={b.id}>
                  <text className="mname" x={q.x + 14} y={q.y + 19}>
                    {b.label}
                  </text>
                  <text className="msub" x={q.x + 14} y={q.y + 34}>
                    {partSub(b)}
                  </text>
                </g>
                {canAdd && !b.ghost && (
                  <g className="add" data-add={b.id}>
                    <rect x={q.x + q.w - 28} y={q.y + 12} width={20} height={20} rx={5} />
                    <text x={q.x + q.w - 18} y={q.y + 27} textAnchor="middle">
                      +
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        {m.boxes
          .filter((b) => b.external)
          .flatMap((b) =>
            b.rows.map((r) => {
              const q = P.at.get(r.id);
              if (!q) return null;
              const cls = ['res', r.tagClass, r.prop && 'prop', rowCls(r.id), selThings.has(r.id) && 'sel', hover === r.id && 'hov', dimOf(r.id)].filter(Boolean).join(' ');
              return (
                <g key={r.id} className={cls} data-node={r.id}>
                  <rect className="box" x={q.x} y={q.y} width={q.w} height={q.h} rx={6} />
                  <text className="rname" x={q.x + 10} y={q.y + 17}>
                    {r.label}
                  </text>
                </g>
              );
            }),
          )}
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
