// Wiring a proposal by typing: one line says what to add and where it goes.
//
//   Service.Cancel            a function, in the part you were last adding to
//   Service.Cancel @orders    ...in the part whose name contains "orders"
//   POST /orders/:id/cancel   a route (and where routes live)
//   table refunds             a table, topic or service, in their group
import type { Box, Model } from './model';

export const KINDS = ['function', 'route', 'page', 'job', 'subscriber', 'command', 'component', 'table', 'topic', 'service'];
export const ENTRY_KINDS = ['route', 'page', 'job', 'subscriber', 'command'];
export const EXTERNAL_KINDS = ['table', 'topic', 'service'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface Spec {
  label: string;
  kind?: string; // not said: whatever the part mostly holds
  method: string;
  at?: string; // "@orders": the text of a part's name
}

// parseSpec reads what was typed. It returns null when no name is left.
export function parseSpec(q: string): Spec | null {
  let at: string | undefined;
  const words = q
    .trim()
    .split(/\s+/)
    .filter((w) => {
      if (w.length > 1 && w[0] === '@') {
        at = w.slice(1).toLowerCase();
        return false;
      }
      return !!w;
    });
  let kind: string | undefined;
  let method = '';
  if (words.length > 1 && METHODS.includes(words[0].toUpperCase()) && words[1].startsWith('/')) {
    kind = 'route';
    method = words.shift()!.toUpperCase();
  } else if (words.length > 1 && KINDS.includes(words[0].toLowerCase())) {
    kind = words.shift()!.toLowerCase();
    if (kind === 'route') method = 'GET';
  }
  const label = words.join(' ');
  return label ? { label, kind, method, at } : null;
}

const last = (s: string) => s.slice(s.lastIndexOf('/') + 1).toLowerCase();

// boxNamed finds the part "@orders" means: its last path segment first, then any part of its name.
export function boxNamed(boxes: Box[], at: string): Box | undefined {
  const real = boxes.filter((b) => !b.external && !b.ghost);
  return real.find((b) => last(b.label) === at) ?? real.find((b) => b.label.toLowerCase().includes(at));
}

// commonKind is what a part mostly holds.
export function commonKind(b: Box | undefined): string {
  const c = new Map<string, number>();
  for (const r of b?.rows ?? []) c.set(r.node.kind, (c.get(r.node.kind) ?? 0) + 1);
  return [...c].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'function';
}

// boxFor is the part that mostly holds this kind: where routes live, where tables are.
export function boxFor(m: Model, kind: string): Box | undefined {
  let best: Box | undefined;
  let n = 0;
  for (const b of m.boxes) {
    if (b.ghost) continue;
    const k = b.rows.filter((r) => r.node.kind === kind).length;
    if (k > n) (best = b), (n = k);
  }
  return best;
}

export interface Plan {
  kind: string;
  label: string;
  method: string;
  box: Box;
}

// plan decides what a spec becomes: its kind, and the part it goes in. `home`
// is where things go when the text doesn't say: the part the user last added
// to, or the caller's own.
export function plan(m: Model, s: Spec, home: Box | undefined): Plan | null {
  const named = s.at ? boxNamed(m.boxes, s.at) : undefined;
  if (s.at && !named) return null;
  const kind = s.kind ?? commonKind(named ?? home);
  const typed = EXTERNAL_KINDS.includes(kind) || ENTRY_KINDS.includes(kind);
  // a table goes where tables are, a route where routes are; a function in the part
  const box = named ?? (typed ? boxFor(m, kind) : undefined) ?? home;
  if (!box) return null;
  return { kind, label: s.label, method: kind === 'route' ? s.method || 'GET' : '', box };
}
