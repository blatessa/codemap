// Popups on the map: wiring a proposal where you are looking at it. A part's +
// asks what to add there; while connecting, clicking a part asks which of its
// functions (or a new one), and clicking a table or service asks how it's used.
import { useEffect, useRef, useState } from 'react';
import { qn, type Box, type Model } from './model';
import { currentProposal, editProposalEdge, editProposedNode, proposeEdge, proposeModule, proposeNode, removeProposalEdge, removeProposalNode, select, setState, useStore } from './store';

const KINDS = ['function', 'route', 'page', 'job', 'subscriber', 'command', 'component', 'table', 'topic', 'service'];
const LEAF = ['table', 'topic', 'service']; // nothing to call from these

// commonKind is what a part mostly holds: what a new thing in it probably is.
function commonKind(b?: Box): string {
  const c = new Map<string, number>();
  for (const r of b?.rows ?? []) c.set(r.node.kind, (c.get(r.node.kind) ?? 0) + 1);
  return [...c].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'function';
}

const close = () => setState({ form: null });

// clampPop keeps a popup inside the part of the map you can see: not under the panel.
export function clampPop(x: number, y: number) {
  const map = document.getElementById('map')?.getBoundingClientRect();
  const d = document.getElementById('drawer');
  const panel = d && !d.hidden ? d.offsetWidth : 0;
  const w = (map?.width ?? 1200) - panel;
  const h = map?.height ?? 800;
  return { x: Math.max(8, Math.min(x, w - 290)), y: Math.max(8, Math.min(y, h - 280)) };
}

export function MapPopup({ m }: { m: Model }) {
  const form = useStore((s) => s.form);
  if (!form) return null;
  const key = [form.type, form.box, form.from, form.to, form.edit, form.edge].join('|');
  return (
    <div
      className="mpop"
      style={{ left: form.x, top: form.y }}
      role="dialog"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      {form.type === 'fn' && <AddNode key={key} m={m} box={m.box.get(form.box!)} from={form.from} edit={form.edit} />}
      {form.type === 'mod' && <AddPart key={key} />}
      {form.type === 'target' && <Target key={key} m={m} box={m.box.get(form.box!)} from={form.from!} x={form.x} y={form.y} edge={form.edge} />}
      {form.type === 'edge' && <Use key={key} m={m} from={form.from!} to={form.to!} edge={form.edge} />}
    </div>
  );
}

function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mhd">
      <b>{title}</b>
      {sub && <span>{sub}</span>}
      <button className="x" aria-label="Close" onClick={close}>
        ×
      </button>
    </div>
  );
}

// AddNode: what to put in this part. Type a name and press Enter; the kind is
// what the part mostly holds, changeable in place. Then click what it calls.
function AddNode({ m, box: first, from, edit }: { m: Model; box?: Box; from?: string; edit?: string }) {
  // editing is the same form, filled in with what the proposal already says
  const was = useStore((s) => (edit ? currentProposal(s)?.nodes?.find((n) => n.id === edit) : undefined));
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const [boxId, setBoxId] = useState((was && str(was.module)) || first?.id);
  const box = (boxId && m.box.get(boxId)) || first;
  const [kind, setKind] = useState(str(was?.kind) || commonKind(box));
  const [method, setMethod] = useState(str(was?.method) || 'POST');
  const [name, setName] = useState(str(was?.label));
  const [doc, setDoc] = useState(str(was?.doc));
  const [more, setMore] = useState(!!str(was?.doc));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  if (!box) return null;
  const kinds = KINDS.includes(kind) ? KINDS : [kind, ...KINDS];
  const submit = () => {
    if (!name.trim()) return;
    if (edit) {
      editProposedNode(edit, { kind, label: name.trim(), method: kind === 'route' ? method : '', doc: doc.trim(), module: box.id });
      return close();
    }
    const id = proposeNode(box.id, name.trim(), kind, kind === 'route' ? method : '', box.external, { doc, select: false, from });
    // what does it call? the next thing to click (when dropped from a node, that wiring is done)
    if (id && !from && !LEAF.includes(kind)) setState({ connectFrom: id });
  };
  const enter = (e: React.KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), submit());
  return (
    <>
      <Head title={edit ? 'Edit' : from ? `New, called by ${qn(m, from)}` : 'Add'} sub={edit || from ? undefined : `to ${box.label}`} />
      {(from || edit) && (
        <select aria-label="Part" id="f-part" value={box.id} onChange={(e) => (setBoxId(e.target.value), !edit && setKind(commonKind(m.box.get(e.target.value))))}>
          {m.boxes
            .filter((b) => !b.external && !b.ghost)
            .map((b) => (
              <option key={b.id} value={b.id}>
                in {b.label}
              </option>
            ))}
        </select>
      )}
      <div className="mrow">
        <select aria-label="Kind" id="f-k" className="mkind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        {kind === 'route' && (
          <select aria-label="Method" id="f-m" className="mkind" value={method} onChange={(e) => setMethod(e.target.value)}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        )}
        <input ref={ref} id="f-name" placeholder={kind === 'route' ? '/orders/:id/cancel' : 'Name'} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={enter} />
      </div>
      {more ? (
        <input id="f-doc" placeholder="What it does" autoComplete="off" value={doc} onChange={(e) => setDoc(e.target.value)} onKeyDown={enter} />
      ) : (
        <button className="mlink" onClick={() => setMore(true)}>
          + What it does
        </button>
      )}
      <div className="mfoot">
        {edit ? (
          <button
            className="btn danger sm"
            onClick={() => {
              removeProposalNode(edit);
              select(null);
              close();
            }}
          >
            Delete
          </button>
        ) : (
          <span>{from ? 'Enter to add' : 'Enter to add, then click what it calls'}</span>
        )}
        <button className="btn primary sm" disabled={!name.trim()} onClick={submit}>
          {edit ? 'Save' : 'Add'}
        </button>
      </div>
    </>
  );
}

