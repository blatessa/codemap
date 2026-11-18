// How a field value renders, by what it looks like. First match wins. Any
// extractor or proposal can put any value in a node's fields; this is the only
// place that decides how it shows.
export type FieldKind = 'link' | 'links' | 'ref' | 'refs' | 'table' | 'code' | 'text' | 'object' | 'none';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isLink = (v: unknown) => isObj(v) && typeof v.label === 'string' && typeof v.url === 'string';
const keysOf = (o: Record<string, unknown>) => Object.keys(o).sort().join('\0');

export function classify(v: unknown, isNode: (id: string) => boolean): FieldKind {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'string' && /^https?:\/\//.test(v)) return 'link';
  if (isLink(v) || (Array.isArray(v) && v.length > 0 && v.every(isLink))) return 'links';
  if (typeof v === 'string' && isNode(v)) return 'ref';
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && isNode(x))) return 'refs';
  if (Array.isArray(v) && v.length > 0) {
    if (v.every(Array.isArray)) return 'table';
    if (v.every(isObj) && v.every((x) => keysOf(x as Record<string, unknown>) === keysOf(v[0] as Record<string, unknown>))) return 'table';
  }
  if (isObj(v) && typeof v.code === 'string') return 'code';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return 'text';
  if (Array.isArray(v)) return v.every((x) => !isObj(x) && !Array.isArray(x)) ? 'text' : 'object';
  return 'object';
}

// humanize turns a field key into a label: snake_case -> "Snake case".
export function humanize(k: string): string {
  const s = k.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const isBlockKind = (k: FieldKind) => k === 'table' || k === 'code' || k === 'object';
