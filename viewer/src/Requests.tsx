// Change requests on a proposal (PLAN.md §6.1): the request form and the
// checklist under a proposal's document.
import { useEffect, useMemo, useRef, useState } from 'react';
import { qn, type Model } from './model';
import { compare } from './revs';
import {
  currentProposal,
  getState,
  itemStatus,
  moveItem,
  openItem,
  patchItem,
  removeItem,
  saveRequest,
  setState,
  useStore,
  type ReqDraft,
} from './store';
import type { Item, Proposal } from './types';

export const KINDS = ['change', 'add', 'remove', 'move', 'rename', 'test', 'question'];
const STATUSES = ['open', 'done', 'wontfix'] as const;

export function targetLabel(m: Model, t?: string): string {
  if (!t) return '';
  const i = t.indexOf(' -> ');
  if (i > 0) return `${targetLabel(m, t.slice(0, i))} → ${targetLabel(m, t.slice(i + 4))}`;
  if (m.node.has(t)) return qn(m, t);
  if (m.box.has(t)) return m.box.get(t)!.label;
  return t.replace(/^new:/, '');
}

const range = (l?: number[]) => (l && l.length ? (l[l.length - 1] > l[0] ? `${l[0]}-${l[l.length - 1]}` : `${l[0]}`) : '');

