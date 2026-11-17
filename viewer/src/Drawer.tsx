// The details panel: nodes, modules/blocks, areas, multi-selection, propose forms.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Source, Where } from './Code';
import { Fields } from './Fields';
import { HEAD, PAD, ROW, callTree, entriesReaching, qn, shortMod, testsReaching, type MEdge, type Model } from './model';
import { ProposalList, ProposalView } from './Proposals';
import {
  addArea,
  currentProposal,
  deleteArea,
  getState,
  mergeBlock,
  proposeModule,
  proposeNode,
  removeFromArea,
  removeProposalNode,
  renameArea,
  renameBlock,
  select,
  setState,
  splitBlock,
  toggleMulti,
  useModel,
  useSel,
  useStore,
} from './store';
import { useAreaRect } from './MapView';

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div>
    <p className="eyebrow">{title}</p>
    {children}
  </div>
);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Head({ eyebrow, plan, title, children }: { eyebrow: string; plan?: boolean; title: string; children?: ReactNode }) {
  return (
    <div className="dhead">
      <div>
        <p className={`eyebrow ${plan ? 'plan' : ''}`}>{eyebrow}</p>
        <h2>{title}</h2>
        {children}
      </div>
      <button className="x" aria-label="Close" onClick={() => setState({ sel: [], form: null, connectFrom: null, focus: false, splitting: null })}>
        ×
      </button>
    </div>
  );
}

function NodeLink({ m, id, edge, detail }: { m: Model; id: string; edge?: MEdge; detail?: boolean }) {
  const x = m.node.get(id);
  return (
    <button className={`lnk ${edge?.prop || x?.row.prop ? 'prop' : ''}`} data-node={id} onClick={() => select(id)}>
      {qn(m, id)}
      {edge?.declared && <span className="q">declared</span>}
      {detail && edge?.detail && <span className="q">{edge.detail}</span>}
    </button>
  );
}

function EdgeList({ m, edges, end, detail }: { m: Model; edges: MEdge[]; end: 'from' | 'to'; detail?: boolean }) {
  if (!edges.length) return <p>—</p>;
  return (
    <div className="links">
      {edges.map((e) => (
        <NodeLink key={e.i} m={m} id={e[end]} edge={e} detail={detail} />
      ))}
    </div>
  );
}

function Tests({ m, ids }: { m: Model; ids: Iterable<string> }) {
  const list = testsReaching(m, ids);
  if (!list.length) return <span className="chip">No tests</span>;
  return (
    <>
      {list.map(({ test, direct, via }) => (
        <TestRow key={test.id} file={test.file} line={test.line} endLine={test.endLine} name={test.label} via={direct ? '' : via} />
      ))}
    </>
  );
}

function TestRow({ name, file, line, endLine, via }: { name: string; file?: string; line?: number; endLine?: number; via: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="test" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span>{name}</span>
        <span className="m">
          {file}
          {line ? ':' + line : ''}
          {via ? ' · via ' + via : ''}
        </span>
      </summary>
      {open && file && line ? <Source file={file} from={line} to={endLine} /> : null}
    </details>
  );
}

function kindClass(m: Model, id: string) {
  return m.node.get(id)?.row.tagClass ?? '';
}

