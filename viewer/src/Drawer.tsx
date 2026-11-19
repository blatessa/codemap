// The details panel: shows the panel for what's selected, or the proposals.
import { type ReactNode } from 'react';
import { ProposalList, ProposalView } from './Proposals';
import { currentProposal, getState, setDrawerWidth, setState, useModel, useParts, useStore } from './store';
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
  const width = useStore((s) => s.drawerW);
  // dragging the left edge sets the width
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => setDrawerWidth(Math.round(Math.min(window.innerWidth * 0.75, Math.max(320, window.innerWidth - ev.clientX))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrawerWidth(getState().drawerW ?? 440, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

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
  const w = width ? (wide ? Math.max(width, 600) : width) : wide ? 600 : 440;
  return (
    <>
      {content && (
        <div
          className="dresize"
          style={{ right: w - 3 }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panel"
          onPointerDown={drag}
          onDoubleClick={() => setDrawerWidth(440, true)}
        />
      )}
      <aside
        className={`drawer ${wide ? 'wide' : ''}`}
        id="drawer"
        style={{ width: w }}
        hidden={!content}
        onMouseOver={(e) => {
          const n = (e.target as Element).closest('[data-node]') as HTMLElement | null;
          const id = n ? n.dataset.node! : null;
          if (id !== getState().hover) setState({ hover: id });
        }}
        onMouseLeave={() => getState().hover && setState({ hover: null })}
      >
        {mode === 'propose' && pslug && (sel || form) && <ProposalBack />}
        {content}
        {!readOnly && !form && sel && content && <Comment key={'comment:' + sel} m={m} id={sel} />}
      </aside>
    </>
  );
}

// ProposalBack returns from something opened inside a proposal to the proposal.
function ProposalBack() {
  const p = useStore(currentProposal);
  if (!p) return null;
  return (
    <button className="pback" onClick={() => setState({ sel: null, form: null, connectFrom: null })}>
      ‹ {p.name}
    </button>
  );
}
