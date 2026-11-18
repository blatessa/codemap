// The map: SVG with areas, boxes (modules/blocks) and edges. Pan, zoom, drag.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GROUP_H, chain, isGroup, layoutH, type Group, type Grouping } from './groups';
import { innerLayout, layoutUnplaced, type LBox } from './layout';
import { FAR, FARH, HEAD, MORE, ROW, heightOf, type Box, type MEdge, type Model, type Row, type Sel } from './model';
import {
  currentProposal,
  dropBox,
  getState,
  groupingOf,
  moveNode,
  movePos,
  moveProposalModule,
  proposeEdge,
  select,
  setState,
  toggleExpanded,
  toggleMulti,
  useGrouping,
  useModel,
  useSel,
  useStore,
  type RectOf,
} from './store';
import type { Area } from './types';
import { boxCls, edgeCls, groupCls, nodeStatus, rowCls } from './revs';

// Far-mode text: scaled by 1/k so it stays readable on screen, and cut to fit.
interface FarText {
  name: string;
  sub: string; // '' when it doesn't fit
  fn: number; // font sizes
  fs: number;
  px: number;
  nb: number; // baselines, relative to the box top
  sb: number;
  hid?: string; // the name, hidden because it would overlap a more important one
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
  more: number; // internal and support rows: behind the "+N" row, or shown (open)
  moreWord: string; // "internal", "support", or "more" when it's both
  open: boolean;
  lift: boolean; // drawn above the others: taller than its laid-out height, or dragged
  sub: string;
  far?: FarText;
  inG?: string; // the open top-level group it's drawn in
}
export interface ARect {
  x: number;
  y: number;
  w: number;
  h: number;
  empty: boolean;
  fa?: number; // far mode: this area's title size
}
export interface Disp {
  boxes: DBox[];
  byId: Map<string, DBox>;
  row: Map<string, { d: DBox; idx: number }>;
  edges: MEdge[];
  areas: { a: Area; r: ARect }[];
  groups: { g: Group; r: ARect; reveal: boolean; top: string }[]; // open folder groups
  shift: Map<string, [number, number]>; // how far open groups pushed each top-level box
  reveal: string; // groups opened for the selection, joined
  boxSel: boolean; // only modules are selected: their calls stay one line per pair
}

const GROUP_NEAR = HEAD + 16; // a closed group's drawn height, zoomed in

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
// areaFont is an area title's far-mode size: about 13.5px on screen, but no
// wider than the area was laid out, so a title never stretches its area over a
// neighbour (layout reserves room for the title at 13).
const areaFont = (name: string, w: number, fa: number) => Math.max(13, Math.min(fa, w / (name.length * SANS + 1.4)));

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

