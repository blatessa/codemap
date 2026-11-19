// The connection diagram at the top of every panel: what calls into the
// selected thing on the left, the thing in the middle, what it calls out to on
// the right. Opening a connection lists the calls behind it.
import { useState } from 'react';
import { qn, type MEdge, type Model } from '../model';
import type { LinkKind, Parts } from '../parts';
import { select } from '../store';
import { connectionsOf, selfLabel, type Conn } from './connections';
import { Section } from './common';

const ROW = 30;
const VERB: Record<LinkKind, string> = { calls: 'calls', http: 'HTTP', event: 'event', reads: 'reads', writes: 'writes', shows: 'shows' };

export function Diagram({ m, P, id }: { m: Model; P: Parts; id: string }) {
  const { inn, out } = connectionsOf(m, P, id);
  const [open, setOpen] = useState<string | null>(null);
  if (!inn.length && !out.length) return null;
  const rows = Math.max(inn.length, out.length, 1);
  const H = rows * ROW;
  const top = (n: number, i: number) => (H - n * ROW) / 2 + i * ROW;
  const me = selfLabel(m, P, id);
  const key = (side: string, c: Conn) => side + c.thing;
  const shown = [...inn.map((c) => ['in', c] as const), ...out.map((c) => ['out', c] as const)].find(([s, c]) => key(s, c) === open);
  const chip = (side: 'in' | 'out', c: Conn, i: number, n: number) => (
    <button
      key={key(side, c)}
      className={`dchip ${c.cls} ${open === key(side, c) ? 'on' : ''}`}
      data-node={c.thing}
      data-conn={side + ':' + c.thing}
      style={{ top: top(n, i), [side === 'in' ? 'left' : 'right']: 0 }}
      title={`${c.label} · ${c.kinds.map((k) => VERB[k]).join(', ')} · ${c.calls.length}`}
      onClick={() => setOpen(open === key(side, c) ? null : key(side, c))}
    >
      <span className="dl">{c.short}</span>
      <span className="dn">{c.calls.length}</span>
    </button>
  );
  const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
  return (
    <Section title="Connections">
      <div className="diagram" style={{ height: H }}>
        <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {inn.map((c, i) => (
            <path key={'i' + c.thing} className={`dline k-${c.kinds[0]}`} d={curve(33, top(inn.length, i) + 13, 38.5, H / 2)} />
          ))}
          {out.map((c, i) => (
            <path key={'o' + c.thing} className={`dline k-${c.kinds[0]}`} d={curve(61.5, H / 2, 67, top(out.length, i) + 13)} />
          ))}
        </svg>
        {inn.map((c, i) => chip('in', c, i, inn.length))}
        <div className={`dme ${me.cls}`} style={{ top: H / 2 - 13 }} title={me.label}>
          {me.short}
        </div>
        {out.map((c, i) => chip('out', c, i, out.length))}
      </div>
      {shown && <Calls m={m} side={shown[0]} c={shown[1]} />}
    </Section>
  );
}

// Calls lists the calls behind one connection, deduplicated, with their SQL or
// API detail, and opens the thing at the other end.
function Calls({ m, side, c }: { m: Model; side: 'in' | 'out'; c: Conn }) {
  const seen = new Set<string>();
  const list: MEdge[] = [];
  for (const e of c.calls) {
    const k = e.from + '\0' + e.to + '\0' + e.type;
    if (!seen.has(k)) (seen.add(k), list.push(e));
  }
  return (
    <div className="dcalls" id="conn-calls">
      <div className="dchead">
        <span>{side === 'in' ? `${c.label} → this` : `this → ${c.label}`}</span>
        <button className="lnk" data-node={c.thing} onClick={() => select(c.thing)}>
          Open
        </button>
      </div>
      {list.map((e) => (
        <div key={e.i} className="dcall">
          <button className="lnk" data-node={e.from} onClick={() => select(e.from)}>
            {qn(m, e.from)}
          </button>
          <span className="dv">{e.type === 'calls' ? '→' : e.type}</span>
          <button className="lnk" data-node={e.to} onClick={() => select(e.to)}>
            {qn(m, e.to)}
          </button>
          {e.detail && <span className="q">{e.detail}</span>}
        </div>
      ))}
    </div>
  );
}
