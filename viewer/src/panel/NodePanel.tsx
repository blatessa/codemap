// A node: a route, page, job or other entry point; a function; or a table,
// topic or service. Proposal actions sit on top.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Source, Where } from '../Code';
import { Fields } from '../Fields';
import { entriesReaching, onScreen, screenRoot, qn, type MEdge, type Model } from '../model';
import { currentProposal, moveNode, proposeEdge, removeProposalNode, select, storyOf, setState, useSel, useStore } from '../store';
import { Section, Head, NodeLink, EdgeList, Tests, onPath, cap } from './common';
import { CallTree } from './CallTree';
import { ScreenOutline } from './ScreenOutline';

// CallPicker: what a proposed call goes to, found by name.
function CallPicker({ m, from }: { m: Model; from: string }) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length
    ? [...m.node.keys()]
        .filter((x) => x !== from)
        .map((x) => ({ id: x, name: qn(m, x) }))
        .filter((h) => words.every((w) => h.name.toLowerCase().includes(w)))
        .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
        .slice(0, 8)
    : [];
  const pick = (to: string) => {
    proposeEdge(from, to);
    setState({ connectFrom: null });
  };
  return (
    <Section title={`${qn(m, from)} calls…`}>
      <input
        ref={ref}
        id="pick-q"
        className="pick"
        placeholder="Function, table or service"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[0]) pick(hits[0].id);
          if (e.key === 'Escape') setState({ connectFrom: null });
        }}
      />
      <div className="links">
        {hits.map((h) => (
          <button key={h.id} className="lnk" data-pick={h.id} onClick={() => pick(h.id)}>
            {h.name}
          </button>
        ))}
      </div>
    </Section>
  );
}

// MoveTo: the part a proposal moves a function to.
function MoveTo({ m, id, at }: { m: Model; id: string; at: string }) {
  return (
    <select className="pick" id="move-to" aria-label="Move to" value={at} onChange={(e) => moveNode(id, e.target.value)}>
      {m.boxes
        .filter((b) => !b.external && !b.ghost && !b.block)
        .map((b) => (
          <option key={b.id} value={b.id}>
            {b.id === at ? `In ${b.label}` : `Move to ${b.label}`}
          </option>
        ))}
    </select>
  );
}

