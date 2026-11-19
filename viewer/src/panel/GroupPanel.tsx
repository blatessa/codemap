// A part (a package or folder of code) or a folder of parts. Its Interface is
// what other parts use: entry points and functions called from outside, each
// with what it reaches and the entry points that come through it. A folder
// lists its parts too.
import type { Model } from '../model';
import { isFolder, type Parts } from '../parts';
import { select, toggleFolder, useStore } from '../store';
import { Section, Head, Tests, Entries, Fx, facts, plural } from './common';
import { Diagram } from './Diagram';
import { connectionsOf, entryPointsOf, membersOf } from './connections';

export function GroupPanel({ m, P, id }: { m: Model; P: Parts; id: string }) {
  const folder = isFolder(id);
  const open = useStore((s) => s.open.includes(id));
  const box = m.box.get(id);
  const path = folder ? id.split(':').slice(2).join(':') : (box?.label ?? id);
  const parts = folder ? m.boxes.filter((b) => !b.external && b.label.startsWith(path + '/')) : [];
  const members = membersOf(m, P, id);
  const surface = [...members].filter((x) => {
    const r = m.node.get(x)?.row;
    if (!r || r.role) return false;
    return r.node.entry || (m.all.inn.get(x) ?? []).some((e) => !members.has(e.from));
  });
  const isEntry = (x: string) => !!m.node.get(x)!.row.node.entry;
  surface.sort((a, b) => Number(isEntry(b)) - Number(isEntry(a)) || m.node.get(a)!.row.label.localeCompare(m.node.get(b)!.row.label));
  const entries = entryPointsOf(m, P, id);
  const tables = connectionsOf(m, P, id).out.filter((c) => c.cls === 'db').length;
  const summary = facts(
    folder ? plural(parts.length, 'part') : plural(members.size, 'function'),
    surface.length > 0 && `${surface.length} used by other parts`,
    entries.length > 0 && plural(entries.length, 'entry point'),
    tables > 0 && `uses ${plural(tables, 'table')}`,
  );
  return (
    <>
      <Head kind={box?.prop ? 'proposed part' : folder ? 'folder' : 'part'} plan={box?.prop} title={folder ? path + '/' : path} summary={summary} />
      {box?.doc && <p className="doc">{box.doc}</p>}
      {folder && (
        <div className="btns">
          <button className="btn" id="open-folder" onClick={() => toggleFolder(id)}>
            {open ? 'Fold' : 'Open on the map'}
          </button>
        </div>
      )}
      <Diagram m={m} P={P} id={id} />
      <Section title="Interface" count={surface.length ? `${surface.length} of ${members.size}` : undefined}>
        {surface.length ? (
          <div className="itable">
            {surface.map((x) => {
              const r = m.node.get(x)!.row;
              const via = r.node.entry ? [] : m.walk.entries(x).filter((e) => !members.has(e));
              return (
                <div key={x} className={`irow ${r.prop ? 'prop' : ''}`}>
                  <div className="ihead">
                    <button className="iname" data-node={x} onClick={() => select(x)}>
                      {r.prefix ? r.prefix + ' ' + r.label : r.label}
                    </button>
                    <Fx m={m} fs={m.walk.effects(x)} />
                  </div>
                  {via.length > 0 && (
                    <div className="ivia">
                      <Entries m={m} ids={via} max={3} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="none">Nothing outside uses it</p>
        )}
      </Section>
      {folder && (
        <Section title="Parts" count={parts.length}>
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
