// The calls a proposal adds to or from a node, as a short list. Clicking one
// opens the same popup that adds a call, filled in, to change or remove it.
import { clampPop } from '../MapPopup';
import { qn, type Model } from '../model';
import type { Parts } from '../parts';
import { currentProposal, getState, setState, useStore } from '../store';
import { Section } from './common';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

// popupNear is where a popup for this node opens: beside it on the map, in the
// map's own pixels, as a click there would.
export function popupNear(P: Parts, id: string) {
  const v = getState().view;
  const a = P.at.get(id) ?? P.at.get(P.itemOf(id));
  return a ? clampPop(v.x + (a.x + a.w) * v.k + 14, v.y + a.y * v.k - 4) : { x: 24, y: 24 };
}

export function ProposedCalls({ m, P, id }: { m: Model; P: Parts; id: string }) {
  const edges = useStore((s) => currentProposal(s)?.edges);
  const mine = (edges ?? []).map((e, i) => ({ e, i })).filter(({ e }) => e.from === id || e.to === id);
  if (!mine.length) return null;
  return (
    <Section title="In the proposal" count={mine.length}>
      <div className="pcalls">
        {mine.map(({ e, i }) => {
          const out = e.from === id;
          const other = String(out ? e.to : e.from);
          const type = str(e.type) || 'calls';
          return (
            <button key={i} className="pcall2" title="Edit this call" onClick={() => setState({ form: { type: 'edge', from: String(e.from), to: String(e.to), edge: i, ...popupNear(P, id) } })}>
              <span className="dv">{out ? (type === 'calls' ? '→' : type) : '←'}</span>
              <span className="nm">{m.node.has(other) ? qn(m, other) : other}</span>
              {str(e.detail) && <span className="q">{str(e.detail)}</span>}
            </button>
          );
        })}
      </div>
    </Section>
  );
}
