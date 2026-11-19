// A node: a route, page, job or other entry point; a function; or a table,
// topic or service. Every panel has the same shape: what it is, how it
// connects (the diagram), what starts it, what it does, then its source and
// tests. Proposal actions sit under the heading.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Source, Where } from '../Code';
import { Fields } from '../Fields';
import { screenRoot, qn, type MEdge, type Model } from '../model';
import type { Parts } from '../parts';
import { currentProposal, moveNode, proposeEdge, removeProposalNode, select, setState, useSel, useStore } from '../store';
import { Section, Head, Tests, onPath, Crumbs, Entries, facts, plural } from './common';
import { CallTree } from './CallTree';
import { ScreenOutline } from './ScreenOutline';
import { Diagram } from './Diagram';
import { entryPointsOf } from './connections';

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
        .filter((b) => !b.external && !b.ghost)
        .map((b) => (
          <option key={b.id} value={b.id}>
            {b.id === at ? `In ${b.label}` : `Move to ${b.label}`}
          </option>
        ))}
    </select>
  );
}

export function NodePanel({ m, P, id }: { m: Model; P: Parts; id: string }) {
  const S = useSel();
  const propose = useStore((s) => s.mode === 'propose' && !!currentProposal(s));
  const connecting = useStore((s) => s.connectFrom === id);
  const { row, box } = m.node.get(id)!;
  const n = row.node;
  const method = typeof n.fields?.method === 'string' ? (n.fields.method as string).toUpperCase() : '';
  // what it is, and a line of facts: where code lives; who uses data
  const kind = row.ghost ? 'missing' : (row.prop ? 'proposed ' : '') + n.kind;
  const inn = m.all.inn.get(id) ?? [];
  const count = (t: string) => new Set(inn.filter((e) => e.type === t).map((e) => e.from)).size;
  const entries = !n.entry && !n.external && !row.ghost ? entryPointsOf(m, P, id) : [];
  const summary = n.external
    ? facts(count('writes') > 0 && `written by ${plural(count('writes'), 'function')}`, count('reads') > 0 && `read by ${plural(count('reads'), 'function')}`, count('publishes') > 0 && `published by ${plural(count('publishes'), 'function')}`, count('calls') > 0 && `called by ${plural(count('calls'), 'function')}`)
    : facts(!row.ghost && box.label, entries.length > 0 && plural(entries.length, 'entry point'));
  let does: ReactNode = null;
  if (n.external) does = <Uses m={m} id={id} />;
  else if (!row.ghost)
    does = (
      <>
        {screenRoot(n) && <ScreenOutline m={m} id={id} />}
        <CallTree m={m} id={id} />
      </>
    );
  return (
    <>
      <Head kind={kind} plan={row.prop} title={method && !row.label.startsWith(method) ? `${method} ${row.label}` : row.label} summary={summary}>
        <Where file={n.file} line={n.line} />
      </Head>
      <Crumbs m={m} id={id} />
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
          {!n.external && !row.ghost && !box.external && <MoveTo m={m} id={id} at={box.id} />}
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
      {!row.ghost && <Diagram m={m} P={P} id={id} />}
      {!row.ghost && !n.entry && !n.external && (
        <Section title="Entry points" count={entries.length || undefined}>
          <Entries m={m} ids={entries} />
        </Section>
      )}
      {does}
      <Fields m={m} fields={n.fields} skip={['method']} />
      {!n.external && n.file && n.line ? (
        <Section title="Source">
          <Source file={n.file} from={n.line} to={n.endLine} />
        </Section>
      ) : null}
      {!row.prop && !row.ghost && (
        <Section title="Tests">
          <Tests m={m} ids={n.entry && S ? onPath(m, S.down) : [id]} />
        </Section>
      )}
    </>
  );
}

const USE_VERB: Record<string, string> = { writes: 'writes', reads: 'reads', publishes: 'publishes', calls: 'calls', fetches: 'fetches', renders: 'shows' };

// Uses is what a table, topic or service is used for: by entry point, the
// code that writes, reads, publishes or calls it, with the query or call;
// then, for a topic or webhook, what it runs.
function Uses({ m, id }: { m: Model; id: string }) {
  const inn = m.all.inn.get(id) ?? [],
    out = m.all.out.get(id) ?? [];
  const by = new Map<string, MEdge[]>();
  for (const e of inn) {
    const f = m.node.get(e.from)?.row.node;
    const ents = f?.entry ? [e.from] : m.walk.entries(e.from);
    for (const x of ents.length ? ents : ['']) (by.get(x) ?? by.set(x, []).get(x)!).push(e);
  }
  const groups = [...by].sort(([a], [b]) => (a ? 0 : 1) - (b ? 0 : 1) || qn(m, a).localeCompare(qn(m, b)));
  return (
    <>
      <Section title="Uses">
        {groups.length ? (
          <div className="uses">
            {groups.map(([ent, es]) => (
              <div key={ent} className="use">
                {ent ? (
                  <button className="ent" data-node={ent} onClick={() => select(ent)}>
                    {qn(m, ent)}
                  </button>
                ) : (
                  <span className="none">No entry point</span>
                )}
                {es.map((e) => (
                  <div key={e.i} className="dcall">
                    <button className="lnk" data-node={e.from} onClick={() => select(e.from)}>
                      {qn(m, e.from)}
                    </button>
                    <span className="dv">{USE_VERB[e.type] ?? e.type}</span>
                    {e.detail && <span className="q">{e.detail}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="none">Nothing uses it</p>
        )}
      </Section>
      {out.length > 0 && (
        <Section title="Runs">
          <div className="uses">
            {out.map((e) => (
              <div key={e.i} className="dcall">
                <span className="dv">{e.type === 'subscribes' ? 'handled by' : 'calls'}</span>
                <button className="lnk" data-node={e.to} onClick={() => select(e.to)}>
                  {qn(m, e.to)}
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