// A folder group drawn open: its contents, placed relative to the container.
interface Cont {
  g: Group;
  reveal: boolean; // opened for the selection: shows only what the selection touches
  w: number;
  h: number;
  kids: { id: string; x: number; y: number; sub?: Cont }[];
}
const CPAD = 20;

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
  G: Grouping | null,
  selIds: string[],
  connecting = false, // picking an edge's target in a proposal: every row is a target
): Disp {
  const boxes: DBox[] = [];
  const byId = new Map<string, DBox>();
  const row = new Map<string, { d: DBox; idx: number }>();
  const focusOn = focus && S;
  const later: Box[] = [];
  const fn = k ? farFont(k) : 0,
    fs = k ? farSub(k) : 0;
  const top = areaTop(k ? farArea(k) : null);
  // How much a box shows follows what the user is doing:
  // - at rest, the rows that say what a module is for: entry points, external
  //   systems, proposed and changed rows;
  // - a selected module adds its public surface: the functions other modules
  //   call, without support code;
  // - a selected function adds the rows on its trace.
  // Internal functions never show (except as targets while connecting an
  // edge in a proposal); rows left out are counted in a quiet line.
  const openBoxes = new Set(selIds.filter((id) => m.box.has(id)));
  const visible = (b: Box): { rows: Row[]; more: number; moreWord: string; open: boolean } => {
    if (focusOn) return { rows: b.rows.filter((r) => S.nodes.has(r.id)), more: 0, moreWord: '', open: false };
    const all = b.rows;
    if (connecting) return { rows: all, more: 0, moreWord: '', open: false };
    const open = openBoxes.has(b.id);
    // a traced path shows only its own rows: the other commands and tables
    // in a box aren't part of this story
    if (S?.path.size && !open) {
      const rows = all.filter((r) => S.path.has(r.id) || r.prop || r.ghost || !!r.moved || !!nodeStatus(r.id));
      return { rows, more: all.length - rows.length, moreWord: 'more', open };
    }
    const keep = (r: Row) =>
      r.node.entry || r.node.external || r.prop || r.ghost || !!r.moved || !!nodeStatus(r.id) || !!S?.path.has(r.id) || (open && r.pub && !r.role);
    const rows = all.filter(keep);
    return { rows, more: all.length - rows.length, moreWord: open ? 'internal' : 'more', open };
  };

  // Folded groups open when the user opens them, or for the selection: the
  // groups holding what's selected and, for a traced path, every box on it.
  const reveal = new Set<string>(),
    revealed = new Set<string>();
  if (G) {
    const want = (bid?: string) => {
      if (!bid || revealed.has(bid)) return;
      revealed.add(bid);
      for (const g of chain(G, bid)) reveal.add(g);
    };
    let traced = false;
    for (const id of selIds) {
      const n = m.node.get(id);
      if (n) {
        want(n.box.id);
        traced = true;
      } else if (m.box.has(id)) want(id);
    }
    if (traced && S) for (const n of S.path) want(m.node.get(n)?.box.id);
  }
  const openOf = (id: string): 'full' | 'reveal' | null => (expanded.has(id) ? 'full' : reveal.has(id) ? 'reveal' : null);
  const content = (gid: string, mode: 'full' | 'reveal'): Cont => {
    const g = G!.groups.get(gid)!;
    const kids = g.children.filter((c) => mode === 'full' || (isGroup(c) ? reveal.has(c) : revealed.has(c)));
    const subs = new Map<string, Cont>();
    const items: LBox[] = kids.map((c) => {
      const cg = isGroup(c) ? G!.groups.get(c)! : null;
      const om = cg ? openOf(c) : null;
      if (om) {
        const sc = content(c, om);
        subs.set(c, sc);
        return { id: c, w: sc.w, h: sc.h, entry: cg!.box.hasEntry };
      }
      const b = cg ? cg.box : m.box.get(c)!;
      // zoomed in, an open group makes room for the rows its boxes show
      let h = layoutH(b);
      if (!k && !cg) {
        const v = visible(b);
        h = collapsed.has(b.id) ? HEAD : heightOf(v.rows.length, v.more > 0);
      }
      return { id: c, w: b.w, h, entry: b.hasEntry };
    });
    const kidOf = new Map<string, string>();
    for (const c of kids) for (const b of isGroup(c) ? G!.groups.get(c)!.members : [c]) kidOf.set(b, c);
    const links: [string, string][] = [];
    for (const e of m.edges) {
      const a = kidOf.get(m.node.get(e.from)!.box.id),
        b = kidOf.get(m.node.get(e.to)!.box.id);
      if (a && b && a !== b) links.push([a, b]);
    }
    const L = innerLayout(items, links);
    const fa = k ? farArea(k) : 0;
    const labelW = k ? (g.path.length + 2) * fa * SANS + fa * 1.4 : g.path.length * 7 + 60;
    return {
      g,
      reveal: mode === 'reveal',
      w: Math.max(L.w + CPAD * 2, labelW),
      h: top + L.h + CPAD,
      kids: kids.map((c) => ({ id: c, x: L.pos[c][0], y: L.pos[c][1], sub: subs.get(c) })),
    };
  };

  // what's laid out at the top: every box, or on big maps the top level of the grouping
  const tops = G ? [...G.top, ...m.boxes.filter((b) => b.prop || b.ghost).map((b) => b.id)] : m.boxes.map((b) => b.id);
  const baseOf = (id: string): [number, number] | undefined => {
    const b = m.box.get(id);
    return (b?.prop ? b.propPos : undefined) ?? pos[id];
  };
  const conts = new Map<string, Cont>();
  if (G)
    for (const id of G.top) {
      const om = isGroup(id) ? openOf(id) : null;
      if (om && pos[id]) conts.set(id, content(id, om));
    }
  // An open group pushes everything right of it and below it aside by its growth:
  // nothing overlaps and the rest of the map keeps its shape.
  const shift = new Map<string, [number, number]>();
  if (conts.size) {
    const P = new Map<string, [number, number]>();
    for (const id of tops) {
      const p = baseOf(id);
      if (p) P.set(id, [p[0], p[1]]);
    }
    const order = [...conts.keys()].sort((a, b) => P.get(a)![0] - P.get(b)![0] || P.get(a)![1] - P.get(b)![1]);
    for (const gid of order) {
      const [gx, gy] = P.get(gid)!;
      const gw = G!.groups.get(gid)!.box.w,
        c = conts.get(gid)!;
      const dw = Math.max(0, c.w - gw),
        dh = Math.max(0, c.h - GROUP_H);
      for (const [id, p] of P) {
        if (id === gid) continue;
        if (p[0] >= gx + gw) p[0] += dw;
        if (p[1] >= gy + GROUP_H) p[1] += dh;
      }
    }
    for (const [id, p] of P) {
      const b = baseOf(id)!;
      if (p[0] !== b[0] || p[1] !== b[1]) shift.set(id, [p[0] - b[0], p[1] - b[1]]);
    }
  }

  const groupsOut: Disp['groups'] = [];
  for (const id of tops) {
    const base = over[id] ?? baseOf(id);
    if (!base) {
      const b = m.box.get(id);
      if (b && (b.prop || b.ghost)) later.push(b);
      continue;
    }
    const s = shift.get(id);
    const p: [number, number] = s ? [base[0] + s[0], base[1] + s[1]] : base;
    if (!isGroup(id)) add(m.box.get(id)!, p);
    else if (conts.has(id)) place(conts.get(id)!, p, id);
    else addGroup(G!.groups.get(id)!, p);
  }
  function place(c: Cont, p: [number, number], topId: string) {
    groupsOut.push({ g: c.g, r: { x: p[0], y: p[1], w: c.w, h: c.h, empty: false }, reveal: c.reveal, top: topId });
    for (const kid of c.kids) {
      const q: [number, number] = [p[0] + CPAD + kid.x, p[1] + top + kid.y];
      if (kid.sub) place(kid.sub, q, topId);
      else if (isGroup(kid.id)) addGroup(G!.groups.get(kid.id)!, q, topId);
      else add(m.box.get(kid.id)!, q, topId);
    }
  }
  // farText is a far-mode box's text and height; `nx` (in ems) leaves room for a caret.
  function farText(b: Box, sub: string, fh: number, nx = 0): { h: number; far: FarText } {
    const px = Math.max(16, fs * 0.5),
      py = fs * 0.5,
      tw = b.w - px * 1.5 - nx * fn;
    // the sub line shows only whole, and only when the box has room for it
    const fits = (t: string) => t.length * fs * SANS <= tw;
    const short = b.shared && !S ? `used by ${b.usedBy}` : '';
    const subT = fits(sub) ? sub : fits(short) ? short : '';
    const withSub = py * 2 + fn * 1.2 + fs * 1.25;
    const cap = Math.max(FARH, fh + 20);
    const room = !!subT && withSub <= cap;
    const h = room ? Math.max(FARH, withSub) : Math.max(FARH, Math.min(cap, py * 2 + fn * 1.2));
    let name = fitText(b.label, tw, fn, MONO, true);
    // a cut name hides what tells boxes apart: show the last path segment whole,
    // past the box if need be (declutter hides names that would collide)
    if (!name || name.endsWith('…')) name = b.label.split('/').pop() || b.label;
    return {
      h,
      far: { name, sub: room ? subT : '', fn, fs, px: px + nx * fn, nb: (room ? py : (h - fn * 1.2) / 2) + fn * 0.95, sb: py + fn * 1.2 + fs },
    };
  }
  function add(b: Box, p: [number, number], inG?: string) {
    const v = visible(b);
    if (focusOn && !v.rows.length) return;
    const fh = heightOf(v.rows.length, v.more > 0);
    const sub = b.shared && !S ? `used by ${b.usedBy} module${b.usedBy === 1 ? '' : 's'}` : b.sub;
    let h = collapsed.has(b.id) ? HEAD : fh;
    let far: FarText | undefined;
    if (k) ({ h, far } = farText(b, sub, fh));
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
      moreWord: v.moreWord,
      open: v.open,
      lift: dragBox?.id === b.id || (!k && h > (G ? layoutH(b) : b.defH)),
      sub,
      far,
      inG,
    };
    boxes.push(d);
    byId.set(b.id, d);
    if (!d.col) v.rows.forEach((r, idx) => row.set(r.id, { d, idx }));
    else v.rows.forEach((r) => row.set(r.id, { d, idx: -1 }));
    // rows left out still anchor their calls, at the box's header
    if (!focusOn) for (const r of b.rows) if (!row.has(r.id)) row.set(r.id, { d, idx: -1 });
  }
  function addGroup(g: Group, p: [number, number], inG?: string) {
    const b = g.box;
    if (focusOn && !b.rows.some((r) => S.nodes.has(r.id))) return;
    let h = GROUP_NEAR;
    let far: FarText | undefined;
    if (k) ({ h, far } = farText(b, b.sub, GROUP_H - 20, 0.9));
    const d: DBox = { b, x: p[0], y: p[1], w: b.w, h, fullH: GROUP_NEAR, rows: [], col: true, more: 0, moreWord: '', open: false, lift: false, sub: b.sub, far, inG };
    boxes.push(d);
    byId.set(b.id, d);
    for (const r of b.rows) row.set(r.id, { d, idx: -1 });
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
  // Show all: boxes grow to every row, and push the boxes below them down by as
  // much, so nothing overlaps and the map keeps its shape.
  if (connecting && !k) pushDown(boxes.filter((d) => !d.inG), (d) => (G ? layoutH(d.b) : d.b.defH));
  // edges into shared modules only draw when the selection uses them
  const edges = m.edges.filter((e) => {
    const a = row.get(e.from),
      b = row.get(e.to);
    if (!a || !b) return false;
    if (focusOn) return S.edges.has(e.i);
    if (b.d.b.shared && a.d !== b.d && !e.prop) return !!S && S.edges.has(e.i);
    return true;
  });
  // the selection's trace: calls through skipped forwarding functions, and
  // effects reached through code the trace doesn't show
  if (S) for (const e of S.extra) if (row.has(e.from) && row.has(e.to)) edges.push(e);
  const out: Disp['areas'] = [];
  let bottom = boxes.length ? Math.max(...boxes.map((d) => d.y + d.fullH)) + 60 : 80;
  for (const a of areas) {
    let r = dragBox?.frozen.get(a.name) ?? areaRect(a, byId, pos);
    if (r && k && !r.empty && r.fa === undefined) {
      const fa = areaFont(a.name, r.w, farArea(k)),
        t = areaTop(fa);
      r = { ...r, y: r.y + 44 - t, h: r.h - 44 + t, fa };
    }
    if (focusOn && (!r || r.empty)) continue;
    if (!r && !(a.modules ?? []).some((id) => m.box.has(id))) {
      r = { x: 20, y: bottom, w: 260, h: 140, empty: true };
      bottom += 160;
    }
    if (r) out.push({ a, r });
  }
  if (k && G) uniqueNames(boxes);
  if (k) declutter(boxes, edges, row, out, groupsOut, k);
  // expanded and dragged boxes draw above their neighbours
  boxes.sort((x, y) => Number(x.lift) - Number(y.lift));
  return { boxes, byId, row, edges, areas: out, groups: groupsOut, shift, reveal: [...reveal].sort().join('\0'), boxSel: !!selIds.length && selIds.every((id) => m.box.has(id)) };
}

