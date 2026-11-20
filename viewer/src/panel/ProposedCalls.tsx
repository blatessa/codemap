// The calls a proposal adds to or from a node, as a short list. Clicking one
// opens the same popup that adds a call, filled in, to change or remove it.
import { qn, type Model } from '../model';
import { currentProposal, setState, useStore } from '../store';
import { Section } from './common';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function ProposedCalls({ m, id }: { m: Model; id: string }) {
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
            <button key={i} className="pcall2" title="Edit this call" onClick={() => setState({ form: { type: 'edge', from: String(e.from), to: String(e.to), edge: i, anchor: id } })}>
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
