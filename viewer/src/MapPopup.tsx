// Popups on the map: sketching a proposal where you are looking at it.
//
// Everything on the map is an object with a few properties, and a popup edits them,
// the way a design tool's inspector does:
//   a node  has a part, a kind and a name        (add it, or click it to change it)
//   a call  has a from, a to, and how it's used  (drag its end, or click it to change it)
// Changes to something that exists apply as you make them. Delete is always there.
import { useState, type ReactNode } from 'react';
import { qn, type Box, type Model } from './model';
import { currentProposal, getState, editProposalEdge, editProposedNode, proposeEdge, proposeModule, proposeNode, removeProposalEdge, removeProposalNode, select, setState, useParts, useStore } from './store';

const KINDS = ['function', 'route', 'page', 'job', 'subscriber', 'command', 'component', 'table', 'topic', 'service'];
const LEAF = ['table', 'topic', 'service']; // nothing to call from these
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const str = (v: unknown) => (typeof v === 'string' ? v : '');

// commonKind is what a part mostly holds: what a new thing in it probably is.
function commonKind(b?: Box): string {
  const c = new Map<string, number>();
  for (const r of b?.rows ?? []) c.set(r.node.kind, (c.get(r.node.kind) ?? 0) + 1);
  return [...c].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'function';
}

const close = () => setState({ form: null });

const POP_W = 340; // a popup's width

// visibleWidth is how much of the map the panel leaves.
function visibleWidth() {
  const map = document.getElementById('map')?.getBoundingClientRect();
  const d = document.getElementById('drawer');
  return (map?.width ?? 1200) - (d && !d.hidden ? d.offsetWidth : 0);
}

// clampPop keeps a popup inside the part of the map you can see: not under the panel.
export function clampPop(x: number, y: number) {
  const h = document.getElementById('map')?.getBoundingClientRect().height ?? 800;
  return { x: Math.max(8, Math.min(x, visibleWidth() - POP_W - 8)), y: Math.max(8, Math.min(y, h - 300)) };
}

// where carries a popup's place on to the next popup: beside the same node, or at the same point.
const where = (f: { anchor?: string; gx?: number; gy?: number; x?: number; y?: number }) => ({ anchor: f.anchor, gx: f.gx, gy: f.gy, x: f.x, y: f.y });

export function MapPopup({ m }: { m: Model }) {
  const form = useStore((s) => s.form);
  const view = useStore((s) => s.view);
  const P = useParts();
  if (!form) return null;
  const key = [form.type, form.box, form.from, form.to, form.edit, form.edge, form.edges?.join(',')].join('|');
  // beside the node it is about (so it moves with it), or at the point on the map where it was asked for
  const a = form.anchor ? (P.at.get(form.anchor) ?? P.at.get(P.itemOf(form.anchor))) : undefined;
  // to its right, or its left when the panel leaves no room
  const right = a ? view.x + (a.x + a.w) * view.k + 14 : 0;
  const left = a ? view.x + a.x * view.k - POP_W - 14 : 0;
  const raw = a
    ? { x: right + POP_W > visibleWidth() && left >= 8 ? left : right, y: view.y + a.y * view.k - 4 }
    : form.gx != null
      ? { x: view.x + form.gx * view.k + 10, y: view.y + form.gy! * view.k + 10 }
      : { x: form.x ?? 24, y: form.y ?? 24 };
  const at = clampPop(raw.x, raw.y);
  return (
    <div
      className="mpop"
      style={{ left: at.x, top: at.y, width: POP_W }}
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
      {form.type === 'fn' && (form.edit ? <EditNode key={key} m={m} id={form.edit} /> : <AddNode key={key} m={m} box={m.box.get(form.box!)} from={form.from} />)}
      {form.type === 'mod' && <AddPart key={key} />}
      {form.type === 'target' && <Target key={key} m={m} box={m.box.get(form.box!)} from={form.from!} at={where(form)} edge={form.edge} />}
      {form.type === 'edge' && (form.edge != null ? <EditCall key={key} m={m} edge={form.edge} /> : <AddCall key={key} m={m} from={form.from!} to={form.to!} />)}
      {form.type === 'edges' && <Calls key={key} m={m} list={form.edges ?? []} at={where(form)} />}
    </div>
  );
}

