// The map: programs and their parts, the resources they use, and how they
// talk (parts.ts). One layout for the whole session: selecting and hovering
// only change what's lit and which lines draw, so nothing moves under you.
// Functions never draw here; the panel has them.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addLabel, linksOf, isFolder, markChar, markOf, type Item, type Link, type Parts, type Rect } from './parts';
import type { Model, Sel } from './model';
import { getState, select, setState, storyOf, toggleFolder, useModel, useParts, useSel, useStore } from './store';
import { boxCls, rowCls } from './revs';

// what's lit: the selection's things and lines, or the hovered thing's
interface Lit {
  things: Set<string>;
  links: Link[];
}

function litFor(m: Model, S: Sel | null, P: Parts, hover: string | null): Lit | null {
  if (S) {
    const things = new Set<string>();
    for (const n of S.nodes) {
      const t = P.thingOf(n);
      if (t) things.add(t);
    }
    const on = P.links.filter((l) => l.edges.some((i) => S.edges.has(i)));
    // calls through skipped code, and effects reached below what the trace shows
    const have = new Set(on.map((l) => l.key));
    for (const l of linksOf(m, S.extra, P.thingOf)) if (!have.has(l.key)) on.push(l);
    return { things, links: on };
  }
  if (hover) {
    const links = P.links.filter((l) => l.from === hover || l.to === hover);
    const things = new Set([hover, ...links.flatMap((l) => [l.from, l.to])]);
    return { things, links };
  }
  return null;
}

