// Port of project.BlockFor and its glob rules (internal/project/project.go).
import type { Block } from './types';

const reCache = new Map<string, RegExp | null>();

// pathMatch mirrors Go's path.Match: '*' and '?' never match '/', '[...]' is a
// character class (with '^' negation and ranges), '\\' escapes. A malformed
// pattern matches nothing, as path.Match returns an error.
export function pathMatch(pattern: string, s: string): boolean {
  let re = reCache.get(pattern);
  if (re === undefined) {
    re = compile(pattern);
    reCache.set(pattern, re);
  }
  return re ? re.test(s) : false;
}

function compile(p: string): RegExp | null {
  let out = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '\\') {
      i++;
      if (i >= p.length) return null;
      out += esc(p[i]);
    } else if (c === '[') {
      let j = i + 1;
      let cls = '';
      if (p[j] === '^') {
        cls += '^';
        j++;
      }
      let n = 0;
      for (; j < p.length && (p[j] !== ']' || n === 0); j++, n++) {
        if (p[j] === '\\') {
          j++;
          if (j >= p.length) return null;
          cls += '\\' + p[j];
        } else if (p[j] === '-' && n > 0 && p[j + 1] !== ']') cls += '-';
        else cls += esc(p[j]);
      }
      if (j >= p.length || n === 0) return null;
      out += cls.startsWith('^') ? `(?!/)[${cls}]` : `[${cls}]`;
      i = j;
    } else out += esc(c);
  }
  try {
    return new RegExp(out + '$', 'u');
  } catch {
    return null;
  }
}

const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

// globMatch is path.Match where "**" matches across slashes.
export function globMatch(pattern: string, s: string): boolean {
  if (!pattern.includes('**')) return pathMatch(pattern, s);
  const i = pattern.indexOf('**');
  const prefix = pattern.slice(0, i);
  let rest = pattern.slice(i + 2);
  if (rest.startsWith('/')) rest = rest.slice(1);
  if (!s.startsWith(prefix)) return false;
  const tail = s.slice(prefix.length);
  if (rest === '') return true;
  const segs = tail.split('/');
  for (let k = 0; k < segs.length; k++) if (globMatch(rest, segs.slice(k).join('/'))) return true;
  return false;
}

export interface BlockNode {
  module: string;
  label: string;
  file?: string;
}

// blockFor returns the ID of the first block n falls into, or ''.
export function blockFor(blocks: Block[], n: BlockNode): string {
  for (const b of blocks) {
    if (b.from !== n.module) continue;
    for (const g of b.match ?? []) if (globMatch(g, n.label)) return b.id;
    if (n.file) for (const g of b.files ?? []) if (globMatch(g, n.file)) return b.id;
  }
  return '';
}

// escapeGlob makes a label match only itself.
export const escapeGlob = (s: string) => s.replace(/[*?[\\]/g, '\\$&');

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
}
