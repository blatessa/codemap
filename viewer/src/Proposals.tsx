// Propose mode panels: the proposals list and one proposal's document and changes.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArchivedBase } from './Compare';
import { Checklist } from './Requests';
import { qn, type Model } from './model';
import { currentProposal, newProposal, removeProposalEdge, removeProposalModule, removeProposalNode, setState, updateProposal, useStore } from './store';
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
            <button key={p.slug} className="pitem" data-slug={p.slug} onClick={() => setState({ pslug: p.slug, editing: false, sel: [] })}>
              <span className="pn">{p.name}</span>
              <span className="pm">
                <span className={`pill ${p.status}`}>{p.status}</span>
                {p.pr && <span>{p.pr}</span>}
                <span>{changes(p)} changes</span>
                {(p.items?.length ?? 0) > 0 && (
                  <span className="rcount">
                    {(p.items ?? []).filter((x) => x.status !== 'done' && x.status !== 'wontfix').length}/{p.items!.length} requests
                  </span>
                )}
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
  const name = (id: string) => (m.node.has(id) ? qn(m, id) : id.replace(/^new:/, ''));
  const items = [
    ...(p.modules ?? []).map((x) => ({ kind: 'module', label: str(x.label) || str(x.id), rm: () => removeProposalModule(str(x.id)) })),
    ...(p.nodes ?? []).map((x) => ({
      kind: x.entry ? 'entry' : x.external ? 'external' : 'function',
      label: name(str(x.id)),
      rm: () => removeProposalNode(str(x.id)),
    })),
    ...(p.edges ?? []).map((x, i) => ({ kind: 'call', label: `${name(str(x.from))} → ${name(str(x.to))}`, rm: () => removeProposalEdge(i) })),
  ];
  return (
    <>
      <button className="back" onClick={() => setState({ pslug: null, editing: false })}>
        ← Proposals
      </button>
      <input
        className="ptitle"
        id="p-name"
        ref={title}
        value={p.name}
        autoComplete="off"
        aria-label="Proposal name"
        onChange={(e) => updateProposal(p.slug, { name: e.target.value })}
        onBlur={(e) => !e.target.value.trim() && updateProposal(p.slug, { name: 'Untitled' })}
      />
      <div className="meta">
        <span className={`pill ${p.status}`}>{p.status}</span>
        {p.pr && <span>{p.pr}</span>}
        {p.updated && <span>Updated {fmtDate(p.updated)}</span>}
      </div>
      <div>
        <div className="dochead">
          <p className="eyebrow">Document</p>
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
      </div>
      <Checklist m={m} p={p} />
      <div>
        <p className="eyebrow">Changes · {items.length}</p>
        <div className="items">
          {items.map((it, i) => (
            <div className="item" key={i}>
              <span className="kind">{it.kind}</span>
              <span>{it.label}</span>
              <button aria-label="Remove" onClick={it.rm}>
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
      {p.status === 'archived' ? (
        <div className="btns">
          <span className="arch">Closed by {p.pr || '—'}</span>
          <ArchivedBase />
          <button className="btn" onClick={() => updateProposal(p.slug, { status: 'open' })}>
            Reopen
          </button>
        </div>
      ) : (
        <div>
          <p className="eyebrow">Archive</p>
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
        </div>
      )}
    </>
  );
}
