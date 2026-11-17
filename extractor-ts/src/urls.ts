// Pure helpers for turning request URLs and router paths into codemap route and page
// paths. Kept free of the TypeScript API so they're easy to unit test.

/** A piece of a URL expression: literal text, or a dynamic value with a display name. */
export type Part = { lit: string } | { param: string };

const braceParam = /\{([^}/]+)\}/g;
const templateParam = /\$\{[^}]*\}/g;

/**
 * Mirrors graph.NormalizeRoutePath in Go: drops the query and fragment, turns
 * `${x}` into `:param` and `{id}` into `:id`, adds a leading slash, collapses
 * repeated slashes and drops a trailing one.
 */
export function normalizeRoutePath(p: string): string {
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  p = p.replace(templateParam, ":param");
  p = p.replace(braceParam, (_m, name: string) => {
    const i = name.indexOf(":");
    if (i >= 0) name = name.slice(0, i);
    if (name.endsWith("...")) name = name.slice(0, -3);
    return ":" + name;
  });
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

const MARK = "\u0000";

/** Turns an expression's name into a usable :param name. */
export function paramName(s: string): string {
  return /^[A-Za-z_]\w*$/.test(s) ? s : "param";
}

/**
 * Builds a request path from URL parts.
 *
 * - A dynamic value at the very start that is followed by "/" is treated as an
 *   unknown base URL (`${API_URL}/orders`) and dropped.
 * - A scheme and host (`https://api.example.com`) are dropped.
 * - The query string and fragment are dropped.
 * - The first matching prefix in `prefixes` (e.g. "/api") is stripped.
 *
 * Returns the path as it appears in a route ID (dynamic values become `:param`)
 * and a display form that keeps the value names (`/orders/:id`). Returns null
 * when nothing static is left, e.g. a URL that is entirely dynamic.
 */
export function requestPath(parts: Part[], prefixes: string[] = []): { path: string; pretty: string } | null {
  parts = mergeLits(parts);
  if (parts.length >= 2 && "param" in parts[0] && "lit" in parts[1] && parts[1].lit.startsWith("/")) {
    parts = parts.slice(1);
  }
  let s = "";
  const names: string[] = [];
  for (const p of parts) {
    if ("lit" in p) s += p.lit;
    else {
      s += MARK + names.length + MARK;
      names.push(paramName(p.param));
    }
  }
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#\u0000]*/i, "").replace(/^\/\/[^/?#\u0000]*/, "");
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  if (/\s/.test(s)) return null;
  if (!s.startsWith("/")) {
    if (s.startsWith(MARK)) return null; // starts with a dynamic value we couldn't drop
    s = "/" + s;
  }
  // Reject anything with no static path segment, like "/${path}".
  const stat = s.split("/").filter((seg) => seg !== "" && !seg.includes(MARK));
  if (stat.length === 0 && s.replace(/\/+$/, "") !== "") return null;
  for (let pre of prefixes) {
    pre = normalizeRoutePath(pre);
    if (pre === "/") continue;
    if (s === pre || s === pre + "/") {
      s = "/";
      break;
    }
    if (s.startsWith(pre + "/")) {
      s = s.slice(pre.length);
      break;
    }
  }
  const markRe = new RegExp(MARK + "(\\d+)" + MARK, "g");
  const path = normalizeRoutePath(s.replace(markRe, ":param"));
  const pretty = normalizeRoutePath(s.replace(markRe, (_m, i: string) => ":" + names[Number(i)]));
  return { path, pretty };
}

function mergeLits(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if ("lit" in p && last && "lit" in last) out[out.length - 1] = { lit: last.lit + p.lit };
    else if (!("lit" in p && p.lit === "")) out.push(p);
  }
  return out;
}

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Returns the HTTP method a client method name stands for ("post" → "POST", "del" → "DELETE"). */
export function methodFromName(name: string): string | null {
  const n = name.toUpperCase();
  if (HTTP_METHODS.includes(n)) return n;
  if (n === "DEL" || n === "REMOVE") return "DELETE";
  return null;
}

/**
 * Reports whether a call's callee text matches a configured HTTP client pattern
 * such as "http.post": exactly, or as a suffix after a dot ("api.http.post").
 */
export function matchesClient(callee: string, pattern: string): boolean {
  return callee === pattern || callee.endsWith("." + pattern);
}

/** Joins a nested React Router path onto its parent's. Absolute child paths stand alone. */
export function joinRoutePath(parent: string, child: string | undefined): string {
  if (child === undefined || child === "") return parent || "/";
  if (child.startsWith("/")) return child;
  const base = parent.endsWith("/") ? parent.slice(0, -1) : parent;
  return base + "/" + child;
}

/**
 * Turns a Next.js file path, relative to the app/ or pages/ directory, into a page
 * path. Returns null for files that aren't pages. `kind` is "app" (only page.* files
 * count; route groups and parallel-route slots are dropped) or "pages" (every file
 * except _app, _document, _error, middleware and api/).
 */
export function nextPagePath(rel: string, kind: "app" | "pages"): string | null {
  const segs = rel.split("/");
  const file = segs.pop()!;
  const base = file.replace(/\.(tsx|ts|jsx|js|mdx)$/, "");
  if (base === file) return null;
  if (kind === "app") {
    if (base !== "page") return null;
  } else {
    if (segs[0] === "api") return null;
    if (/^_/.test(base) || base === "middleware" || /\.(test|spec)$/.test(base)) return null;
    if (base !== "index") segs.push(base);
  }
  const out: string[] = [];
  for (const s of segs) {
    if (kind === "app" && (/^\(.*\)$/.test(s) || s.startsWith("@"))) continue;
    if (kind === "app" && s.startsWith("_")) return null; // private folder
    const m = /^\[{1,2}(?:\.\.\.)?([^\]]+)\]{1,2}$/.exec(s);
    out.push(m ? ":" + m[1] : s);
  }
  return normalizeRoutePath("/" + out.join("/"));
}

/** Converts a glob with `**`, `*` and `?` to a RegExp matching the whole path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
