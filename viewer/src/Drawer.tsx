// The details panel: nodes, modules/blocks, groups, multi-selection, propose forms.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Source, Where } from './Code';
import { Fields } from './Fields';
import { HEAD, PAD, ROW, effectSummary, entriesReaching, isEffect, trace, type TreeRow, qn, sharedFn, shortMod, testsReaching, type MEdge, type Model } from './model';
import { ProposalList, ProposalView } from './Proposals';
import {
  currentProposal,
  getState,
  mergeBlock,
  proposeModule,
  proposeNode,
  removeProposalNode,
  renameBlock,
  select,
  setState,
  splitBlock,
  toggleExpanded,
  toggleMulti,
  useGrouping,
  useModel,
  useSel,
  useStore,
} from './store';
import { Comment } from './Comment';

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

// onPath is what an entry point's tests are checked against, as in codemap
// show: the code on the path, without shared functions (they're on every path)
// or external nodes (other code uses them too).
function onPath(m: Model, ids: Iterable<string>): string[] {
  return [...ids].filter((id) => {
    const n = m.full.node.get(id);
    return n && !n.external && !sharedFn(n);
  });
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

// A call tree's effects read as one line per call: "reads save, task,
// workspace", with the query on hover, instead of a row per table with the SQL
// repeated.
type Item = { kind: 'row'; r: TreeRow } | { kind: 'eff'; type: string; ids: string[]; detail?: string; depth: number };
function items(m: Model, rows: TreeRow[]): Item[] {
  const out: Item[] = [];
  for (const r of rows) {
    if (!r.targets && isEffect(m, r.via)) {
      const last = out[out.length - 1];
      if (last?.kind === 'eff' && last.depth === r.depth && last.type === r.via.type && last.detail === r.via.detail) {
        if (!last.ids.includes(r.id)) last.ids.push(r.id);
        continue;
      }
      out.push({ kind: 'eff', type: r.via.type, ids: [r.id], detail: r.via.detail, depth: r.depth });
      continue;
    }
    out.push({ kind: 'row', r });
  }
  return out;
}

function CallTree({ m, id }: { m: Model; id: string }) {
  const t = trace(m, id);
  if (!t.rows.length && !t.reaches.length) return null;
  const verb = (type: string) => (type === 'renders' ? 'shows' : type);
  return (
    <Section title="Call tree">
      <div className="tree">
        {(t.support > 0 || t.reaches.length > 0) && (
          <div className="trow sup">
            <span className="l">
              {t.support > 0 && <span className="seen">+{t.support}</span>}
              {t.reaches.length > 0 && <span className="reach">→ {effectSummary(m, t.reaches)}</span>}
            </span>
          </div>
        )}
        {items(m, t.rows).map((it, i) => {
          if (it.kind === 'eff') {
            return (
              <div key={i} className="trow eff" style={{ paddingLeft: 6 + Math.min(it.depth, 12) * 14 }} title={it.detail}>
                <span className="l">
                  └
                  <span className={kindClass(m, it.ids[0])}>
                    {verb(it.type)}{' '}
                    {it.ids.map((x, j) => (
                      <span key={x}>
                        {j ? ', ' : ''}
                        <button className="effn" data-node={x} onClick={() => select(x)}>
                          {((r) => (r ? (r.prefix ? r.prefix + ' ' : '') + r.label : x))(m.node.get(x)?.row)}
                        </button>
                      </span>
                    ))}
                  </span>
                </span>
              </div>
            );
          }
          const r = it.r;
          const pad = { paddingLeft: 6 + Math.min(r.depth, 12) * 14 };
          if (r.targets) {
            const names = new Set(r.targets.map((x) => m.node.get(x)?.row.label.split('.').pop() ?? x));
            const method = names.size === 1 ? [...names][0] : 'a function value';
            return (
              <div key={i} className="trow wide sup" style={pad} title={r.targets.map((x) => qn(m, x)).join('\n')}>
                <span className="l">
                  └<span>{method}</span>
                  <span className="seen">{r.targets.length} implementations</span>
                </span>
              </div>
            );
          }
          const x = m.node.get(r.id)!;
          return (
            <button key={i} className={`trow ${x.row.prop || r.via.prop ? 'prop' : ''}`} data-node={r.id} style={pad} onClick={() => select(r.id)} title={r.via.detail}>
              <span className="l">
                └
                <span>
                  <span className="m">{shortMod(m, r.id)}</span>
                  {x.row.prefix ? x.row.prefix + ' ' + x.row.label : x.row.label}
                </span>
                {r.support > 0 && <span className="seen">+{r.support}</span>}
                {r.more && <span className="seen">…</span>}
              </span>
              {r.reaches.length > 0 && <span className="reach">→ {effectSummary(m, r.reaches)}</span>}
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
  const inn = m.all.inn.get(id) ?? [],
    out = m.all.out.get(id) ?? [];
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
            <Tests m={m} ids={onPath(m, S.down)} />
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
      {row.moved && <p className="where plan">Moved here from {row.moved} by the proposal. Drag it back to undo.</p>}
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
      <Section title={`Used from outside · ${b.rows.filter((r) => !r.role && (r.pub || r.node.entry || r.prop)).length} of ${b.rows.length}`}>
        {b.rows.some((r) => !r.role && (r.pub || r.node.entry || r.prop)) ? (
          <div className="links">
            {b.rows.filter((r) => !r.role && (r.pub || r.node.entry || r.prop)).map((r) => (
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

function GroupPanel({ m, id }: { m: Model; id: string }) {
  const G = useGrouping();
  const open = useStore((s) => s.expanded.has(id));
  const g = G?.groups.get(id);
  if (!g) return null;
  const mine = new Set(g.members);
  const use = new Map<string, string>(),
    dep = new Map<string, string>();
  for (const e of m.edges) {
    const a = m.node.get(e.from)!.box,
      c = m.node.get(e.to)!.box;
    if (mine.has(a.id) === mine.has(c.id)) continue;
    if (mine.has(a.id)) dep.set(c.id, c.label);
    else use.set(a.id, a.label);
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
  return (
    <>
      <Head eyebrow="Folder" title={g.path} />
      <div className="cols">
        <Section title="Used by">{mlist(use)}</Section>
        <Section title="Depends on">{mlist(dep)}</Section>
      </div>
      <Section title="Modules">{mlist(new Map(g.members.map((x) => [x, m.box.get(x)!.label])))}</Section>
      <div className="btns">
        <button className="btn" onClick={() => toggleExpanded(id)}>
          {open ? 'Close' : 'Open'}
        </button>
      </div>
    </>
  );
}

function MultiPanel({ m, ids }: { m: Model; ids: string[] }) {
  const pos = useStore((s) => s.pos);
  const name = (id: string) => (m.node.has(id) ? qn(m, id) : m.box.get(id)?.label ?? id);
  const fnIds = ids.filter((id) => m.node.has(id));
  const srcs = new Set(fnIds.map((id) => m.node.get(id)!.box.id));
  const src = srcs.size === 1 ? m.node.get(fnIds[0])!.box : null;
  const own = src ? src.rows.filter((r) => !r.prop && !r.ghost) : [];
  const canSplit =
    !!src && fnIds.length === ids.length && !src.block && !src.prop && !src.ghost && fnIds.every((id) => !m.node.get(id)!.row.prop) && own.length > fnIds.length;
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
      </div>
    </>
  );
}

const KINDS = ['function', 'route', 'page', 'job', 'subscriber', 'command', 'component', 'table', 'topic', 'service'];

function FormPanel({ m }: { m: Model }) {
  const form = useStore((s) => s.form)!;
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
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const kinds = KINDS.includes(common) ? KINDS : [common, ...KINDS];
  const submit = () => {
    const v = name.trim();
    if (!v) return;
    if (form.type === 'mod') {
      // place under everything
      let at: [number, number] = [20, 80];
      let low = -1;
      for (const bx of m.boxes) {
        const p = pos[bx.id];
        if (!p) continue;
        const bottom = p[1] + bx.defH;
        if (bottom > low) {
          low = bottom;
          at = [p[0], bottom + 70];
        }
      }
      proposeModule(v, at);
    } else if (b) proposeNode(b.id, v, kind, kind === 'route' ? method : '', b.external);
  };
  const cancel = () => setState({ form: null });
  return (
    <div onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && submit()} style={{ display: 'contents' }}>
      <Head eyebrow="Propose" plan title={form.type === 'mod' ? 'New module' : b?.label ?? ''} />
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

export function Drawer() {
  const m = useModel();
  const sel = useStore((s) => s.sel);
  const form = useStore((s) => s.form);
  const mode = useStore((s) => s.mode);
  const pslug = useStore((s) => s.pslug);
  const readOnly = useStore((s) => s.readOnly);
  let content: ReactNode = null;
  let wide = false;
  if (form) content = <FormPanel key={form.type + form.box} m={m} />;
  else if (sel.length > 1) content = <MultiPanel m={m} ids={sel} />;
  else if (sel.length === 1 && sel[0].startsWith('group:')) content = <GroupPanel m={m} id={sel[0]} />;
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
      {!readOnly && !form && sel.length > 0 && content && <Comment key={'comment:' + sel.join('\0')} m={m} ids={sel} />}
    </aside>
  );
}
