// A part (a package or folder of code) or a folder of parts. Its Interface is
// what other parts use: entry points and functions called from outside, each
// with what it reaches and the entry points that come through it. A folder
// lists its parts too.
import { useState } from 'react';
import type { Model } from '../model';
import { isFolder, type Parts } from '../parts';
import { select, toggleFolder, useStore } from '../store';
import { Section, Head, Tests, Entries } from './common';
import { Tree } from './CallTree';
import { Diagram } from './Diagram';
import { membersOf } from './connections';

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
  return (
    <>
      <Head kind={box?.prop ? 'Proposed part' : folder ? `Folder · ${parts.length} parts` : 'Part'} plan={box?.prop} title={folder ? path + '/' : path} />
      {box?.doc && <p className="doc">{box.doc}</p>}
      {folder && (
        <div className="btns">
          <button className="btn" id="open-folder" onClick={() => toggleFolder(id)}>
            {open ? 'Fold' : 'Open on the map'}
          </button>
        </div>
      )}
      <Diagram m={m} P={P} id={id} />
      <Section title="Interface">
        {surface.length ? (
          <div className="itable">
            {surface.map((x) => (
              <IRow key={x} m={m} id={x} members={members} />
            ))}
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
          <Tests m={m} ids={[...members].filter((x) => !m.node.get(x)?.row.role)} />
        </Section>
      )}
    </>
  );
}

// IRow is one function other parts use: its name, the entry points that come
// through it, and, opened, its flow as a tree.
function IRow({ m, id, members }: { m: Model; id: string; members: Set<string> }) {
  const [open, setOpen] = useState(false);
  const r = m.node.get(id)!.row;
  const via = r.node.entry ? [] : m.walk.entries(id).filter((e) => !members.has(e));
  return (
    <div className={`irow ${r.prop ? 'prop' : ''} ${open ? 'open' : ''}`}>
      <div className="ihead">
        <button className="itog" aria-label={open ? 'Hide its flow' : 'Show its flow'} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
        <button className="iname" data-node={id} onClick={() => select(id)}>
          {r.prefix ? r.prefix + ' ' + r.label : r.label}
        </button>
      </div>
      {via.length > 0 && (
        <div className="ivia">
          <Entries m={m} ids={via} max={3} />
        </div>
      )}
      {open && (
        <div className="iflow">
          <Tree m={m} id={id} />
        </div>
      )}
    </div>
  );
}