// ---- pieces ----

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

// Field is a captioned control. A group of buttons gets a plain caption: a <label> around
// buttons would name the first of them after the whole group.
function Field({ label, children, group }: { label: string; children: ReactNode; group?: boolean }) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className="mfield">
      <span>{label}</span>
      {children}
    </Tag>
  );
}

// Foot is a popup's one row of actions: the dangerous one apart, on the left.
function Foot({ onDelete, children }: { onDelete?: () => void; children: ReactNode }) {
  return (
    <div className="mfoot">
      {onDelete ? (
        <button className="btn danger sm" onClick={onDelete}>
          Delete
        </button>
      ) : (
        <span />
      )}
      <div className="mact">{children}</div>
    </div>
  );
}

// Pick chooses one thing on the map by name: shows the current one, and a search when clicked.
function Pick({ m, value, onPick, skip, noExternal, label }: { m: Model; value: string; onPick: (id: string) => void; skip?: string; noExternal?: boolean; label: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = open
    ? [...m.node.keys()]
        .filter((id) => id !== skip && (!noExternal || !m.node.get(id)!.row.node.external))
        .map((id) => ({ id, name: qn(m, id) }))
        .filter((h) => words.every((w) => h.name.toLowerCase().includes(w)))
        .sort((a, b) => Number(b.id.startsWith('new:')) - Number(a.id.startsWith('new:')) || a.name.length - b.name.length || a.name.localeCompare(b.name))
        .slice(0, 7)
    : [];
  const cur = Math.min(at, Math.max(hits.length - 1, 0));
  const choose = (id: string) => (setOpen(false), setQ(''), id !== value && onPick(id));
  if (!open)
    return (
      <button className="mpick" aria-label={label} onClick={() => setOpen(true)}>
        <span>{m.node.has(value) ? qn(m, value) : value}</span>
        <i>⌄</i>
      </button>
    );
  return (
    // leaving it (a click anywhere else, Tab) closes it, so only one is ever open
    <div className="mpicking" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <input
        autoFocus
        aria-label={label}
        placeholder={m.node.has(value) ? qn(m, value) : 'Search by name'}
        autoComplete="off"
        value={q}
        onChange={(e) => (setQ(e.target.value), setAt(0))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[cur]) (e.preventDefault(), choose(hits[cur].id));
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setAt((cur + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % Math.max(hits.length, 1));
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      <div className="mlist">
        {hits.map((h, i) => (
          <button key={h.id} className={i === cur ? 'on' : ''} data-pick={h.id} onMouseEnter={() => setAt(i)} onClick={() => choose(h.id)}>
            {h.name}
          </button>
        ))}
        {!hits.length && <p className="none">{q ? 'Nothing by that name.' : 'Type a name.'}</p>}
      </div>
    </div>
  );
}

// partsOf is the parts of the code a node can live in.
const partsOf = (m: Model) => m.boxes.filter((b) => !b.external && !b.ghost);

function KindFields({ kind, method, onKind, onMethod }: { kind: string; method: string; onKind: (k: string) => void; onMethod: (m: string) => void }) {
  const kinds = KINDS.includes(kind) ? KINDS : [kind, ...KINDS];
  return (
    <div className="mgrid">
      <Field label="Kind">
        <select id="f-k" value={kind} onChange={(e) => onKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </Field>
      {kind === 'route' && (
        <Field label="Method">
          <select id="f-m" value={method} onChange={(e) => onMethod(e.target.value)}>
            {METHODS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}

// ---- a node ----

// AddNode: what to put in this part. Type a name and press Enter; then click what it calls.
function AddNode({ m, box: first, from }: { m: Model; box?: Box; from?: string }) {
  const [boxId, setBoxId] = useState(first?.id);
  const box = (boxId && m.box.get(boxId)) || first;
  const [kind, setKind] = useState(commonKind(box));
  const [method, setMethod] = useState('POST');
  const [name, setName] = useState('');
  if (!box) return null;
  const submit = () => {
    if (!name.trim()) return;
    const id = proposeNode(box.id, name.trim(), kind, kind === 'route' ? method : '', box.external, { select: false, from });
    // what does it call? the next thing to click (when dropped from a node, that wiring is done)
    if (id && !from && !LEAF.includes(kind)) setState({ connectFrom: id });
  };
  return (
    <>
      <Head title={from ? 'New, called by ' + qn(m, from) : 'Add to ' + box.label} />
      {from && (
        <Field label="Part">
          <select id="f-part" value={box.id} onChange={(e) => (setBoxId(e.target.value), setKind(commonKind(m.box.get(e.target.value))))}>
            {partsOf(m).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <KindFields kind={kind} method={method} onKind={setKind} onMethod={setMethod} />
      <Field label="Name">
        <input autoFocus id="f-name" placeholder={kind === 'route' ? '/orders/:id/cancel' : 'Service.Cancel'} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), submit())} />
      </Field>
      <Foot>
        <button className="btn primary" disabled={!name.trim()} onClick={submit}>
          Add
        </button>
      </Foot>
    </>
  );
}

// EditNode changes a node the proposal adds, as you change it: the same fields as adding it.
function EditNode({ m, id }: { m: Model; id: string }) {
  const n = useStore((s) => currentProposal(s)?.nodes?.find((x) => x.id === id));
  if (!n) return null;
  const kind = str(n.kind) || 'function';
  const home = m.box.get(str(n.module));
  return (
    <>
      <Head title={'Edit ' + kind} />
      {!home?.external && (
        <Field label="Part">
          <select id="f-part" value={str(n.module)} onChange={(e) => editProposedNode(id, { module: e.target.value })}>
            {partsOf(m).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <KindFields kind={kind} method={str(n.method) || 'GET'} onKind={(k) => editProposedNode(id, { kind: k })} onMethod={(x) => editProposedNode(id, { method: x })} />
      <Field label="Name">
        <input autoFocus id="f-name" autoComplete="off" value={str(n.label)} onChange={(e) => editProposedNode(id, { label: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && close()} onFocus={(e) => e.currentTarget.select()} />
      </Field>
      <Foot
        onDelete={() => {
          removeProposalNode(id);
          select(null);
          close();
        }}
      >
        <button className="btn primary" onClick={close}>
          Done
        </button>
      </Foot>
    </>
  );
}

function AddPart() {
  const [name, setName] = useState('');
  const submit = () => name.trim() && proposeModule(name.trim());
  return (
    <>
      <Head title="Add a part" />
      <Field label="Path">
        <input autoFocus id="f-name" placeholder="internal/refunds" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </Field>
      <Foot>
        <button className="btn primary" disabled={!name.trim()} onClick={submit}>
          Add
        </button>
      </Foot>
    </>
  );
}

// ---- a call ----

// how a call can be used, by what it reaches: a table is read or written, a topic published to
const usesOf = (kind?: string) => (kind === 'table' ? ['reads', 'writes'] : kind === 'topic' ? ['publishes'] : ['calls']);

function How({ types, value, onChange }: { types: string[]; value: string; onChange: (t: string) => void }) {
  if (types.length < 2) return null;
  return (
    <Field label="How" group>
      <div className="seg" role="group" aria-label="How">
        {types.map((t) => (
          <button key={t} aria-pressed={value === t} onClick={() => onChange(t)}>
            {t}
          </button>
        ))}
      </div>
    </Field>
  );
}

// AddCall: how `from` uses a table, topic or service it was just pointed at.
function AddCall({ m, from, to }: { m: Model; from: string; to: string }) {
  const types = usesOf(m.node.get(to)?.row.node.kind);
  const [type, setType] = useState(types.includes('writes') ? 'writes' : types[0]);
  const submit = () => (proposeEdge(from, to, type), close());
  return (
    <>
      <Head title="New call" />
      <Field label="From">
        <div className="mval">{qn(m, from)}</div>
      </Field>
      <Field label="To">
        <div className="mval">{qn(m, to)}</div>
      </Field>
      <How types={types} value={type} onChange={setType} />
      <Foot>
        <button className="btn primary" autoFocus onClick={submit}>
          Add
        </button>
      </Foot>
    </>
  );
}

// retargetCall points a call the proposal adds at something else, keeping how it's
// used when that still makes sense for what it now reaches.
export function retargetCall(m: Model, edge: number, id: string) {
  const was = str(currentProposal(getState())?.edges?.[edge]?.type) || 'calls';
  const t = usesOf(m.node.get(id)?.row.node.kind);
  editProposalEdge(edge, { to: id, type: t.includes(was) ? was : t.includes('writes') ? 'writes' : t[0] });
}

// EditCall changes a call the proposal adds, as you change it: what it goes from and to, and how.
function EditCall({ m, edge }: { m: Model; edge: number }) {
  const e = useStore((s) => currentProposal(s)?.edges?.[edge]);
  if (!e) return null;
  const from = String(e.from),
    to = String(e.to);
  const type = str(e.type) || 'calls';
  const types = usesOf(m.node.get(to)?.row.node.kind);
  return (
    <>
      <Head title="Call" />
      <Field label="From">
        <Pick m={m} label="From" value={from} skip={to} noExternal onPick={(id) => editProposalEdge(edge, { from: id })} />
      </Field>
      <Field label="To">
        <Pick m={m} label="To" value={to} skip={from} onPick={(id) => retargetCall(m, edge, id)} />
      </Field>
      <How types={types} value={type} onChange={(t) => editProposalEdge(edge, { type: t })} />
      <Foot
        onDelete={() => {
          removeProposalEdge(edge);
          close();
        }}
      >
        <button className="btn primary" onClick={close}>
          Done
        </button>
      </Foot>
    </>
  );
}

// Calls: a line on the map that stands for several of the proposal's calls. Pick one to change it.
function Calls({ m, list, at }: { m: Model; list: number[]; at: ReturnType<typeof where> }) {
  const edges = useStore((s) => currentProposal(s)?.edges);
  const name = (id: unknown) => (m.node.has(String(id)) ? qn(m, String(id)) : String(id));
  return (
    <>
      <Head title="Calls on this line" sub={String(list.length)} />
      <div className="mlist">
        {list.map((i) => {
          const e = edges?.[i];
          if (!e) return null;
          const type = str(e.type) || 'calls';
          return (
            <button key={i} data-edge={i} onClick={() => setState({ form: { type: 'edge', from: String(e.from), to: String(e.to), edge: i, ...at } })}>
              {name(e.from)} {type === 'calls' ? '→' : type} {name(e.to)}
            </button>
          );
        })}
      </div>
    </>
  );
}

// ---- pointing at a part ----

// Target: `from` calls something in this part. Type to find it, or to name a new one.
function Target({ m, box, from, at: place, edge }: { m: Model; box?: Box; from: string; at: ReturnType<typeof where>; edge?: number }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
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
    const wire = (id: string) => (edge != null ? retargetCall(m, edge, id) : proposeEdge(from, id));
    if (!to) {
      const id = proposeNode(box.id, q.trim(), kind, kind === 'route' ? 'GET' : '', box.external, { select: false });
      if (!id) return;
      to = id;
      if (!box.external) wire(id);
    } else if (!it.ext) wire(to);
    // data and services say how: reads or writes
    if (it.ext) {
      if (edge != null) retargetCall(m, edge, to);
      setState({ form: { type: 'edge', from, to, edge, ...place } });
    } else close();
  };
  return (
    <>
      <Head title={qn(m, from) + ' calls'} sub={'in ' + box.label} />
      <input
        autoFocus
        id="t-q"
        className="msearch"
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
