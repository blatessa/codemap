// Propose mode panels: the proposals list and one proposal's document and changes.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { qn, type MEdge, type Model, type Row } from './model';
import { currentProposal, newProposal, removeProposalEdge, renameProposal, removeProposalModule, removeProposalNode, select, setState, updateProposal, useStore } from './store';
import { Section } from './panel/common';
import { NotesList } from './Notes';
import type { Proposal } from './types';

const fmtDate = (s?: string) => {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  return isNaN(+d) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const excerpt = (s: string) => (s || '').replace(/[#>*`_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
const changes = (p: Proposal) => (p.modules?.length ?? 0) + (p.nodes?.length ?? 0) + (p.edges?.length ?? 0);

export function ProposalList() {
  const proposals = useStore((s) => s.proposals);
  const L = useStore((s) => s.plist);
  const setL = (patch: Partial<typeof L>) => setState({ plist: { ...L, ...patch } });
  const q = L.q.trim().toLowerCase();
  const rows = proposals
    .filter((p) => (L.status === 'all' || p.status === L.status) && (!q || (p.name + ' ' + p.body).toLowerCase().includes(q)))
    .sort((a, b) =>
      L.sort === 'name'
        ? a.name.localeCompare(b.name)
        : L.sort === 'status'
          ? a.status.localeCompare(b.status) || (b.updated ?? '').localeCompare(a.updated ?? '')
          : (b.updated ?? '').localeCompare(a.updated ?? ''),
    );
  return (
    <>
      <div className="dhead">
        <div>
          <p className="eyebrow plan">Proposals</p>
        </div>
        <button className="btn primary sm" onClick={newProposal}>
          New
        </button>
      </div>
      <div className="plctl">
        <input id="pl-q" type="search" placeholder="Search proposals" value={L.q} autoComplete="off" aria-label="Search proposals" onChange={(e) => setL({ q: e.target.value })} />
        <select id="pl-sort" aria-label="Sort" value={L.sort} onChange={(e) => setL({ sort: e.target.value as typeof L.sort })}>
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
          <option value="status">Status</option>
        </select>
      </div>
      <div className="seg sm" role="group" aria-label="Status">
        {(['all', 'open', 'archived'] as const).map((s) => (
          <button key={s} aria-pressed={L.status === s} onClick={() => setL({ status: s })}>
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <div className="plist" id="plist">
        {rows.length ? (
          rows.map((p) => (
            <button key={p.slug} className="pitem" data-slug={p.slug} onClick={() => setState({ pslug: p.slug, editing: false, sel: null })}>
              <span className="pn">{p.name}</span>
              <span className="pm">
                <span className={`pill ${p.status}`}>{p.status}</span>
                {p.pr && <span>{p.pr}</span>}
                <span>{changes(p)} changes</span>
                <span>{fmtDate(p.updated)}</span>
              </span>
              {p.body && <span className="px">{excerpt(p.body)}</span>}
            </button>
          ))
        ) : (
          <p>No proposals match.</p>
        )}
      </div>
    </>
  );
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text || '', { async: false }) as string), [text]);
  if (!text.trim()) return <div className="md"><p>Empty.</p></div>;
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// ProposalView is one proposal, shaped like the other panels: what it is, then
// its document, its changes grouped by the part they go in (as the map shows
// them), and archiving it. Every name opens its own panel.
export function ProposalView({ m }: { m: Model }) {
  const p = useStore(currentProposal);
  const editing = useStore((s) => s.editing);
  const [pr, setPr] = useState('');
  const title = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (p && p.name === 'Untitled' && !p.body) {
      title.current?.focus();
      title.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.slug]);
  if (!p) return null;
  const groups = changeGroups(m);
  const count = changes(p);
  // the proposal's own index of an edge, to remove it
  const edgeIndex = (e: MEdge) => (p.edges ?? []).findIndex((x) => str(x.from) === e.from && str(x.to) === e.to && (str(x.type) || 'calls') === e.type);
  return (
    <>
      <div className="dhead">
        <div>
          <div className="kind plan">
            <i />
            Proposal · {p.status}
            {p.pr && ` · ${p.pr}`}
            {p.updated && ` · ${fmtDate(p.updated)}`}
          </div>
          <input
            className="ptitle"
            id="p-name"
            ref={title}
            value={p.name}
            autoComplete="off"
            aria-label="Proposal name"
            onChange={(e) => updateProposal(p.slug, { name: e.target.value })}
            onBlur={(e) => {
              if (!e.target.value.trim()) updateProposal(p.slug, { name: 'Untitled' });
              void renameProposal(p.slug);
            }}
          />
        </div>
        <button className="x" aria-label="Back to the proposals" title="Back to the proposals" onClick={() => setState({ pslug: null, editing: false })}>
          ×
        </button>
      </div>
      <Section title="Document">
        <div className="docbar">
          <button
            className="btn sm"
            onClick={() => {
              setState({ editing: !editing });
              if (!editing) setTimeout(() => body.current?.focus(), 0);
            }}
          >
            {editing ? 'Done' : 'Edit'}
          </button>
        </div>
        {editing ? (
          <textarea
            className="mdedit"
            id="p-body"
            ref={body}
            aria-label="Proposal document"
            placeholder="Markdown"
            value={p.body}
            onChange={(e) => updateProposal(p.slug, { body: e.target.value })}
          />
        ) : (
          <Markdown text={p.body} />
        )}
      </Section>
      <Section title="Notes" count={p.notes?.length || undefined}>
        <NotesList m={m} notes={p.notes ?? []} />
      </Section>
      <Section title="Changes" count={count || undefined}>
        {groups.length ? (
          <div className="pgroups">
            {groups.map((g) => (
              <div key={g.id} className="pgroup">
                <div className="pghead">
                  <button className={`iname ${g.prop ? 'plan' : ''}`} data-node={g.id} onClick={() => (g.ghost ? null : select(g.id))}>
                    {g.label}
                  </button>
                  {g.prop && <span className="ptag">new part</span>}
                  {g.ghost && <span className="ptag">not in the code</span>}
                  {g.prop && (
                    <button className="prm" aria-label="Remove" title="Remove from the proposal" onClick={() => removeProposalModule(g.id)}>
                      ×
                    </button>
                  )}
                </div>
                {g.rows.map(({ row, calls }) => (
                  <div key={row.id} className="pchange">
                    <div className="pcrow">
                      <span className="pmark">{row.prop ? '+' : row.moved ? '↳' : '·'}</span>
                      <button className={`iname ${row.prop || row.moved ? 'plan' : ''} ${row.tagClass}`} data-node={row.id} onClick={() => select(row.id)}>
                        {(row.prefix ? row.prefix + ' ' : '') + row.label}
                      </button>
                      {row.moved && <span className="ptag">from {row.moved}</span>}
                      {(row.prop || row.moved) && (
                        <button className="prm" aria-label="Remove" title={row.moved ? 'Undo the move' : 'Remove from the proposal'} onClick={() => removeProposalNode(row.id)}>
                          ×
                        </button>
                      )}
                    </div>
                    {calls.map((e) => (
                      <div key={e.i} className="pcall">
                        <span className="dv">{e.type === 'calls' ? '→' : e.type}</span>
                        <button className="lnk" data-node={e.to} onClick={() => select(e.to)}>
                          {qn(m, e.to)}
                        </button>
                        {e.detail && <span className="q">{e.detail}</span>}
                        <button className="prm" aria-label="Remove" title="Remove from the proposal" onClick={() => edgeIndex(e) >= 0 && removeProposalEdge(edgeIndex(e))}>
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="none">Nothing yet. Open a part on the map and add to it with +.</p>
        )}
      </Section>
      {p.status === 'archived' ? (
        <Section title="Archive">
          <div className="btns">
            <span className="arch">Closed by {p.pr || '—'}</span>
            <button className="btn" onClick={() => updateProposal(p.slug, { status: 'open' })}>
              Reopen
            </button>
          </div>
        </Section>
      ) : (
        <Section title="Archive">
          <div className="archrow">
            <input id="p-pr" placeholder="PR #" autoComplete="off" aria-label="Pull request" value={pr} onChange={(e) => setPr(e.target.value)} />
            <button
              className="btn"
              onClick={() => {
                updateProposal(p.slug, { status: 'archived', pr: pr.trim() || undefined });
                setPr('');
              }}
            >
              Archive
            </button>
          </div>
        </Section>
      )}
    </>
  );
}

interface Group {
  id: string;
  label: string;
  prop: boolean;
  ghost: boolean;
  rows: { row: Row; calls: MEdge[] }[];
}

// changeGroups is what the open proposal changes, by the part (or group of
// tables, topics, services) it lands in, in the map's order: proposed and
// moved things, and existing code that gains a call, each with its new calls.
function changeGroups(m: Model): Group[] {
  const out: Group[] = [];
  for (const b of m.boxes) {
    const rows = b.rows
      .map((row) => ({ row, calls: (m.all.out.get(row.id) ?? []).filter((e) => e.prop) }))
      .filter(({ row, calls }) => row.prop || row.moved || calls.length > 0);
    // a proposed table, topic or service with nothing of its own still shows
    if (rows.length || b.prop) out.push({ id: b.id, label: b.label, prop: b.prop, ghost: b.ghost && b.id === 'missing:', rows });
  }
  // resources last, as on the map
  return out.sort((a, b) => Number(!!m.box.get(a.id)?.external) - Number(!!m.box.get(b.id)?.external));
}
