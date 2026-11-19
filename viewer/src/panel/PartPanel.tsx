// A part (module or block): what it uses and what uses it, and splitting it.
import { useState } from 'react';
import { type Model } from '../model';
import { mergeBlock, renameBlock, select, setState, splitBlock, useStore } from '../store';
import { Section, Head } from './common';

export function BoxPanel({ m, id }: { m: Model; id: string }) {
  const b = m.box.get(id)!;
  const splitting = useStore((s) => s.splitting === id);
  const use = new Map<string, string>(),
    dep = new Map<string, string>();
  for (const e of m.edges) {
    const a = m.node.get(e.from)!.box,
      c = m.node.get(e.to)!.box;
    if (a === c) continue;
    if (a.id === id) dep.set(c.id, c.label);
    if (c.id === id) use.set(a.id, a.label);
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
  const own = b.rows.filter((r) => !r.prop && !r.ghost);
  const src = b.from ? m.box.get(b.from) : undefined;
  return (
    <>
      <Head eyebrow={b.prop ? 'Proposed module' : 'Module'} plan={b.prop} title={b.label}>
        {src && <div className="where">split from {src.label}</div>}
      </Head>
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
      {b.block ? (
        <>
          <label className="field">
            Name
            <input id="s-rename" defaultValue={b.label} autoComplete="off" onChange={(e) => renameBlock(id, e.target.value || 'Untitled')} />
          </label>
          <div className="btns">
            <button className="btn" onClick={() => mergeBlock(id)}>
              Merge back
            </button>
          </div>
        </>
      ) : !b.prop && !b.ghost && own.length > 1 ? (
        splitting ? (
          <SplitForm
            rows={own.map((r) => ({ id: r.id, label: r.prefix && r.node.fields?.method ? r.prefix + ' ' + r.label : r.label }))}
            defName={(b.label.split('/').pop() ?? b.label) + ' · '}
            onSplit={(ids, name) =>
              splitBlock(
                id,
                ids.map((x) => m.node.get(x)!.row.node.label),
                name,
              )
            }
          />
        ) : (
          <div className="btns">
            <button className="btn" onClick={() => setState({ splitting: id })}>
              Split…
            </button>
          </div>
        )
      ) : null}
    </>
  );
}

function SplitForm({ rows, defName, onSplit }: { rows: { id: string; label: string }[]; defName: string; onSplit: (ids: string[], name: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState(defName);
  const ok = picked.length > 0 && picked.length < rows.length && name.trim() !== '';
  return (
    <div className="addnote">
      <p className="eyebrow">Split out</p>
      {rows.map((r) => (
        <label key={r.id} className="chk">
          <input
            type="checkbox"
            value={r.id}
            checked={picked.includes(r.id)}
            onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))}
          />
          {r.label}
        </label>
      ))}
      <label className="field">
        Name
        <input id="s-name" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="btns">
        <button className="btn primary" disabled={!ok} onClick={() => ok && onSplit(picked, name.trim())}>
          Split
        </button>
        <button className="btn" onClick={() => setState({ splitting: null })}>
          Cancel
        </button>
      </div>
    </div>
  );
}