export function NodePanel({ m, id }: { m: Model; id: string }) {
  const S = useSel();
  const propose = useStore((s) => s.mode === 'propose' && !!currentProposal(s));
  const story = useStore(storyOf);
  const connecting = useStore((s) => s.connectFrom === id);
  const { row, box } = m.node.get(id)!;
  const n = row.node;
  const method = typeof n.fields?.method === 'string' ? (n.fields.method as string).toUpperCase() : '';
  const eyebrow = row.prop ? 'Proposed' : row.ghost ? 'Missing' : n.external || n.entry ? cap(n.kind) : box.label;
  // a page's code calling out of the frontend shows as the page (graph.FoldScreens)
  const inn = (m.all.inn.get(id) ?? []).filter((e) => onScreen(n) || !onScreen(m.node.get(e.from)?.row.node)),
    out = m.all.out.get(id) ?? [];
  let body: ReactNode;
  if (row.ghost) body = null;
  else if (n.external) {
    // sections come from edge types only, never from the node's kind
    const by = (list: MEdge[], t: string) => list.filter((e) => e.type === t);
    const writes = by(inn, 'writes'),
      reads = by(inn, 'reads'),
      pubs = by(inn, 'publishes'),
      subs = by(out, 'subscribes');
    const calledBy = inn.filter((e) => !['writes', 'reads', 'publishes'].includes(e.type));
    const callsUs = out.filter((e) => e.type !== 'subscribes');
    const other = writes.length + reads.length + pubs.length + subs.length;
    body = (
      <>
        <Fields m={m} fields={n.fields} />
        {(writes.length > 0 || reads.length > 0) && (
          <div className="cols">
            <Section title="Writes">
              <EdgeList m={m} edges={writes} end="from" detail />
            </Section>
            <Section title="Reads">
              <EdgeList m={m} edges={reads} end="from" detail />
            </Section>
          </div>
        )}
        {(pubs.length > 0 || subs.length > 0) && (
          <div className="cols">
            <Section title="Published by">
              <EdgeList m={m} edges={pubs} end="from" detail />
            </Section>
            <Section title="Subscribers">
              <EdgeList m={m} edges={subs} end="to" detail />
            </Section>
          </div>
        )}
        {(calledBy.length > 0 || !other) && (
          <Section title="Called by">
            <EdgeList m={m} edges={calledBy} end="from" detail />
          </Section>
        )}
        {callsUs.length > 0 && (
          <Section title="Calls us">
            <EdgeList m={m} edges={callsUs} end="to" detail />
          </Section>
        )}
      </>
    );
  } else if (n.entry) {
    body = (
      <>
        <Fields m={m} fields={n.fields} skip={['method']} />
        {screenRoot(n) && <ScreenOutline m={m} id={id} />}
        {inn.length > 0 && (
          <Section title="Called from">
            <EdgeList m={m} edges={inn} end="from" />
          </Section>
        )}
        <CallTree m={m} id={id} />
        {n.file && n.line ? (
          <Section title="Source">
            <Source file={n.file} from={n.line} to={n.endLine} />
          </Section>
        ) : null}
        {!row.prop && S && (
          <Section title="Tests along this path">
            <Tests m={m} ids={onPath(m, S.down)} />
          </Section>
        )}
      </>
    );
  } else {
    const ents = entriesReaching(m, id);
    body = (
      <>
        <Fields m={m} fields={n.fields} />
        <div className="cols">
          <Section title="Called from">
            <EdgeList m={m} edges={inn} end="from" />
          </Section>
          <Section title="Calls">
            <EdgeList m={m} edges={out} end="to" />
          </Section>
        </div>
        <Section title="Reached by">
          {ents.length ? (
            <div className="links">
              {ents.map((x) => (
                <NodeLink key={x} m={m} id={x} />
              ))}
            </div>
          ) : (
            <span className="chip">Unreachable</span>
          )}
        </Section>
        {n.file && n.line ? (
          <Section title="Source">
            <Source file={n.file} from={n.line} to={n.endLine} />
          </Section>
        ) : null}
        {!row.prop && (
          <Section title="Tests">
            <Tests m={m} ids={[id]} />
          </Section>
        )}
      </>
    );
  }
  return (
    <>
      <Head eyebrow={eyebrow} plan={row.prop} title={method && !row.label.startsWith(method) ? `${method} ${row.label}` : row.label}>
        <Where file={n.file} line={n.line} />
      </Head>
      {story && story !== id && (
        <div className="btns">
          <button className="btn" data-story={story} onClick={() => select(story)}>
            ← {qn(m, story)}
          </button>
          {!n.external && (
            <button className="btn" onClick={() => select(id, true)}>
              Trace from here
            </button>
          )}
        </div>
      )}
      {row.moved && <p className="where plan">Moved here from {row.moved} by the proposal.</p>}
      {n.doc && <p className="doc">{n.doc}</p>}
      {propose && connecting && <CallPicker m={m} from={id} />}
      {propose && !connecting && (
        <div className="btns">
          {!n.external && !row.ghost && (
            <button className="btn primary" onClick={() => setState({ connectFrom: id })}>
              Add a call
            </button>
          )}
          {!n.external && !row.ghost && !box.external && <MoveTo m={m} id={id} at={box.block ? box.from! : box.id} />}
          {row.prop && (
            <button
              className="btn danger"
              onClick={() => {
                removeProposalNode(id);
                select(null);
              }}
            >
              Remove
            </button>
          )}
        </div>
      )}
      {body}
    </>
  );
}
