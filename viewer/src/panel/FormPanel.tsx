// Proposing a new node or module.
import { useEffect, useRef, useState } from 'react';
import { type Model } from '../model';
import { proposeModule, proposeNode, setState, useStore } from '../store';
import { Head } from './common';

const KINDS = ['function', 'route', 'page', 'job', 'subscriber', 'command', 'component', 'table', 'topic', 'service'];

export function FormPanel({ m }: { m: Model }) {
  const form = useStore((s) => s.form)!;
  const b = form.box ? m.box.get(form.box) : undefined;
  const common = (() => {
    const c = new Map<string, number>();
    for (const r of b?.rows ?? []) c.set(r.node.kind, (c.get(r.node.kind) ?? 0) + 1);
    return [...c].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'function';
  })();
  const [kind, setKind] = useState(common);
  const [method, setMethod] = useState('POST');
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const kinds = KINDS.includes(common) ? KINDS : [common, ...KINDS];
  const submit = () => {
    const v = name.trim();
    if (!v) return;
    if (form.type === 'mod') proposeModule(v); else if (b) proposeNode(b.id, v, kind, kind === 'route' ? method : '', b.external);
  };
  const cancel = () => setState({ form: null });
  return (
    <div onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && submit()} style={{ display: 'contents' }}>
      <Head kind="new" plan title={form.type === 'mod' ? 'New module' : b?.label ?? ''} />
      {form.type === 'mod' ? null : (
        <>
          <label className="field">
            Kind
            <select id="f-k" value={kind} onChange={(e) => setKind(e.target.value)}>
              {kinds.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          {kind === 'route' && (
            <label className="field">
              Method
              <select id="f-m" value={method} onChange={(e) => setMethod(e.target.value)}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      <label className="field">
        {form.type === 'mod' ? 'Path' : 'Name'}
        <input id="f-name" ref={ref} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} placeholder={form.type === 'mod' ? 'internal/refunds' : ''} />
      </label>
      <div className="btns">
        <button className="btn primary" onClick={submit}>
          Add
        </button>
        <button className="btn" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
