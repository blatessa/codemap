import { effectSummary, isEffect, onScreen, type Effect, type Model } from '../model';
import { select } from '../store';
import { Section } from './common';

// ScreenOutline: what you can do on a screen. Its components, nested as they
// render, keeping only those that lead somewhere past the frontend; each says
// what it reaches, once per thing reached, with the handlers and hooks doing
// it named together ("CompareControl · view, go → fetches GET /api/state").
export function ScreenOutline({ m, id }: { m: Model; id: string }) {
  const node = (x: string) => m.node.get(x)?.row.node;
  const part = (x: string) => onScreen(node(x));
  const comp = (x: string) => node(x)?.kind === 'component';
  // what x's own code (not the components it shows) reaches past the frontend
  const reaches = (x: string): Effect[] => {
    const got = new Map<string, Effect>(),
      seen = new Set([x]),
      q = [x];
    while (q.length) {
      const y = q.shift()!;
      for (const e of m.all.out.get(y) ?? []) {
        if (isEffect(m, e) && !part(e.to)) got.set(e.type + '\0' + e.to, { to: e.to, type: e.type });
        else if ((e.type === 'calls' || e.type === 'renders') && part(e.to) && !comp(e.to) && !seen.has(e.to)) {
          seen.add(e.to);
          q.push(e.to);
        }
      }
    }
    return [...got.values()];
  };
  type Line = { id: string; depth: number; acts: string[]; fs: Effect[] };
  const lines: Line[] = [];
  const seen = new Set<string>();
  // walk adds c's lines and its children's, and reports whether any of it reaches something
  const walk = (c: string, depth: number, show: boolean): boolean => {
    const at = lines.length;
    // its handlers and hooks, grouped by what they reach
    const by = new Map<string, Line>();
    for (const e of [...(m.all.out.get(c) ?? [])].sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) {
      if (!part(e.to) || comp(e.to)) continue;
      const fs = reaches(e.to);
      if (!fs.length) continue;
      const k = fs.map((f) => f.type + f.to).sort().join('|');
      const l = node(e.to)!.label;
      const name = l.startsWith(node(c)!.label + '.') ? l.slice(node(c)!.label.length + 1) : l;
      const x = by.get(k);
      if (x) x.acts.includes(name) || x.acts.push(name);
      else by.set(k, { id: e.to, depth: depth + (show ? 1 : 0), acts: [name], fs });
    }
    if (show) lines.push({ id: c, depth, acts: [], fs: [] });
    lines.push(...by.values());
    let any = by.size > 0;
    for (const e of [...(m.all.out.get(c) ?? [])].sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) {
      if (!part(e.to) || !comp(e.to) || seen.has(e.to)) continue;
      seen.add(e.to);
      if (walk(e.to, depth + (show ? 1 : 0), true)) any = true;
    }
    if (!any) lines.length = at; // shows nothing that leads anywhere
    return any;
  };
  seen.add(id);
  // a page renders its component: that component is the page
  const own = (m.all.out.get(id) ?? []).filter((e) => e.type === 'renders' && part(e.to) && comp(e.to));
  if (own.length === 1) {
    seen.add(own[0].to);
    walk(own[0].to, 0, false);
  }
  walk(id, 0, false);
  if (!lines.length) return null;
  return (
    <Section title="Screen">
      <div className="tree">
        {lines.map((r, i) =>
          r.acts.length ? (
            <button key={i} className="trow" data-node={r.id} style={{ paddingLeft: 6 + r.depth * 14 }} onClick={() => select(r.id, true)}>
              <span className="l">
                <span className="m">{r.acts.join(', ')}</span>
                <span className="act">→ {effectSummary(m, r.fs)}</span>
              </span>
            </button>
          ) : (
            <button key={i} className="trow" data-node={r.id} style={{ paddingLeft: 6 + r.depth * 14 }} onClick={() => select(r.id, true)}>
              <span className="l">{node(r.id)!.label}</span>
            </button>
          ),
        )}
      </div>
    </Section>
  );
}