function pushDown(ds: DBox[], base: (d: DBox) => number) {
  const order = [...ds].sort((a, b) => a.y - b.y);
  const orig = new Map(order.map((d) => [d, d.y]));
  for (const a of order) {
    const grow = a.h - base(a);
    if (grow <= 0) continue;
    const bottom = orig.get(a)! + base(a);
    for (const b of order) if (b !== a && orig.get(b)! >= bottom - 1 && b.x < a.x + a.w && b.x + b.w > a.x) b.y += grow;
  }
  for (const d of ds) d.lift = false;
}

// uniqueNames lengthens far-mode names that read the same ("store", "store")
// to their shortest distinct tails ("…/backend/app/store").
function uniqueNames(boxes: DBox[]) {
  const by = new Map<string, DBox[]>();
  for (const d of boxes) if (d.far) (by.get(d.far.name) ?? by.set(d.far.name, []).get(d.far.name)!).push(d);
  for (const ds of by.values()) {
    if (ds.length < 2) continue;
    const segs = ds.map((d) => d.b.label.split('/'));
    const tail = (s: string[], n: number) => s.slice(-n).join('/');
    ds.forEach((d, i) => {
      const s = segs[i];
      let n = 1;
      while (n < s.length && segs.some((o, j) => j !== i && tail(o, n) === tail(s, n))) n++;
      d.far!.name = (n < s.length ? '…/' : '') + tail(s, n);
    });
  }
}

