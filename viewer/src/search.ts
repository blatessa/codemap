// Ranking for the search box: word-aware matching over names, paths and docs.
// Pure, so it can be tested without the map.

export interface Field {
  text: string;
  /** added to the match score: lower fields are the better place to match. */
  weight: number;
  /** allow subsequence ("ordsvc" → "orders.Service") matches. */
  fuzzy?: boolean;
}

export interface Match {
  score: number;
  /** indices of the matched characters in the first field, for highlighting. */
  marks: number[];
}

const alnum = (c: string) => /[a-z0-9]/i.test(c);

// a word starts after a separator or at a lower→Upper camelCase step
function wordStart(s: string, i: number) {
  if (i === 0) return true;
  const p = s[i - 1], c = s[i];
  return !alnum(p) || (p === p.toLowerCase() && p !== p.toUpperCase() && c !== c.toLowerCase());
}

/** one token against one string: 0 exact, 1 prefix, 2 word start, 3 inside, 4+ scattered. */
function matchToken(tok: string, text: string, fuzzy: boolean): { score: number; marks: number[] } | null {
  const s = text.toLowerCase();
  if (s === tok) return { score: 0, marks: range(0, tok.length) };
  let best = -1;
  for (let i = s.indexOf(tok); i >= 0; i = s.indexOf(tok, i + 1)) {
    if (best < 0) best = i;
    if (wordStart(text, i)) {
      best = i;
      break;
    }
  }
  if (best >= 0) {
    const score = best === 0 ? 1 : wordStart(text, best) ? 2 : 3;
    return { score, marks: range(best, tok.length) };
  }
  if (!fuzzy || tok.length < 2) return null;
  // scattered: each character at a word start where possible, else the next one
  const marks: number[] = [];
  let at = 0;
  for (const ch of tok) {
    let j = s.indexOf(ch, at);
    for (let k = j; k >= 0 && k < at + 12; k = s.indexOf(ch, k + 1)) {
      if (wordStart(text, k)) {
        j = k;
        break;
      }
    }
    if (j < 0) return null;
    marks.push(j);
    at = j + 1;
  }
  // initials of words are always fine; loose characters must stay close together
  const loose = marks.filter((k) => !wordStart(text, k)).length;
  const span = marks[marks.length - 1] - marks[0] + 1;
  if (loose && span > tok.length * 3) return null;
  return { score: 4 + (loose ? (span - tok.length) / 10 : 0), marks };
}

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

/** every word of the query must match some field; null when one doesn't. */
export function match(query: string, fields: Field[]): Match | null {
  const toks = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  let score = 0;
  let marks: number[] = [];
  for (const tok of toks) {
    let best: { score: number; marks: number[]; f: number } | null = null;
    fields.forEach((f, i) => {
      const m = matchToken(tok, f.text, !!f.fuzzy);
      if (!m) return;
      const sc = m.score + f.weight;
      if (!best || sc < best.score) best = { score: sc, marks: m.marks, f: i };
    });
    if (!best) return null;
    const b: { score: number; marks: number[]; f: number } = best;
    score += b.score;
    if (b.f === 0) marks = marks.concat(b.marks);
  }
  return { score: score / toks.length, marks: [...new Set(marks)].sort((a, b) => a - b) };
}

/** text split into runs, the matched ones flagged, for highlighting. */
export function runs(text: string, marks: number[]): { t: string; hit: boolean }[] {
  const out: { t: string; hit: boolean }[] = [];
  const set = new Set(marks);
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.t += text[i];
    else out.push({ t: text[i], hit });
  }
  return out;
}