export function RequestForm({ m }: { m: Model }) {
  const d = useStore((s) => s.req)!;
  const cur = useStore(currentProposal);
  const all = useStore((s) => s.proposals);
  const open = useMemo(() => all.filter((p) => p.status === 'open'), [all]);
  const [kind, setKind] = useState(d.kind);
  const [text, setText] = useState(d.text ?? '');
  const [to, setTo] = useState(d.to ?? '');
  const [reply, setReply] = useState(d.reply ?? '');
  const [pick, setPick] = useState(open[0]?.slug ?? '');
  const [pname, setPname] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const mods = m.boxes.filter((b) => !b.ghost && !b.group).sort((a, b) => a.label.localeCompare(b.label));
  const save = () => {
    const next: ReqDraft = { ...d, kind, text: text.trim(), to: kind === 'move' || kind === 'rename' ? to.trim() : undefined, reply: d.id ? reply.trim() : undefined };
    saveRequest(next, cur ? {} : pick ? { slug: pick } : { name: pname });
  };
  const ok = !!text.trim() || (kind === 'move' && !!to) || (kind === 'rename' && !!to.trim());
  return (
    <div
      style={{ display: 'contents' }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ok) save();
        if (e.key === 'Escape') setState({ req: null });
      }}
    >
      <div className="dhead">
        <div>
          <p className="eyebrow plan">{d.id ? `Request ${d.id}` : 'Request'}</p>
          <h2>{targetLabel(m, d.target) || d.file}</h2>
          {d.file && d.lines && (
            <div className="where">
              {d.file}:{range(d.lines)}
            </div>
          )}
        </div>
        <button className="x" aria-label="Close" onClick={() => setState({ req: null })}>
          ×
        </button>
      </div>
      {d.quote && <pre className="rquote">{d.quote}</pre>}
      {!cur && (
        <label className="field">
          Proposal
          <select id="r-prop" value={pick} onChange={(e) => setPick(e.target.value)}>
            {open.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
            <option value="">New proposal…</option>
          </select>
          {!pick && <input id="r-pname" placeholder="Name" autoComplete="off" value={pname} onChange={(e) => setPname(e.target.value)} />}
        </label>
      )}
      <div className="seg sm kinds" role="group" aria-label="Kind" id="r-kind">
        {KINDS.map((k) => (
          <button key={k} aria-pressed={kind === k} data-kind={k} onClick={() => setKind(k)}>
            {k}
          </button>
        ))}
      </div>
      {kind === 'move' && (
        <label className="field">
          To
          <select id="r-to" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">—</option>
            {mods.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === 'rename' && (
        <label className="field">
          New name
          <input id="r-to" autoComplete="off" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      )}
      <label className="field">
        Request
        <textarea id="r-text" ref={ref} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {d.id && (
        <label className="field">
          Reply
          <textarea id="r-reply" value={reply} onChange={(e) => setReply(e.target.value)} />
        </label>
      )}
      <div className="btns">
        <button className="btn primary" id="r-save" disabled={!ok} onClick={save}>
          Save
        </button>
        <button className="btn" onClick={() => setState({ req: null })}>
          Cancel
        </button>
        {d.id && cur && (
          <button
            className="btn danger"
            onClick={() => {
              removeItem(cur.slug, d.id!);
              setState({ req: null });
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// goTo selects an item's target and scrolls the code to its lines.
function goTo(it: Item) {
  const t = it.target ?? '';
  const l = it.anchor?.lines ?? it.lines;
  const file = it.anchor?.file ?? it.file;
  setState({
    sel: t ? [t] : [],
    centerOn: t && !t.includes(' -> ') ? t : null,
    focusLines: file && l?.length ? { file, a: l[0], b: l[l.length - 1], seq: (getState().focusLines?.seq ?? 0) + 1 } : null,
    req: null,
  });
}

export async function seeChanges(it: Item) {
  if (!it.rev) return;
  await compare(it.rev, 'worktree');
  if (it.target) setState({ mode: 'explore', sel: [it.target], centerOn: it.target.includes(' -> ') ? null : it.target });
}

function ItemRow({ m, p, it, first, last }: { m: Model; p: Proposal; it: Item; first: boolean; last: boolean }) {
  const st = itemStatus(it);
  const stale = it.anchor?.stale;
  return (
    <div className={`ritem ${st}`} data-item={it.id}>
      <div className="rhead">
        <span className="kind">{it.kind}</span>
        <button className="rt lnk" onClick={() => goTo(it)} title="Show on the map">
          {targetLabel(m, it.target) || it.file}
          {it.to && <span className="q">→ {it.kind === 'move' ? targetLabel(m, it.to) : it.to}</span>}
        </button>
        <div className="seg sm rst" role="group" aria-label="Status">
          {STATUSES.map((s) => (
            <button key={s} aria-pressed={st === s} aria-label={`Mark ${s}`} data-status={s} onClick={() => st !== s && patchItem(p.slug, it.id, { status: s })}>
              {s === 'wontfix' ? "won't" : s}
            </button>
          ))}
        </div>
      </div>
      {(it.anchor?.file || it.file) && (
        <div className={`rloc ${stale ? 'stale' : ''}`}>
          {it.anchor?.file ?? it.file}
          {range(it.anchor?.lines ?? it.lines) && ':' + range(it.anchor?.lines ?? it.lines)}
          {stale && ' · stale'}
        </div>
      )}
      {it.text && <p className="rtext">{it.text}</p>}
      {it.reply && <p className="rreply">{it.reply}</p>}
      <div className="racts">
        {st === 'done' && it.rev && (
          <button className="btn sm" data-see={it.id} onClick={() => void seeChanges(it)}>
            See changes
          </button>
        )}
        <button className="ib" aria-label="Revise request" data-edit={it.id} onClick={() => openItem(it.id)}>
          ✎
        </button>
        <button className="ib" aria-label="Move up" disabled={first} onClick={() => moveItem(p.slug, it.id, -1)}>
          ↑
        </button>
        <button className="ib" aria-label="Move down" disabled={last} onClick={() => moveItem(p.slug, it.id, 1)}>
          ↓
        </button>
        <button className="ib" aria-label="Delete" onClick={() => removeItem(p.slug, it.id)}>
          ×
        </button>
      </div>
    </div>
  );
}

export function Checklist({ m, p }: { m: Model; p: Proposal }) {
  const items = p.items ?? [];
  if (!items.length) return null;
  const open = items.filter((x) => itemStatus(x) === 'open').length;
  return (
    <div id="checklist">
      <p className="eyebrow">
        Requests · {open}/{items.length}
      </p>
      {STATUSES.map((s) => {
        const list = items.filter((x) => itemStatus(x) === s);
        if (!list.length) return null;
        return (
          <div key={s} className="rgroup" data-group={s}>
            {s !== 'open' && <p className="rglabel">{s === 'done' ? 'Done' : "Won't fix"}</p>}
            {list.map((it) => {
              const i = items.indexOf(it);
              return <ItemRow key={it.id} m={m} p={p} it={it} first={i === 0} last={i === items.length - 1} />;
            })}
          </div>
        );
      })}
    </div>
  );
}

// RequestButton opens the form for a target, here or (without a proposal) in a new one.
export function RequestButton({ target, kind = 'change', label = 'Request a change…', id }: { target: string; kind?: string; label?: string; id?: string }) {
  const ro = useStore((s) => s.readOnly);
  if (ro) return null;
  return (
    <button className="btn sm req" id={id} onClick={() => setState({ req: { kind, target } })}>
      {label}
    </button>
  );
}