// declutter hides far-mode names that would overlap a more important one; they
// show on hover. Importance: entry points, then links to other boxes, then size.
function declutter(boxes: DBox[], edges: MEdge[], row: Disp['row'], areas: Disp['areas'], groups: Disp['groups'], k: number) {
  type R = [number, number, number, number];
  const placed: R[] = [];
  const hit = (r: R) => placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]);
  const fa = farArea(k);
  for (const { a, r } of areas) {
    const f = r.fa ?? fa;
    placed.push([r.x + f * 0.7, r.y + f * 0.25, r.x + f * 0.7 + a.name.length * f * SANS, r.y + f * 1.4]);
  }
  for (const { g, r } of groups) placed.push([r.x + fa * 0.7, r.y + fa * 0.25, r.x + fa * 2.1 + g.path.length * fa * SANS, r.y + fa * 1.4]);
  const nb = new Map<DBox, Set<DBox>>();
  for (const e of edges) {
    const a = row.get(e.from)!.d,
      b = row.get(e.to)!.d;
    if (a === b) continue;
    (nb.get(a) ?? nb.set(a, new Set()).get(a)!).add(b);
    (nb.get(b) ?? nb.set(b, new Set()).get(b)!).add(a);
  }
  const score = (d: DBox) =>
    (d.b.hasEntry ? 4 : 0) + Math.log2(1 + (nb.get(d)?.size ?? 0)) * 2 + Math.log2(1 + d.b.rows.length) + (d.b.group ? 2 : 0);
  const list = boxes.filter((d) => d.far).map((d) => ({ d, s: score(d) }));
  list.sort((x, y) => y.s - x.s || x.d.b.id.localeCompare(y.d.b.id));
  for (const { d } of list) {
    const f = d.far!;
    const x0 = d.x + f.px;
    // names keep a little air around them
    const rect = (n: number): R => [x0 - f.fn * 0.2, d.y + f.nb - f.fn * 0.95, x0 + (n + 0.4) * f.fn * MONO, d.y + f.nb + f.fn * 0.3];
    let name = rect(f.name.length);
    if (hit(name)) {
      // cut to the room there is, if that leaves enough to read; else hide it
      let n = f.name.length - 1;
      while (n >= 7 && hit(rect(n))) n--;
      if (n < 7) {
        f.hid = f.name;
        f.name = f.sub = '';
        continue;
      }
      f.hid = f.name;
      f.name = f.name.slice(0, n - 1) + '…';
      name = rect(n);
    }
    placed.push(name);
    if (!f.sub) continue;
    const sub: R = [x0 - f.fs * 0.2, d.y + f.sb - f.fs * 0.9, x0 + (f.sub.length + 0.4) * f.fs * SANS, d.y + f.sb + f.fs * 0.3];
    if (hit(sub)) f.sub = '';
    else placed.push(sub);
  }
}

