// A part: what it uses and what uses it, and what's used from outside it.
import { type Model } from '../model';
import { select } from '../store';
import { Section, Head } from './common';

export function BoxPanel({ m, id }: { m: Model; id: string }) {
  const b = m.box.get(id)!;
  const use = new Map<string, string>(),
    dep = new Map<string, string>();
  // a table, topic or service is named itself, not its group ("database")
  for (const e of m.edges) {
    const a = m.node.get(e.from)!,
      c = m.node.get(e.to)!;
    if (a.box === c.box) continue;
    if (a.box.id === id) c.box.external ? dep.set(c.row.id, c.row.label) : dep.set(c.box.id, c.box.label);
    if (c.box.id === id) a.box.external ? use.set(a.row.id, a.row.label) : use.set(a.box.id, a.box.label);
  }
  const mlist = (map: Map<string, string>) =>
    map.size ? (
      <div className="links">
        {[...map].map(([k, v]) => (
          <button key={k} className="lnk" onClick={() => select(k)}>
            {v}
          </button>
        ))}
      </div>
    ) : (
      <p>—</p>
    );
  return (
    <>
      <Head eyebrow={b.prop ? 'Proposed module' : 'Module'} plan={b.prop} title={b.label} />
      {b.doc && <p className="doc">{b.doc}</p>}
      <div className="cols">
        <Section title="Used by">{mlist(use)}</Section>
        <Section title="Depends on">{mlist(dep)}</Section>
      </div>
      <Section title={`Used from outside · ${b.rows.filter((r) => !r.role && (r.pub || r.node.entry || r.prop)).length} of ${b.rows.length}`}>
        {b.rows.some((r) => !r.role && (r.pub || r.node.entry || r.prop)) ? (
          <div className="links">
            {b.rows.filter((r) => !r.role && (r.pub || r.node.entry || r.prop)).map((r) => (
              <button key={r.id} className={`lnk ${r.prop ? 'prop' : ''}`} data-node={r.id} onClick={() => select(r.id)}>
                {r.prefix ? r.prefix + ' ' + r.label : r.label}
              </button>
            ))}
          </div>
        ) : (
          <p>—</p>
        )}
      </Section>
    </>
  );
}
