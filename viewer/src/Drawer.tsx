// The details panel: shows the panel for what's selected, or the proposals.
import { type ReactNode } from 'react';
import { ProposalList, ProposalView } from './Proposals';
import { getState, setState, useModel, useParts, useStore } from './store';
import { isFolder } from './parts';
import { Comment } from './Comment';
import { NodePanel } from './panel/NodePanel';
import { GroupPanel } from './panel/GroupPanel';
import { FormPanel } from './panel/FormPanel';

export function Drawer() {
  const m = useModel();
  const P = useParts();
  const sel = useStore((s) => s.sel);
  const form = useStore((s) => s.form);
  const mode = useStore((s) => s.mode);
  const pslug = useStore((s) => s.pslug);
  const readOnly = useStore((s) => s.readOnly);
  let content: ReactNode = null;
  let wide = false;
  if (form) content = <FormPanel key={form.type + form.box} m={m} />;
  else if (sel && m.node.has(sel)) content = <NodePanel key={sel} m={m} P={P} id={sel} />;
  else if (sel && (m.box.has(sel) || isFolder(sel))) content = <GroupPanel key={sel} m={m} P={P} id={sel} />;
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
        const n = (e.target as Element).closest('[data-node]') as HTMLElement | null;
        const id = n ? n.dataset.node! : null;
        if (id !== getState().hover) setState({ hover: id });
      }}
      onMouseLeave={() => getState().hover && setState({ hover: null })}
    >
      {content}
      {!readOnly && !form && sel && content && <Comment key={'comment:' + sel} m={m} id={sel} />}
    </aside>
  );
}
