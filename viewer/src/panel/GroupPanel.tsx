// A part (a package or folder of code) or a folder of parts: the same shape
// as every panel. What it does is its surface: the entry points and functions
// other parts use, each with what it reaches. A folder lists its parts too.
import type { Model } from '../model';
import { isFolder, type Parts } from '../parts';
import { select, toggleFolder, useStore } from '../store';
import { Section, Head, Tests, Entries, Reach } from './common';
import { Diagram } from './Diagram';
import { entryPointsOf, membersOf } from './connections';

export function GroupPanel({ m, P, id }: { m: Model; P: Parts; id: string }) {
  const folder = isFolder(id);
  const open = useStore((s) => s.open.includes(id));
  const box = m.box.get(id);
  const path = folder ? id.split(':').slice(2).join(':') : (box?.label ?? id);
  const parts = folder ? m.boxes.filter((b) => !b.external && b.label.startsWith(path + '/')) : [];
  const members = membersOf(m, P, id);
  // its surface: entry points, and functions called from outside it
  const surface = [...members].filter((x) => {
    const r = m.node.get(x)?.row;
    if (!r || r.role) return false;
    return r.node.entry || (m.all.inn.get(x) ?? []).some((e) => !members.has(e.from));
  });
  surface.sort((a, b) => Number(!!m.node.get(b)!.row.node.entry) - Number(!!m.node.get(a)!.row.node.entry) || m.node.get(a)!.row.label.localeCompare(m.node.get(b)!.row.label));
  const size = folder ? `${parts.length} parts` : `${members.size} functions`;
  return (
    <>
      <Head eyebrow={(box?.prop ? 'Proposed part' : folder ? 'Folder' : 'Part') + ' · ' + size} plan={box?.prop} title={folder ? path + '/' : path} />
      {box?.doc && <p className="doc">{box.doc}</p>}
      {folder && (
        <div className="btns">
          <button className="btn" id="open-folder" onClick={() => toggleFolder(id)}>
            {open ? 'Fold' : 'Open on the map'}
          </button>
        </div>
      )}
      <Diagram m={m} P={P} id={id} />
      <Section title="What starts it">
        <Entries m={m} ids={entryPointsOf(m, P, id).filter((x) => !members.has(x))} />
      </Section>
      <Section title={`What it does · ${surface.length} used from outside`}>
        <div className="tree">
          {surface.map((x) => {
            const r = m.node.get(x)!.row;
            return (
              <button key={x} className={`trow ${r.prop ? 'prop' : ''}`} data-node={x} onClick={() => select(x)}>
                <span className="l">{r.prefix ? r.prefix + ' ' + r.label : r.label}</span>
                <Reach m={m} fs={m.walk.effects(x)} />
              </button>
            );
          })}
        </div>
      </Section>
      {folder && (
        <Section title={`Parts · ${parts.length}`}>
          <div className="links">
            {parts.map((b) => (
              <button key={b.id} className="lnk" data-node={b.id} onClick={() => select(b.id)}>
                {b.label.slice(path.length + 1)}
              </button>
            ))}
          </div>
        </Section>
      )}
      {!folder && !box?.prop && (
        <Section title="Tests">
          <Tests m={m} ids={surface} />
        </Section>
      )}
    </>
  );
}