// linePath draws a link; `down` (to or from a table, topic or service, in the
// row below) goes out of the bottom and into the top.
function linePath(a: Rect, b: Rect, down = false): string {
  const ay = a.y + a.h / 2,
    by = b.y + b.h / 2;
  // below it (a table under the code): out of the bottom, into the top
  if (down && b.y >= a.y + a.h) {
    const x1 = a.x + a.w / 2,
      y1 = a.y + a.h,
      x2 = b.x + b.w / 2,
      y2 = b.y,
      dy = Math.max(30, (y2 - y1) / 2);
    return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
  }
  if (down && a.y >= b.y + b.h) {
    const x1 = a.x + a.w / 2,
      y1 = a.y,
      x2 = b.x + b.w / 2,
      y2 = b.y + b.h,
      dy = Math.max(30, (y1 - y2) / 2);
    return `M${x1},${y1} C${x1},${y1 - dy} ${x2},${y2 + dy} ${x2},${y2}`;
  }
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

// itemDiff marks a part or folder by what a comparison changed in it.
const itemDiff = (it: Item) => (it.box ? boxCls(it.box) : it.parts!.some((b) => boxCls(b)) ? 'd-has' : '');

// READABLE is the smallest zoom a selection is framed at: names stay legible.
const READABLE = 0.65;

const VERB: Record<Link['kind'], string> = { calls: 'calls', http: 'HTTP', event: 'event', reads: 'reads', writes: 'writes', shows: 'shows' };

export function PartMap({ drawerOpen }: { drawerOpen: boolean }) {
  const m = useModel();
  const S = useSel();
  const P = useParts();
  const view = useStore((s) => s.view);
  const sel = useStore((s) => s.sel);
  const story = useStore(storyOf);
  const connectFrom = useStore((s) => s.connectFrom);
  const canAdd = useStore((s) => s.mode === 'propose' && !!s.pslug);
  const fitSeq = useStore((s) => s.fitSeq);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  // hovering a name in the panel marks it on the map
  const panelHover = useStore((s) => s.hover);
  const hov = hover ?? (panelHover ? P.itemOf(panelHover) : null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  // a selected folder lights like a hovered thing: its connections
  const lit = useMemo(() => litFor(m, S, P, hover ?? (sel && isFolder(sel) ? sel : null)), [m, S, P, hover, sel]);
  const selThings = useMemo(() => new Set(sel ? [P.itemOf(sel)] : []), [sel, P]);

  // ---- camera ----
  // the map's visible width: the panel covers its right side when it's open
  const size = () => {
    const r = svgRef.current!.getBoundingClientRect();
    const dw = document.getElementById('drawer')?.offsetWidth ?? 0;
    return { r, W: r.width - (r.width > 900 ? dw : 0) };
  };
  // fitTo frames rs. With minK, it never zooms out further than that: what
  // doesn't fit stays off screen, and `keep` (the selected thing) stays on it.
  const fitTo = useCallback(
    (rs: Rect[], maxK: number, minK = 0.05, keep?: Rect) => {
      if (!svgRef.current || !rs.length) return;
      const { r, W } = size();
      const x0 = Math.min(...rs.map((q) => q.x)) - 30,
        y0 = Math.min(...rs.map((q) => q.y)) - 30,
        x1 = Math.max(...rs.map((q) => q.x + q.w)) + 30,
        y1 = Math.max(...rs.map((q) => q.y + q.h)) + 30;
      const k = Math.max(minK, Math.min((W - 40) / (x1 - x0), (r.height - 70) / (y1 - y0), maxK));
      let x = (W - (x1 - x0) * k) / 2 - x0 * k,
        y = 58 + (r.height - 70 - (y1 - y0) * k) / 2 - y0 * k;
      if (keep) {
        // shift the least that brings it fully into view
        const kx0 = keep.x * k + x,
          kx1 = (keep.x + keep.w) * k + x,
          ky0 = keep.y * k + y,
          ky1 = (keep.y + keep.h) * k + y;
        if (kx0 < 30) x += 30 - kx0;
        else if (kx1 > W - 30) x -= kx1 - (W - 30);
        if (ky0 < 70) y += 70 - ky0;
        else if (ky1 > r.height - 30) y -= ky1 - (r.height - 30);
      }
      setState({ view: { k, x, y } });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawerOpen],
  );
  // the whole map is fitted when asked (on load, Fit); the layout changing
  // (a folder opening, a proposal growing) doesn't move the camera
  const fitted = useRef(0);
  useLayoutEffect(() => {
    if (!fitSeq || fitted.current === fitSeq || !P.frames.length) return;
    fitted.current = fitSeq;
    fitTo(P.frames, 1.3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSeq, P]);
  // opening a proposal frames the parts it changes, beside its panel
  const pslug = useStore((s) => s.pslug);
  useEffect(() => {
    if (!pslug) return;
    const raf = requestAnimationFrame(() => {
      const changed = P.items.filter((it) => (it.box ? it.box.prop || it.box.rows.some((r) => r.prop || r.moved) : it.sub.includes('proposed')));
      const rs = (changed.length ? changed : P.frames).map((it) => P.at.get(it.id) ?? (it as Rect));
      fitTo(rs, 1.3, changed.length ? READABLE : 0.05);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pslug]);
  // a folder that opens is framed, so its parts are readable
  const open = useStore((s) => s.open);
  const lastOpen = useRef(open);
  useEffect(() => {
    const added = open.find((x) => !lastOpen.current.includes(x));
    lastOpen.current = open;
    if (!added) return;
    const path = added.split(':').slice(2).join(':') + '/';
    const rs = P.items.filter((it) => it.label.startsWith(path)).map((it) => P.at.get(it.id)!);
    if (rs.length) fitTo(rs, 1.3, READABLE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, P]);
  // The camera moves only when something new is selected and what it lights
  // isn't all on screen: then it frames it, beside the panel. A story's
  // steps, hovering and the rest never move it.
  const focusKey = story ?? sel ?? '';
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
      // too small to read, unless the user zoomed out on purpose
      const small = v.k < READABLE && !getState().touchedView;
      if (off || small) fitTo(rs, Math.max(v.k, READABLE), READABLE, P.at.get(P.itemOf(focusKey)));
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
    if (add) return setState({ form: { type: 'fn', box: add }, sel: null, connectFrom: null });
    const id = target(t);
    if (!id) return setState({ sel: null, form: null, connectFrom: null });
    select(id);
  };
  const onPointerOver = (e: React.PointerEvent) => {
    if (drag.current?.moved) return;
    const id = target(e.target as Element);
    const t = id ? P.itemOf(id) : null;
    if (t !== hover) setHover(t);
  };

  // ---- what draws ----
  // at rest no lines draw: they're for what's hovered or selected (and a
  // proposal's new ones, which are what it's about)
  const shown = lit ? lit.links : P.links.filter((l) => l.prop || l.diff);
  const lineCls = (l: Link) => ['edge', 'k-' + l.kind, l.kind === 'http' && 'net', l.prop && 'prop', l.diff && 'dl-' + l.diff, lit && 'on'].filter(Boolean).join(' ');
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
      onDoubleClick={(e) => {
        const id = target(e.target as Element);
        if (id && isFolder(id)) toggleFolder(id);
      }}
      data-zoom={view.k.toFixed(3)}
      data-hover={hover ?? ''}
    >
      <defs>
        {['mk-n', 'mk-h', 'mk-p', 'mk-a', 'mk-r', 'mk-c'].map((id) => (
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
              <path key={l.key} className={lineCls(l)} d={linePath(a, b, m.node.has(l.from) || m.node.has(l.to))} data-link={l.key} style={{ strokeWidth: 1.2 + Math.log2(l.edges.length) * 0.8 + 'px' }} markerEnd={`url(#${lit ? 'mk-h' : l.prop ? 'mk-p' : l.diff ? { add: 'mk-a', rem: 'mk-r', chg: 'mk-c' }[l.diff] : 'mk-n'})`}>
                <title>{`${VERB[l.kind]} · ${l.edges.length}`}</title>
              </path>
            );
          })}
        </g>
        {P.items.map((it) => {
            const q = P.at.get(it.id);
            if (!q) return null;
            const b = it.box;
            const cls = ['mod', !b && 'folder', ...(b ? [b.prop && 'prop', !b.prop && b.rows.some((r) => r.prop || r.moved) && 'pchg', b.ghost && 'ghost'] : []), itemDiff(it), selThings.has(it.id) && 'msel', hov === it.id && 'hov', dimOf(it.id)].filter(Boolean).join(' ');
            return (
              <g key={it.id} className={cls} data-box={it.id}>
                {!b && <rect className="stack" x={q.x + 4} y={q.y - 4} width={q.w} height={q.h} rx={8} />}
                <rect className="box" x={q.x} y={q.y} width={q.w} height={q.h} rx={8} />
                <g className="mhead" data-mod={it.id}>
                  <text className="mname" x={q.x + 14} y={q.y + 19}>
                    {it.label}
                  </text>
                  <text className="msub" x={q.x + 14} y={q.y + 34}>
                    {it.sub}
                    {it.counts && <tspan className="mcnt"> · {it.counts}</tspan>}
                  </text>
                </g>
                {it.adds.map((r) => {
                  const a = P.at.get(r.id);
                  if (!a) return null;
                  const mk = markOf(r.id);
                  const c = ['padd', r.moved && 'moved', mk && 'cmp d-' + mk, selThings.has(r.id) && 'sel', hov === r.id && 'hov', dimOf(r.id)].filter(Boolean).join(' ');
                  return (
                    <g key={r.id} className={c} data-node={r.id}>
                      <rect x={a.x} y={a.y} width={a.w} height={a.h} rx={4} />
                      <text x={a.x + 8} y={a.y + 12.5}>
                        <tspan className="pplus">{r.moved ? '↳' : markChar(r.id) || '+'}</tspan> {addLabel(r)}
                      </text>
                    </g>
                  );
                })}
                {it.more > 0 && P.at.get('more:' + it.id) && (
                  <text className="pmore" x={P.at.get('more:' + it.id)!.x + 8} y={P.at.get('more:' + it.id)!.y + 12.5}>
                    +{it.more} more changed
                  </text>
                )}
                {canAdd && b && !b.ghost && (
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
              const cls = ['res', r.tagClass, r.prop && 'prop', rowCls(r.id), selThings.has(r.id) && 'sel', hov === r.id && 'hov', dimOf(r.id)].filter(Boolean).join(' ');
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
