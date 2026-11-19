// Popups on the map: wiring a proposal where you are looking at it. A part's +
// asks what to add there; while connecting, clicking a part asks which of its
// functions (or a new one), and clicking a table or service asks how it's used.
import { useEffect, useRef, useState } from 'react';
import { qn, type Box, type Model } from './model';
import { proposeEdge, proposeModule, proposeNode, setState, useStore } from './store';

const KINDS = ['function', 'route', 'page', 'job', 'subscriber', 'command', 'component', 'table', 'topic', 'service'];
const LEAF = ['table', 'topic', 'service']; // nothing to call from these

// commonKind is what a part mostly holds: what a new thing in it probably is.
function commonKind(b?: Box): string {
  const c = new Map<string, number>();
  for (const r of b?.rows ?? []) c.set(r.node.kind, (c.get(r.node.kind) ?? 0) + 1);
  return [...c].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'function';
}

const close = () => setState({ form: null });

export function MapPopup({ m }: { m: Model }) {
  const form = useStore((s) => s.form);
  if (!form) return null;
  const key = [form.type, form.box, form.from, form.to].join('|');
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
      {form.type === 'fn' && <AddNode key={key} box={m.box.get(form.box!)} />}
      {form.type === 'mod' && <AddPart key={key} />}
      {form.type === 'target' && <Target key={key} m={m} box={m.box.get(form.box!)} from={form.from!} x={form.x} y={form.y} />}
      {form.type === 'edge' && <Use key={key} m={m} from={form.from!} to={form.to!} />}
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

// AddNode: what to put in this part. Enter adds it; then click what it calls.
function AddNode({ box }: { box?: Box }) {
  const [kind, setKind] = useState(commonKind(box));
  const [method, setMethod] = useState('POST');
  const [name, setName] = useState('');
  const [doc, setDoc] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  if (!box) return null;
  const kinds = KINDS.includes(kind) ? KINDS : [kind, ...KINDS];
  const submit = () => {
    if (!name.trim()) return;
    const id = proposeNode(box.id, name.trim(), kind, kind === 'route' ? method : '', box.external, { doc, select: false });
    // what does it call? the next thing to click
    if (id && !LEAF.includes(kind)) setState({ connectFrom: id });
  };
  const enter = (e: React.KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), submit());
  return (
    <>
      <Head title="Add" sub={`to ${box.label}`} />
      <div className="mrow">
        <select aria-label="Kind" id="f-k" value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        {kind === 'route' && (
          <select aria-label="Method" id="f-m" value={method} onChange={(e) => setMethod(e.target.value)}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        )}
      </div>
      <input ref={ref} id="f-name" placeholder={kind === 'route' ? '/orders/:id/cancel' : 'Name'} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={enter} />
      <input id="f-doc" placeholder="What it does (optional)" autoComplete="off" value={doc} onChange={(e) => setDoc(e.target.value)} onKeyDown={enter} />
      <div className="mfoot">
        <span>Enter adds it</span>
        <button className="btn primary sm" onClick={submit}>
          Add
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
function Target({ m, box, from, x, y }: { m: Model; box?: Box; from: string; x: number; y: number }) {
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
    if (!to) {
      const id = proposeNode(box.id, q.trim(), kind, kind === 'route' ? 'GET' : '', box.external, { select: false, from: box.external ? undefined : from });
      if (!id) return;
      to = id;
    } else if (!it.ext) proposeEdge(from, to);
    // data and services say how: reads or writes, and what query
    if (it.ext) setState({ form: { type: 'edge', from, to, x, y } });
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

// Use: how `from` uses a table, topic or service.
function Use({ m, from, to }: { m: Model; from: string; to: string }) {
  const kind = m.node.get(to)?.row.node.kind ?? '';
  const types = kind === 'table' ? ['reads', 'writes'] : kind === 'topic' ? ['publishes'] : ['calls'];
  const [type, setType] = useState(kind === 'table' ? 'writes' : types[0]);
  const [detail, setDetail] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = () => (proposeEdge(from, to, type, detail), close());
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
        <span>Enter adds it</span>
        <button className="btn primary sm" onClick={submit}>
          Add
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