// boxAt is the module box under the point.
function boxAt(disp: Disp, x: number, y: number): DBox | null {
  for (const d of disp.boxes) if (x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h) return d;
  return null;
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
    const ia = disp.row.get(e.from)!.idx,
      ib = disp.row.get(e.to)!.idx;
    // Calls draw row to row when both rows show, and when Show all is on or the
    // call is on the selection (or nothing is selected). The rest merge into one
    // quiet line per pair of boxes, and calls inside a box between rows that
    // aren't showing don't draw.
    const real = !(a.col && b.col) && !a.b.group && !b.b.group && ia >= 0 && ib >= 0 && (!S || (on && !disp.boxSel) || e.prop);
    if (!real && a === b) continue;
    if (!real) {
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
    const cls = ['edge', e.net && 'net', e.declared && 'decl', e.prop && 'prop', ghost && 'ghost', edgeCls(e), e.synth === 'reach' && 'reach', S ? (on ? 'on' : 'dim') : ''].filter(Boolean).join(' ');
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

const AreaG = memo(function AreaG({ a, r, sel, drop, fa: far }: { a: Area; r: ARect; sel: boolean; drop: boolean; fa: number | null }) {
  const fa = far && (r.fa ?? far);
  const hh = fa ? fa * 1.6 : 34;
  // an area is always wide enough for its name
  const w = Math.max(r.w, a.name.length * (fa ?? 13) * SANS + (fa ? fa * 1.4 : 32));
  return (
    <g className={`area${sel ? ' asel' : ''}${r.empty ? ' empty' : ''}${drop ? ' drop' : ''}`} data-area-box={a.name}>
      <rect className="arect" x={r.x} y={r.y} width={w} height={r.h} rx={14} />
      <g className="ahead" data-area={a.name}>
        <rect className="hit" x={r.x} y={r.y} width={w} height={hh} rx={14} />
        <text className="alabel" x={r.x + (fa ? fa * 0.7 : 16)} y={r.y + (fa ? fa * 1.15 : 23)} style={fa ? { fontSize: fa } : undefined}>
          {a.name}
        </text>
      </g>
    </g>
  );
});

// An open folder group: a container like an area, with the folder's path.
const GroupC = memo(function GroupC({ g, r, reveal, sel, fa }: { g: Group; r: ARect; reveal: boolean; sel: boolean; fa: number | null }) {
  const hh = fa ? fa * 1.6 : 34;
  const lx = r.x + (fa ? fa * 0.7 : 14);
  const by = r.y + (fa ? fa * 1.15 : 23);
  return (
    <g className={`grp${reveal ? ' reveal' : ''}${sel ? ' gsel' : ''} ${groupCls(g.id)}`} data-group-box={g.id}>
      <rect className="grect" x={r.x} y={r.y} width={r.w} height={r.h} rx={14} />
      <g className="ghead" data-ghead={g.id}>
        <rect className="hit" x={r.x} y={r.y} width={r.w} height={hh} rx={14} />
        <text className="alabel" x={lx + (fa ? fa * 1.1 : 16)} y={by} style={fa ? { fontSize: fa } : undefined}>
          {g.path}
        </text>
      </g>
      <g className="tgl" data-gtoggle={g.id}>
        <rect className="hit" x={lx - 4} y={r.y + 4} width={fa ? fa * 1.2 : 18} height={hh - 8} rx={4} />
        <text className="caret" x={lx} y={by} style={fa ? { fontSize: fa * 0.8 } : undefined}>
          {reveal ? '▸' : '▾'}
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
  const cls = ['mod', b.group && 'grpbox', b.external && 'ext', b.prop && 'prop', b.ghost && 'ghost', b.shared && 'shared', boxCls(b), sels.includes(b.id) && 'msel', S ? (touched ? 'touched' : 'dim') : '']
    .filter(Boolean)
    .join(' ');
  const moreY = y + HEAD + d.rows.length * ROW;
  return (
    <g className={cls} data-box={b.id}>
      {b.group && <rect className="box stack" x={x + (far ? far.fs * 0.4 : 4)} y={y + (far ? far.fs * 0.4 : 4)} width={w} height={h} rx={8} />}
      <rect className="box" x={x} y={y} width={w} height={h} rx={8} />
      <g className="mhead" data-mod={b.id}>
        <rect className="hit" x={x} y={y} width={w} height={far ? h : HEAD} rx={8} />
        {far ? null : (
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
      {b.group && (
        <g className="tgl" data-gtoggle={b.id}>
          <rect className="hit" x={far ? x + far.px - far.fn * 1.05 : x + 3} y={far ? y + far.nb - far.fn * 0.9 : y + 4} width={far ? far.fn * 0.95 : 19} height={far ? far.fn * 1.1 : 19} rx={4} />
          <text className="caret" x={far ? x + far.px - far.fn * 0.9 : x + 9} y={far ? y + far.nb : y + 16} style={far ? { fontSize: far.fn * 0.75 } : undefined}>
            ▸
          </text>
        </g>
      )}
      {!far && !b.group && (
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
            const c = ['fn', S ? (S.nodes.has(r.id) ? 'on' : 'dim') : '', d.open && r.role && 'role', (r.prop || r.moved) && 'prop', r.ghost && 'ghost', rowCls(r.id), sels.includes(r.id) && 'sel', connectFrom === r.id && 'from', hover === r.id && 'hov']
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
                {`${d.more} more`}
              </text>
            </g>
          )}
        </>
      )}
    </g>
  );
});

// Zoomed out, names draw above every box, so one running past its box stays readable.
const FarLabels = memo(function FarLabels({ boxes, halo }: { boxes: DBox[]; halo: boolean }) {
  return (
    <g className={`farlabels${halo ? ' halo' : ''}`}>
      {boxes.map(({ b, x, y, far }) =>
        far && far.name ? (
          <g key={b.id} data-label={b.id}>
            <text className="mname" x={x + far.px} y={y + far.nb} style={{ fontSize: far.fn, strokeWidth: far.fn * 0.3 }}>
              {far.name}
            </text>
            {far.sub && (
              <text className="msub" x={x + far.px} y={y + far.sb} style={{ fontSize: far.fs, strokeWidth: far.fs * 0.3 }}>
                {far.sub}
              </text>
            )}
          </g>
        ) : null,
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
  | { kind: 'box'; id: string; prop: boolean; grp: boolean; x: number; y: number; bx: number; by: number; moved: boolean; px: number; py: number }
  | { kind: 'row'; id: string; x: number; y: number; moved: boolean; px: number; py: number }
  | { kind: 'area'; name: string; x: number; y: number; start: { id: string; x: number; y: number }[]; ax: number; ay: number; moved: boolean };

export function MapView({ drawerOpen }: { drawerOpen: boolean }) {
  const m = useModel();
  const S = useSel();
  const G = useGrouping();
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
  const [rowDrop, setRowDrop] = useState<string | null>(null);
  const modelRef = useRef(m);
  modelRef.current = m;
  const setDrop = (t: string | null) => {
    dropRef.current = t;
    setDropState(t);
  };

  // Focus lays out just the boxes on the selection's path, so a feature on a
  // big map gets a picture of its own instead of a dimmed corner of the map.
  const [focusPos, setFocusPos] = useState<Record<string, [number, number]> | null>(null);
  useEffect(() => {
    if (!focus || !S) {
      setFocusPos(null);
      return;
    }
    const ids = m.boxes.filter((b) => b.rows.some((r) => S.nodes.has(r.id))).map((b) => b.id);
    const items = ids.map((id) => {
      const b = m.box.get(id)!;
      const n = b.rows.filter((r) => S.nodes.has(r.id)).length;
      return { id, w: b.w, h: heightOf(n, false), entry: b.hasEntry, external: b.external, shared: false };
    });
    const links: [string, string][] = [];
    for (const e of [...m.edges.filter((x) => S.edges.has(x.i)), ...S.extra]) {
      const a = m.node.get(e.from)?.box.id,
        b = m.node.get(e.to)?.box.id;
      if (a && b && a !== b) links.push([a, b]);
    }
    let live = true;
    void layoutUnplaced(items, links, [], {}).then((p) => {
      if (!live) return;
      setFocusPos(p);
      setState({ fitSeq: getState().fitSeq + 1 });
    });
    return () => {
      live = false;
    };
  }, [focus, S, m]);
  const disp = useMemo(
    () =>
      focusPos
        ? buildDisp(m, S, focusPos, {}, collapsed, expanded, focus, farK, [], null, null, sel, !!connectFrom)
        : buildDisp(m, S, pos, over, collapsed, expanded, focus, farK, areas, dragBox, G, sel, !!connectFrom),
    [m, S, pos, over, collapsed, expanded, focus, farK, areas, dragBox, G, sel, connectFrom, focusPos],
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

  // Opening groups for a new selection moves boxes; keep the selected one where it was on screen.
  const prevDisp = useRef<Disp | null>(null);
  useLayoutEffect(() => {
    const prev = prevDisp.current;
    prevDisp.current = disp;
    const id = sel[0];
    if (!prev || prev.reveal === disp.reveal || !id || getState().centerOn) return;
    const at = (d: Disp): [number, number] | null => {
      const b = d.row.get(id)?.d ?? d.byId.get(id);
      return b ? [b.x, b.y] : null;
    };
    const a = at(prev),
      b = at(disp);
    if (!a || !b || (a[0] === b[0] && a[1] === b[1])) return;
    const v = getState().view;
    setState({ view: { ...v, x: v.x - (b[0] - a[0]) * v.k, y: v.y - (b[1] - a[1]) * v.k } });
  }, [disp, sel]);


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
    // on big maps far names may run past their boxes; `lk` fits them too
    const fitWith = (hOf: (b: DBox) => number, maxK = 1.4, lk = 0) => {
      let x0 = 1e9,
        y0 = 1e9,
        x1 = -1e9,
        y1 = -1e9;
      for (const b of d.boxes) {
        x0 = Math.min(x0, b.x - 50);
        y0 = Math.min(y0, b.y - 44);
        x1 = Math.max(x1, b.x + b.w + 20);
        if (lk) x1 = Math.max(x1, b.x + Math.max(16, farSub(lk) * 0.5) + (b.far?.name || b.far?.hid || b.b.label).length * farFont(lk) * MONO + 20);
        y1 = Math.max(y1, b.y + hOf(b) + 20);
      }
      for (const { r: gr } of d.groups) {
        x0 = Math.min(x0, gr.x);
        y0 = Math.min(y0, gr.y);
        x1 = Math.max(x1, gr.x + gr.w);
        y1 = Math.max(y1, gr.y + gr.h);
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
    // (big maps settle over a few rounds: the drawn heights shrink as the zoom grows)
    const big = !!groupingOf(getState());
    for (let i = 0, n = big ? 4 : 1; i < n && v.k < FAR; i++) {
      const k = v.k;
      const far = fitWith((b) => farHeight(b.fullH, k), FAR * 0.99, big ? k : 0);
      if (far.k > k) v = far;
      else break;
    }
    // A focused path is read, not overviewed: never zoom out past where rows
    // show, and start where the story starts, at its entry point on the left.
    const st = getState();
    if (st.focus && st.sel.length && v.k < FAR) {
      const k = FAR * 1.05;
      const x0 = Math.min(...d.boxes.map((b) => b.x)),
        y0 = Math.min(...d.boxes.map((b) => b.y));
      v = { k, x: pad - (x0 - 20) * k, y: top - (y0 - 20) * k };
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
    if (!bd && !dispRef.current.boxes.length) return; // not laid out yet: wait for it
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
        if (g.kind === 'box' && !g.prop && !g.grp) {
          const frozen = new Map<string, ARect>();
          for (const { a, r } of dispRef.current.areas) if ((a.modules ?? []).includes(g.id)) frozen.set(a.name, r);
          setDragBox({ id: g.id, frozen });
        }
      }
      g.moved = true;
      const v = getState().view,
        k = v.k;
      if (g.kind === 'row') {
        const r = svgRef.current!.getBoundingClientRect();
        g.px = (e.clientX - r.left - v.x) / k;
        g.py = (e.clientY - r.top - v.y) / k;
        const d = boxAt(dispRef.current, g.px, g.py);
        setRowDrop(d && d.b.id !== modelRef.current.node.get(g.id)?.box.id ? d.b.id : null);
      } else if (g.kind === 'pan') setState({ view: { ...v, x: g.vx + dx, y: g.vy + dy }, touchedView: true });
      else if (g.kind === 'box') {
        setOver({ [g.id]: [Math.round(g.bx + dx / k), Math.round(g.by + dy / k)] });
        const r = svgRef.current!.getBoundingClientRect();
        g.px = (e.clientX - r.left - v.x) / k;
        g.py = (e.clientY - r.top - v.y) / k;
        // the rectangles don't depend on where the box is, so the last frame's will do
        if (!g.prop && !g.grp) setDrop(dropTarget(dispRef.current, g.px, g.py));
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
    if (g.kind === 'row') {
      const d = boxAt(dispRef.current, g.px, g.py);
      setRowDrop(null);
      if (d && !d.b.external && !d.b.ghost && !d.b.group) moveNode(g.id, d.b.block ? d.b.from! : d.b.id);
      return;
    }
    if (g.kind === 'box') {
      const p = o[g.id];
      if (!p) return;
      if (g.prop) {
        moveProposalModule(g.id, p);
        return;
      }
      if (g.grp) {
        movePos({ [g.id]: p });
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
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    const ah = t.closest('[data-area]') as HTMLElement | null;
    const s = getState();
    if (ah && !s.readOnly) {
      const name = ah.dataset.area!;
      const a = s.areas.find((x) => x.name === name);
      const r = disp.areas.find((x) => x.a.name === name)?.r;
      if (a && r) {
        const start = (a.modules ?? [])
          .map((id) => disp.byId.get(id))
          .filter((d): d is DBox => !!d)
          .map((d) => ({ id: d.b.id, x: d.x - (disp.shift.get(d.b.id)?.[0] ?? 0), y: d.y - (disp.shift.get(d.b.id)?.[1] ?? 0) }));
        drag.current = { kind: 'area', name, x: e.clientX, y: e.clientY, start, ax: r.x, ay: r.y, moved: false };
        return;
      }
    }
    // in a proposal, a function dragged onto another module is proposed to move there
    const rn = t.closest('[data-node]') as HTMLElement | null;
    if (rn && !s.readOnly && !s.connectFrom && s.mode === 'propose' && currentProposal(s)) {
      const x = m.node.get(rn.dataset.node!);
      if (x && !x.row.ghost && !x.row.node.external && !x.box.external) {
        drag.current = { kind: 'row', id: x.row.id, x: e.clientX, y: e.clientY, moved: false, px: 0, py: 0 };
        return;
      }
    }
    // an open group moves as one: by its header or any box in it
    const gh = t.closest('[data-ghead]') as HTMLElement | null;
    const mh = t.closest('[data-mod]') as HTMLElement | null;
    const inG = gh ? disp.groups.find((x) => x.g.id === gh.dataset.ghead)?.top : mh ? disp.byId.get(mh.dataset.mod!)?.inG : undefined;
    if ((gh || mh) && !t.closest('[data-add]') && !t.closest('[data-toggle]') && !t.closest('[data-gtoggle]')) {
      const id = inG ?? mh?.dataset.mod;
      const d = id ? disp.byId.get(id) : undefined;
      const at = inG ? disp.groups.find((x) => x.g.id === inG)?.r : d;
      if (id && at && !d?.b.ghost && !s.readOnly) {
        const sh = disp.shift.get(id) ?? [0, 0];
        const grp = isGroup(id);
        drag.current = { kind: 'box', id, prop: !!d?.b.prop, grp, x: e.clientX, y: e.clientY, bx: at.x - sh[0], by: at.y - sh[1], moved: false, px: 0, py: 0 };
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
    const gt = t.closest('[data-gtoggle]') as HTMLElement | null;
    if (gt) {
      toggleExpanded(gt.dataset.gtoggle!);
      return;
    }
    const more = t.closest('[data-more]') as HTMLElement | null;
    if (more) return select(more.dataset.more!);
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
    const gh = t.closest('[data-ghead]') as HTMLElement | null;
    if (gh) return pick(gh.dataset.ghead!);
    const mh = t.closest('[data-mod]') as HTMLElement | null;
    if (mh) return pick(mh.dataset.mod!);
    if (n) return pick(n.dataset.node!);
    setState({ sel: [], form: null, focus: false, splitting: null });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const t = e.target as Element;
    const id = (t.closest('[data-ghead]') as HTMLElement | null)?.dataset.ghead ?? (t.closest('[data-mod]') as HTMLElement | null)?.dataset.mod;
    if (id && isGroup(id) && !t.closest('[data-gtoggle]')) toggleExpanded(id);
  };

  // far-mode names hidden by declutter show while hovered
  const [hov, setHov] = useState<string | null>(null);
  const onPointerOver = (e: React.PointerEvent) => {
    const id = ((e.target as Element).closest('[data-box]') as HTMLElement | null)?.dataset.box ?? null;
    const want = id && disp.byId.get(id)?.far?.hid ? id : null;
    if (want !== hov) setHov(want);
  };
  const hd = hov ? disp.byId.get(hov) : undefined;

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
      onPointerOver={onPointerOver}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      data-zoom={view.k.toFixed(3)}
      data-far={far ? '1' : '0'}
    >
      <defs>{['mk-n', 'mk-h', 'mk-p'].map(mk)}</defs>
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
        {disp.areas.map(({ a, r }) => (
          <AreaG key={a.name} a={a} r={r} sel={sel.includes('area:' + a.name)} drop={drop === a.name} fa={farK ? farArea(farK) : null} />
        ))}
        {disp.groups.map(({ g, r, reveal }) => (
          <GroupC key={g.id} g={g} r={r} reveal={reveal} sel={sel.includes(g.id)} fa={farK ? farArea(farK) : null} />
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
        {far && <FarLabels boxes={shown ? disp.boxes.filter((d) => shown.has(d.b.id)) : disp.boxes} halo={!!G} />}
        {hd?.far?.hid && (
          <text className="mname hovname" x={hd.x + hd.far.px} y={hd.y + hd.far.nb} style={{ fontSize: hd.far.fn, strokeWidth: hd.far.fn * 0.3 }}>
            {hd.far.hid}
          </text>
        )}
        {rowDrop &&
          (() => {
            const d = disp.byId.get(rowDrop);
            return d ? <rect className="rowdrop" x={d.x - 3} y={d.y - 3} width={d.w + 6} height={d.h + 6} rx={10} /> : null;
          })()}
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
        if (p) byId.set(b.id, { b, x: p[0], y: p[1], w: b.w, h: b.defH, fullH: b.defH, rows: b.rows, col: false, more: 0, moreWord: '', open: false, lift: false, sub: b.sub });
      }
      return areaRect(a, byId, pos);
    },
    [m, pos],
  );
}
