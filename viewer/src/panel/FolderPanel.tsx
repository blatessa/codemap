// A folder of parts on a big map: its parts, what it uses and what uses it,
// and opening it on the map (or folding it again).
import type { Model } from '../model';
import type { Parts } from '../parts';
import { select, toggleFolder, useStore } from '../store';
import { Head, Section } from './common';

export function FolderPanel({ m, P, id }: { m: Model; P: Parts; id: string }) {
  const open = useStore((s) => s.open.includes(id));
  const path = id.split(':').slice(2).join(':');
  const inside = (label: string) => label.startsWith(path + '/');
  const parts = m.boxes.filter((b) => !b.external && inside(b.label));
  // what draws for it: the folder, or once it's open the parts and folders in it
  const mine = new Set(P.items.filter((it) => it.id === id || inside(it.label)).map((it) => it.id));
  const use = new Map<string, string>(),
    dep = new Map<string, string>();
  const label = (t: string) => P.items.find((x) => x.id === t)?.label ?? m.node.get(t)?.row.label ?? t;
  for (const l of P.links) {
    if (mine.has(l.from) && !mine.has(l.to)) dep.set(l.to, label(l.to));
    if (mine.has(l.to) && !mine.has(l.from)) use.set(l.from, label(l.from));
  }
  const list = (map: Map<string, string>) =>
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
      <Head eyebrow="Folder" title={path + '/'} />
      <div className="btns">
        <button className="btn" id="open-folder" onClick={() => toggleFolder(id)}>
          {open ? 'Fold' : 'Open on the map'}
        </button>
      </div>
      <div className="cols">
        <Section title="Used by">{list(use)}</Section>
        <Section title="Depends on">{list(dep)}</Section>
      </div>
      <Section title={`Parts · ${parts.length}`}>
        <div className="links">
          {parts.map((b) => (
            <button key={b.id} className="lnk" data-node={b.id} onClick={() => select(b.id)}>
              {b.label.slice(path.length + 1)}
            </button>
          ))}
        </div>
      </Section>
    </>
  );
}
