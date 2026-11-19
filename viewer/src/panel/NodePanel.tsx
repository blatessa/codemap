// A node: a route, page, job or other entry point; a function; or a table,
// topic or service. Every panel has the same shape: what it is, how it
// connects (the diagram), what starts it, what it does, then its source and
// tests. Proposal actions sit under the heading.
import { useState, type ReactNode } from 'react';
import { Source } from '../Code';
import { ChangedCalls } from '../Compare';
import { edgeChanges, nodeStatus, useCompare } from '../revs';
import { Fields } from '../Fields';
import { screenRoot, qn, type MEdge, type Model } from '../model';
import type { Parts } from '../parts';
import { currentProposal, moveNode, removeProposalNode, select, setState, useSel, useStore } from '../store';
import { Section, Head, Tests, onPath, Entries, cap, FileLink } from './common';
import { CallTree } from './CallTree';
import { ScreenOutline } from './ScreenOutline';
import { Diagram } from './Diagram';
import { entryPointsOf } from './connections';
import { CallPicker } from './CallPicker';

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
  // comparing: what this node gained or lost between the two sides
  const cmp = useCompare((c) => c.diff);
  const status = cmp ? nodeStatus(id) : '';
  const ch = cmp ? edgeChanges(id) : null;
  const nch = ch ? ch.outAdded.length + ch.outRemoved.length + ch.inAdded.length + ch.inRemoved.length : 0;
  // named as on the map: "POST /orders", "PAGE /checkout", a table in its colour
  const title = row.prefix ? `${row.prefix} ${row.label}` : row.label;
  const entries = !n.entry && !n.external && !row.ghost ? entryPointsOf(m, P, id) : [];
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
      <Head
        kind={
          <>
            {(row.ghost ? 'Missing ' : row.prop ? 'Proposed ' : status ? cap(status) + ' ' : '') + (row.ghost || status ? n.kind : cap(n.kind))}
            {n.file ? (
              <>
                <span className="ksep">·</span>
                <FileLink file={n.file} line={n.line} />
              </>
            ) : !n.external && !row.ghost ? (
              <span className="ksep">· {box.label}</span>
            ) : null}
          </>
        }
        plan={row.prop || row.ghost}
        diff={status ? status.slice(0, 3) : undefined}
        title={title}
        cls={row.tagClass || (n.entry ? 'entry' : 'fn')}
      >
      </Head>
      {row.moved && <p className="where plan">Moved here from {row.moved} by the proposal.</p>}
      {n.doc && <p className="doc">{n.doc}</p>}
      {ch && (status || nch > 0) && (
        <Section title="Changes" count={nch || undefined}>
          {status === 'removed' && <p className="none">Gone in the new version; this is how it was.</p>}
          {status === 'changed' && !nch && <p className="none">Its code changed; its calls didn’t.</p>}
          {ch.outAdded.length + ch.outRemoved.length > 0 && (
            <div className="chgroup">
              <p className="eyebrow">Now calls</p>
              <ChangedCalls m={m} added={ch.outAdded} removed={ch.outRemoved} />
            </div>
          )}
          {ch.inAdded.length + ch.inRemoved.length > 0 && (
            <div className="chgroup">
              <p className="eyebrow">Now used by</p>
              <ChangedCalls m={m} added={ch.inAdded} removed={ch.inRemoved} side="from" />
            </div>
          )}
        </Section>
      )}
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
          <Entries m={m} ids={entries} max={12} />
        </Section>
      )}
      {does}
      <Fields m={m} fields={n.fields} skip={['method', 'source']} />
      {Array.isArray(n.fields?.source) && <p className="none from">Defined in {(n.fields!.source as string[]).join(', ')}</p>}
      {!n.external && n.file && n.line ? (
        <Section title="Source">
          <Source file={n.file} from={n.line} to={n.endLine} on={id} />
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

// what a table, topic or service is used by, a section per kind of use
const USES: [string, string][] = [
  ['writes', 'Writes'],
  ['reads', 'Reads'],
  ['publishes', 'Published by'],
  ['calls', 'Called by'],
  ['fetches', 'Fetched by'],
  ['renders', 'Shown by'],
];

// Uses is what a table, topic or service is used by, a section per kind of
// use (Writes, Reads, Published by, Called by): one row per function, its
// query or call on one line, and the entry points that come through it. Then,
// for a topic or webhook, what it runs.
function Uses({ m, id }: { m: Model; id: string }) {
  const inn = m.all.inn.get(id) ?? [],
    out = m.all.out.get(id) ?? [];
  const by = new Map<string, MEdge[]>();
  for (const e of inn) {
    const k = e.type + '\0' + e.from;
    (by.get(k) ?? by.set(k, []).get(k)!).push(e);
  }
  const rows = [...by.values()].sort((a, b) => qn(m, a[0].from).localeCompare(qn(m, b[0].from)));
  const known = new Set(USES.map(([t]) => t));
  return (
    <>
      {!rows.length && (
        <Section title="Uses">
          <p className="none">Nothing uses it</p>
        </Section>
      )}
      {USES.map(([t, title]) => {
        const mine = rows.filter((es) => es[0].type === t);
        return mine.length ? (
          <Section key={t} title={title}>
            <div className="itable">
              {mine.map((es) => (
                <UseRow key={es[0].from} m={m} es={es} />
              ))}
            </div>
          </Section>
        ) : null;
      })}
      {rows.some((es) => !known.has(es[0].type)) && (
        <Section title="Other uses">
          <div className="itable">
            {rows
              .filter((es) => !known.has(es[0].type))
              .map((es) => (
                <UseRow key={es[0].type + es[0].from} m={m} es={es} />
              ))}
          </div>
        </Section>
      )}
      {out.length > 0 && (
        <Section title="Runs">
          <div className="itable">
            {out.map((e) => (
              <div key={e.i} className="irow">
                <div className="ihead">
                  <span className="uverb">{e.type === 'subscribes' ? 'handled by' : 'calls'}</span>
                  <button className="iname" data-node={e.to} onClick={() => select(e.to)}>
                    {qn(m, e.to)}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function UseRow({ m, es }: { m: Model; es: MEdge[] }) {
  const [wrap, setWrap] = useState(false);
  const e = es[0];
  const f = m.node.get(e.from)?.row.node;
  const via = f?.entry ? [] : m.walk.entries(e.from);
  const details = [...new Set(es.map((x) => x.detail).filter((d): d is string => !!d))];
  return (
    <div className="irow">
      <div className="ihead">
        <button className="iname" data-node={e.from} onClick={() => select(e.from)}>
          {qn(m, e.from)}
        </button>
      </div>
      {details.map((d) => (
        <div key={d} className={`uq ${wrap ? 'wrap' : ''}`} title={wrap ? undefined : d} onClick={() => setWrap(!wrap)}>
          {d}
        </div>
      ))}
      {via.length > 0 && (
        <div className="ivia">
          <Entries m={m} ids={via} max={3} />
        </div>
      )}
    </div>
  );
}