function AddPart() {
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = () => name.trim() && proposeModule(name.trim());
  return (
    <>
      <Head title="Add a part" />
      <input ref={ref} id="f-name" placeholder="internal/refunds" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <div className="mfoot">
        <span>Enter adds it</span>
        <button className="btn primary sm" onClick={submit}>
          Add
        </button>
      </div>
    </>
  );
}

// Target: `from` calls something in this part. Type to find it, or to name a new one.
function Target({ m, box, from, x, y, edge }: { m: Model; box?: Box; from: string; x: number; y: number; edge?: number }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  if (!box) return null;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = box.rows
    .filter((r) => r.id !== from && words.every((w) => (r.prefix + ' ' + r.label).toLowerCase().includes(w)))
    .sort((a, b) => Number(!!a.role) - Number(!!b.role) || a.label.localeCompare(b.label))
    .slice(0, 8);
  const kind = commonKind(box);
  const items = [...rows.map((r) => ({ id: r.id, text: (r.prefix ? r.prefix + ' ' : '') + r.label, ext: r.node.external })), ...(q.trim() ? [{ id: '', text: `New ${kind} “${q.trim()}”`, ext: box.external }] : [])];
  const cur = Math.min(at, Math.max(items.length - 1, 0));
  const pick = (i: number) => {
    const it = items[i];
    if (!it) return;
    let to = it.id;
    // pointing an existing call somewhere else replaces it
    const wire = (id: string) => (edge != null ? editProposalEdge(edge, { to: id, type: 'calls' }) : proposeEdge(from, id));
    if (!to) {
      const id = proposeNode(box.id, q.trim(), kind, kind === 'route' ? 'GET' : '', box.external, { select: false });
      if (!id) return;
      to = id;
      if (!box.external) wire(id);
    } else if (!it.ext) wire(to);
    // data and services say how: reads or writes, and what query
    if (it.ext) setState({ form: { type: 'edge', from, to, edge, x, y } });
    else close();
  };
  return (
    <>
      <Head title={`${qn(m, from)} calls`} sub={`in ${box.label}`} />
      <input
        ref={ref}
        id="t-q"
        placeholder={box.external ? 'Find one, or name a new one' : 'Find a function, or name a new one'}
        autoComplete="off"
        value={q}
        onChange={(e) => (setQ(e.target.value), setAt(0))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.preventDefault(), pick(cur));
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setAt((cur + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(items.length, 1));
          }
        }}
      />
      <div className="mlist">
        {items.map((it, i) => (
          <button key={it.id || 'new'} className={`${i === cur ? 'on' : ''} ${it.id ? '' : 'mk'}`} data-pick={it.id || undefined} onMouseEnter={() => setAt(i)} onClick={() => pick(i)}>
            {it.id ? it.text : '+ ' + it.text}
          </button>
        ))}
        {!items.length && <p className="none">Nothing here yet. Type a name to add one.</p>}
      </div>
    </>
  );
}

// Use: how `from` uses a table, topic or service. Also changes or removes a call
// the proposal already adds (`edge`).
function Use({ m, from, to, edge }: { m: Model; from: string; to: string; edge?: number }) {
  const was = useStore((s) => (edge != null ? currentProposal(s)?.edges?.[edge] : undefined));
  const kind = m.node.get(to)?.row.node.kind ?? '';
  const had = typeof was?.type === 'string' ? was.type : 'calls';
  const types = kind === 'table' ? ['reads', 'writes'] : kind === 'topic' ? ['publishes'] : had !== 'calls' ? [had] : ['calls'];
  const [type, setType] = useState(edge != null && types.includes(had) ? had : kind === 'table' ? 'writes' : types[0]);
  const [detail, setDetail] = useState(typeof was?.detail === 'string' ? was.detail : '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = () => {
    if (edge != null) editProposalEdge(edge, { to, type, detail: detail.trim() });
    else proposeEdge(from, to, type, detail);
    close();
  };
  return (
    <>
      <Head title={qn(m, from)} sub={`→ ${qn(m, to)}`} />
      {types.length > 1 && (
        <div className="seg sm" role="group" aria-label="How">
          {types.map((t) => (
            <button key={t} aria-pressed={type === t} onClick={() => setType(t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      <input ref={ref} id="e-detail" placeholder={kind === 'table' ? 'The query (optional)' : 'Detail (optional)'} autoComplete="off" value={detail} onChange={(e) => setDetail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <div className="mfoot">
        {edge != null ? (
          <button
            className="btn danger sm"
            onClick={() => {
              removeProposalEdge(edge);
              close();
            }}
          >
            Remove
          </button>
        ) : (
          <span>Enter to add</span>
        )}
        <button className="btn primary sm" onClick={submit}>
          {edge != null ? 'Save' : 'Add'}
        </button>
      </div>
    </>
  );
}

// ConnectPill says the map is waiting for a click: what the selected thing calls.
export function ConnectPill({ m }: { m: Model }) {
  const from = useStore((s) => s.connectFrom);
  const open = useStore((s) => !!s.form);
  if (!from || open) return null;
  return (
    <div className="cpill">
      Click what <b>{m.node.has(from) ? qn(m, from) : from}</b> calls
      <button className="x" aria-label="Done" onClick={() => setState({ connectFrom: null })}>
        Done
      </button>
    </div>
  );
}
