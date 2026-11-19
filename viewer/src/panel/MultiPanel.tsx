// Several things selected at once.
import { qn, type Model } from '../model';
import { splitBlock, toggleMulti } from '../store';
import { Head } from './common';

export function MultiPanel({ m, ids }: { m: Model; ids: string[] }) {
  const name = (id: string) => (m.node.has(id) ? qn(m, id) : m.box.get(id)?.label ?? id);
  const fnIds = ids.filter((id) => m.node.has(id));
  const srcs = new Set(fnIds.map((id) => m.node.get(id)!.box.id));
  const src = srcs.size === 1 ? m.node.get(fnIds[0])!.box : null;
  const own = src ? src.rows.filter((r) => !r.prop && !r.ghost) : [];
  const canSplit =
    !!src && fnIds.length === ids.length && !src.block && !src.prop && !src.ghost && fnIds.every((id) => !m.node.get(id)!.row.prop) && own.length > fnIds.length;
  return (
    <>
      <Head eyebrow="Selection" title={`${ids.length} selected`} />
      <div className="items">
        {ids.map((id) => (
          <div className="item" key={id}>
            <span>{name(id)}</span>
            <button aria-label="Deselect" onClick={() => toggleMulti(id)}>
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="btns">
        {canSplit && (
          <button
            className="btn"
            onClick={() =>
              splitBlock(
                src!.id,
                fnIds.map((x) => m.node.get(x)!.row.node.label),
                (src!.label.split('/').pop() ?? src!.label) + ' · new',
              )
            }
          >
            Split into a new block
          </button>
        )}
      </div>
    </>
  );
}
