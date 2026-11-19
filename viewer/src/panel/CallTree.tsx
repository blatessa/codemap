// The call tree below a node: graph.Trace, with each call's effects on one line.
import { effectSummary, isEffect, screenRoot, trace, type TreeRow, qn, shortMod, type Model } from '../model';
import { select } from '../store';
import { Section, kindClass } from './common';

// A call tree's effects read as one line per call: "reads save, task,
// workspace", with the query on hover, instead of a row per table with the SQL
// repeated.
type Item = { kind: 'row'; r: TreeRow } | { kind: 'eff'; type: string; ids: string[]; detail?: string; depth: number; action?: string };
function items(m: Model, rows: TreeRow[]): Item[] {
  const out: Item[] = [];
  for (const r of rows) {
    if (!r.targets && isEffect(m, r.via)) {
      const last = out[out.length - 1];
      if (last?.kind === 'eff' && last.depth === r.depth && last.type === r.via.type && last.detail === r.via.detail) {
        if (!last.ids.includes(r.id)) last.ids.push(r.id);
        continue;
      }
      // a page's calls name what on the screen makes them (graph.FoldScreens)
      const action = screenRoot(m.node.get(r.via.from)?.row.node) ? r.via.detail : undefined;
      out.push({ kind: 'eff', type: r.via.type, ids: [r.id], detail: r.via.detail, depth: r.depth, action });
      continue;
    }
    out.push({ kind: 'row', r });
  }
  return out;
}

export function CallTree({ m, id }: { m: Model; id: string }) {
  const t = trace(m, id);
  if (!t.rows.length && !t.reaches.length) return null;
  const verb = (type: string) => (type === 'renders' ? 'shows' : type);
  return (
    <Section title="Call tree">
      <div className="tree">
        {t.reaches.length > 0 && (
          <div className="trow sup">
            <span className="reach">→ {effectSummary(m, t.reaches)}</span>
          </div>
        )}
        {items(m, t.rows).map((it, i) => {
          if (it.kind === 'eff') {
            return (
              <div key={i} className="trow eff" style={{ paddingLeft: 6 + Math.min(it.depth, 12) * 14 }} title={it.detail}>
                <span className="l">
                  └
                  {it.action && <span>{it.action}</span>}
                  <span className={kindClass(m, it.ids[0])}>
                    {verb(it.type)}{' '}
                    {it.ids.map((x, j) => (
                      <span key={x}>
                        {j ? ', ' : ''}
                        <button className="effn" data-node={x} onClick={() => select(x)}>
                          {((r) => (r ? (r.prefix ? r.prefix + ' ' : '') + r.label : x))(m.node.get(x)?.row)}
                        </button>
                      </span>
                    ))}
                  </span>
                </span>
              </div>
            );
          }
          const r = it.r;
          const pad = { paddingLeft: 6 + Math.min(r.depth, 12) * 14 };
          if (r.targets) {
            const names = new Set(r.targets.map((x) => m.node.get(x)?.row.label.split('.').pop() ?? x));
            const method = names.size === 1 ? [...names][0] : 'a function value';
            return (
              <div key={i} className="trow wide sup" style={pad} title={r.targets.map((x) => qn(m, x)).join('\n')}>
                <span className="l">
                  └<span>{method}</span>
                  <span className="seen">{r.targets.length} implementations</span>
                </span>
              </div>
            );
          }
          const x = m.node.get(r.id)!;
          return (
            <button key={i} className={`trow ${x.row.prop || r.via.prop ? 'prop' : ''}`} data-node={r.id} style={pad} onClick={() => select(r.id)} title={r.via.detail}>
              <span className="l">
                └
                <span>
                  <span className="m">{shortMod(m, r.id)}</span>
                  {x.row.prefix ? x.row.prefix + ' ' + x.row.label : x.row.label}
                </span>
                {r.support > 0 && <span className="seen" title={`${r.support} helper call${r.support === 1 ? '' : 's'} not shown`}>+{r.support}</span>}
                {r.more && <span className="seen" title="Calls more: select it to see">…</span>}
              </span>
              {r.reaches.length > 0 && <span className="reach">→ {effectSummary(m, r.reaches)}</span>}
            </button>
          );
        })}
      </div>
    </Section>
  );
}