function CallTree({ m, id }: { m: Model; id: string }) {
  const rows = callTree(m, id);
  if (!rows.length) return null;
  return (
    <Section title="Call tree">
      <div className="tree">
        {rows.map((r, i) => {
          const x = m.node.get(r.id)!;
          return (
            <button
              key={i}
              className={`trow ${x.row.prop || r.via.prop ? 'prop' : ''}`}
              data-node={r.id}
              style={{ paddingLeft: 6 + Math.min(r.depth, 12) * 14 }}
              onClick={() => select(r.id)}
            >
              <span className="l">
                └
                <span>
                  <span className="m">{shortMod(m, r.id)}</span>
                  {x.row.prefix ? x.row.prefix + ' ' + x.row.label : x.row.label}
                </span>
                {x.row.tag && <span className={`k ${kindClass(m, r.id)}`}>{x.row.tag}</span>}
                {r.seen && <span className="seen">see above</span>}
              </span>
              {r.via.detail && <span className="q">{r.via.detail}</span>}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

function NodePanel({ m, id }: { m: Model; id: string }) {
  const S = useSel();
  const propose = useStore((s) => s.mode === 'propose' && !!currentProposal(s));
  const { row, box } = m.node.get(id)!;
  const n = row.node;
  const method = typeof n.fields?.method === 'string' ? (n.fields.method as string).toUpperCase() : '';
  const eyebrow = row.prop ? 'Proposed' : row.ghost ? 'Missing' : n.external || n.entry ? cap(n.kind) : box.label;
  const inn = m.inn.get(id) ?? [],
    out = m.out.get(id) ?? [];
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
            <Tests m={m} ids={S.down} />
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
      {n.doc && <p className="doc">{n.doc}</p>}
      {propose && (
        <div className="btns">
          {!n.external && !row.ghost && (
            <button className="btn primary" onClick={() => setState({ connectFrom: id })}>
              Add a call
            </button>
          )}
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

function BoxPanel({ m, id }: { m: Model; id: string }) {
  const b = m.box.get(id)!;
  const splitting = useStore((s) => s.splitting === id);
  const pos = useStore((s) => s.pos);
  const use = new Map<string, string>(),
    dep = new Map<string, string>();
  for (const e of m.edges) {
    const a = m.node.get(e.from)!.box,
      c = m.node.get(e.to)!.box;
    if (a === c) continue;
    if (a.id === id) dep.set(c.id, c.label);
    if (c.id === id) use.set(a.id, a.label);
  }
  const mlist = (map: Map<string, string>) =>
    map.size ? (
      <div className="links">
        {[...map].map(([k, v]) => (
          <button key={k} className="lnk" onClick={() => select(k)}>
            {v}
          </button>
        ))}
      </div>
    ) : (
      <p>—</p>
    );
  const own = b.rows.filter((r) => !r.prop && !r.ghost);
  const src = b.from ? m.box.get(b.from) : undefined;
  return (
    <>
      <Head eyebrow={b.prop ? 'Proposed module' : 'Module'} plan={b.prop} title={b.label}>
        {src && <div className="where">split from {src.label}</div>}
      </Head>
      {b.doc && <p className="doc">{b.doc}</p>}
      <div className="cols">
        <Section title="Used by">{mlist(use)}</Section>
        <Section title="Depends on">{mlist(dep)}</Section>
      </div>
      <Section title="Contains">
        {b.rows.length ? (
          <div className="links">
            {b.rows.map((r) => (
              <button key={r.id} className={`lnk ${r.prop ? 'prop' : ''}`} data-node={r.id} onClick={() => select(r.id)}>
                {r.prefix ? r.prefix + ' ' + r.label : r.label}
              </button>
            ))}
          </div>
        ) : (
          <p>—</p>
        )}
      </Section>
      {b.block ? (
        <>
          <label className="field">
            Name
            <input id="s-rename" defaultValue={b.label} autoComplete="off" onChange={(e) => renameBlock(id, e.target.value || 'Untitled')} />
          </label>
          <div className="btns">
            <button className="btn" onClick={() => mergeBlock(id)}>
              Merge back
            </button>
          </div>
        </>
      ) : !b.prop && !b.ghost && own.length > 1 ? (
        splitting ? (
          <SplitForm
            rows={own.map((r) => ({ id: r.id, label: r.prefix && r.node.fields?.method ? r.prefix + ' ' + r.label : r.label }))}
            defName={(b.label.split('/').pop() ?? b.label) + ' · '}
            onSplit={(ids, name) => {
              const p = pos[id] ?? [0, 0];
              const left = own.length - ids.length;
              const labels = ids.map((x) => m.node.get(x)!.row.node.label);
              splitBlock(id, labels, name, [p[0], p[1] + HEAD + left * ROW + PAD + 34]);
            }}
          />
        ) : (
          <div className="btns">
            <button className="btn" onClick={() => setState({ splitting: id })}>
              Split…
            </button>
          </div>
        )
      ) : null}
    </>
  );
}

function SplitForm({ rows, defName, onSplit }: { rows: { id: string; label: string }[]; defName: string; onSplit: (ids: string[], name: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState(defName);
  const ok = picked.length > 0 && picked.length < rows.length && name.trim() !== '';
  return (
    <div className="addnote">
      <p className="eyebrow">Split out</p>
      {rows.map((r) => (
        <label key={r.id} className="chk">
          <input
            type="checkbox"
            value={r.id}
            checked={picked.includes(r.id)}
            onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))}
          />
          {r.label}
        </label>
      ))}
      <label className="field">
        Name
        <input id="s-name" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="btns">
        <button className="btn primary" disabled={!ok} onClick={() => ok && onSplit(picked, name.trim())}>
          Split
        </button>
        <button className="btn" onClick={() => setState({ splitting: null })}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AreaPanel({ m, name }: { m: Model; name: string }) {
  const a = useStore((s) => s.areas.find((x) => x.name === name));
  const rectOf = useAreaRect();
  const [draft, setDraft] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (name !== draft.trim()) setDraft(name);
    if (/^New area/.test(name) && document.activeElement !== ref.current) {
      ref.current?.focus();
      ref.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  if (!a) return null;
  const mods = (a.modules ?? []).filter((id) => m.box.has(id));
  return (
    <>
      <Head eyebrow="Area" title={a.name} />
      <label className="field">
        Name
        <input
          id="a-name"
          ref={ref}
          value={draft}
          autoComplete="off"
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim()) renameArea(a.name, e.target.value.trim());
          }}
        />
      </label>
      <Section title="Modules">
        {mods.length ? (
          <div className="items">
            {mods.map((id) => (
              <div className="item" key={id}>
                <span>
                  <button className="lnk" onClick={() => select(id)}>
                    {m.box.get(id)!.label}
                  </button>
                </span>
                <button aria-label="Remove from area" onClick={() => removeFromArea(a.name, id, rectOf)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p>Drag modules in.</p>
        )}
      </Section>
      <div className="btns">
        <button className="btn danger" onClick={() => deleteArea(a.name)}>
          Delete area
        </button>
      </div>
    </>
  );
}

function MultiPanel({ m, ids }: { m: Model; ids: string[] }) {
  const rectOf = useAreaRect();
  const pos = useStore((s) => s.pos);
  const name = (id: string) => (id.startsWith('area:') ? id.slice(5) : m.node.has(id) ? qn(m, id) : m.box.get(id)?.label ?? id);
  const fnIds = ids.filter((id) => m.node.has(id));
  const srcs = new Set(fnIds.map((id) => m.node.get(id)!.box.id));
  const src = srcs.size === 1 ? m.node.get(fnIds[0])!.box : null;
  const own = src ? src.rows.filter((r) => !r.prop && !r.ghost) : [];
  const canSplit =
    !!src && fnIds.length === ids.length && !src.block && !src.prop && !src.ghost && fnIds.every((id) => !m.node.get(id)!.row.prop) && own.length > fnIds.length;
  const boxIds = ids.filter((id) => m.box.has(id) && !m.box.get(id)!.prop && !m.box.get(id)!.ghost);
  return (
    <>
      <Head eyebrow="Selection" title={`${ids.length} selected`} />
      <div className="items">
        {ids.map((id) => (
          <div className="item" key={id}>
            <span>{name(id)}</span>
            <button aria-label="Deselect" onClick={() => toggleMulti(id)}>
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="btns">
        {canSplit && (
          <button
            className="btn"
            onClick={() => {
              const p = pos[src!.id] ?? [0, 0];
              const left = own.length - fnIds.length;
              const labels = fnIds.map((x) => m.node.get(x)!.row.node.label);
              splitBlock(src!.id, labels, (src!.label.split('/').pop() ?? src!.label) + ' · new', [p[0], p[1] + HEAD + left * ROW + PAD + 34]);
            }}
          >
            Split into a new block
          </button>
        )}
        {boxIds.length === ids.length && (
          <button className="btn" onClick={() => addArea(boxIds, rectOf)}>
            New area from these
          </button>
        )}
      </div>
    </>
  );
}

const KINDS = ['function', 'route', 'page', 'job', 'subscriber', 'component', 'table', 'topic', 'service'];

function FormPanel({ m }: { m: Model }) {
  const form = useStore((s) => s.form)!;
  const areas = useStore((s) => s.areas);
  const pos = useStore((s) => s.pos);
  const b = form.box ? m.box.get(form.box) : undefined;
  const common = (() => {
    const c = new Map<string, number>();
    for (const r of b?.rows ?? []) c.set(r.node.kind, (c.get(r.node.kind) ?? 0) + 1);
    return [...c].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'function';
  })();
  const [kind, setKind] = useState(common);
  const [method, setMethod] = useState('POST');
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const kinds = KINDS.includes(common) ? KINDS : [common, ...KINDS];
  const submit = () => {
    const v = name.trim();
    if (!v) return;
    if (form.type === 'mod') {
      // place under the area's lowest member, or under everything
      const ids = area ? areas.find((a) => a.name === area)?.modules ?? [] : m.boxes.map((x) => x.id);
      let at: [number, number] = [20, 80];
      let low = -1;
      for (const id of ids) {
        const p = pos[id],
          bx = m.box.get(id);
        if (!p || !bx) continue;
        const bottom = p[1] + HEAD + Math.max(bx.rows.length, 1) * ROW + PAD;
        if (bottom > low) {
          low = bottom;
          at = [p[0], bottom + (area ? 24 : 70)];
        }
      }
      proposeModule(v, area, at);
    } else if (b) proposeNode(b.id, v, kind, kind === 'route' ? method : '', b.external);
  };
  const cancel = () => setState({ form: null });
  return (
    <div onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && submit()} style={{ display: 'contents' }}>
      <Head eyebrow="Propose" plan title={form.type === 'mod' ? 'New module' : b?.label ?? ''} />
      {form.type === 'mod' ? (
        <label className="field">
          Area
          <select id="f-area" value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">None</option>
            {areas.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
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

export function Drawer() {
  const m = useModel();
  const sel = useStore((s) => s.sel);
  const form = useStore((s) => s.form);
  const mode = useStore((s) => s.mode);
  const pslug = useStore((s) => s.pslug);
  let content: ReactNode = null;
  let wide = false;
  if (form) content = <FormPanel key={form.type + form.box} m={m} />;
  else if (sel.length > 1) content = <MultiPanel m={m} ids={sel} />;
  else if (sel.length === 1 && sel[0].startsWith('area:')) content = <AreaPanel m={m} name={sel[0].slice(5)} />;
  else if (sel.length === 1 && m.node.has(sel[0])) content = <NodePanel m={m} id={sel[0]} />;
  else if (sel.length === 1 && m.box.has(sel[0])) content = <BoxPanel key={sel[0]} m={m} id={sel[0]} />;
  else if (mode === 'propose' && !pslug) content = <ProposalList />;
  else if (mode === 'propose') {
    content = <ProposalView m={m} />;
    wide = true;
  }
  return (
    <aside
      className={`drawer ${wide ? 'wide' : ''}`}
      id="drawer"
      hidden={!content}
      onMouseOver={(e) => {
        const n = (e.target as Element).closest('.trow[data-node],.lnk[data-node]') as HTMLElement | null;
        const id = n ? n.dataset.node! : null;
        if (id !== getState().hover) setState({ hover: id });
      }}
      onMouseLeave={() => getState().hover && setState({ hover: null })}
    >
      {content}
    </aside>
  );
}
