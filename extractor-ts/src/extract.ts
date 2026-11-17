// The TypeScript extractor: loads each TS root with its own tsconfig, finds
// functions, components, pages, server requests and tests, and returns a partial
// codemap graph (PLAN.md §5.2).

import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Part,
  globToRegExp,
  HTTP_METHODS,
  joinRoutePath,
  matchesClient,
  methodFromName,
  nextPagePath,
  normalizeRoutePath,
  paramName,
  requestPath,
} from "./urls.ts";

export interface Config {
  roots?: string[];
  module_depth?: number;
  http_clients?: string[];
  base_url_prefixes?: string[];
  exclude?: string[];
}

export interface Module { id: string; label: string; lang: string; path: string }
export interface GNode {
  id: string; kind: string; label: string; module: string;
  file?: string; line?: number; endLine?: number; doc?: string;
  entry?: boolean; fields?: Record<string, unknown>;
}
export interface Edge { from: string; to: string; type: string; detail?: string; file?: string; line?: number }
export interface Graph { version: number; modules: Module[]; nodes: GNode[]; edges: Edge[] }

/** Calls whose first argument is a React Router route array. */
export const ROUTER_CALLS = ["createBrowserRouter", "createHashRouter", "createMemoryRouter", "createStaticRouter", "useRoutes"];
/** Calls that load a component lazily from `() => import("…")`. */
const LAZY_CALLS = ["lazy", "loadable", "dynamic"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "vendor"]);
const SRC_EXT = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;

/** A function-like thing that becomes a node (or, in test files, a helper that doesn't). */
interface Fn {
  id: string;
  label: string;
  kind: string;
  file: string; // repo-relative
  line: number;
  endLine: number;
  doc: string;
  bodies: ts.Node[];
  helper: boolean; // declared in a test file: not a node; tests walk through it
}

interface TestBlock { id: string; label: string; file: string; line: number; endLine: number; body: ts.Node; mocked: Set<string> }

interface Request { method: string; parts: Part[] }

export function isTestFile(rel: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)__tests__\//.test(rel);
}

/** Finds directories containing a tsconfig.json, skipping dependency and build output dirs. */
export function detectRoots(repo: string, exclude: RegExp[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    const rel = toPosix(path.relative(repo, dir));
    if (rel && exclude.some((re) => re.test(rel) || re.test(rel + "/"))) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (ents.some((e) => e.isFile() && e.name === "tsconfig.json")) out.push(rel || ".");
    for (const e of ents) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name));
    }
  };
  walk(repo);
  return out;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Reads a tsconfig and any project references, returning one parsed config per program. */
function loadConfigs(file: string, warn: (s: string) => void, seen = new Set<string>()): ts.ParsedCommandLine[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const read = ts.readConfigFile(file, ts.sys.readFile);
  if (read.error) {
    warn(`${file}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
    return [];
  }
  const dir = path.dirname(file);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, file);
  // Without node_modules, `extends` and `types` may not resolve. That only loses
  // library types; local files still resolve.
  parsed.options.noEmit = true;
  parsed.options.allowJs ??= true;
  parsed.options.skipLibCheck = true;
  const out = [parsed];
  for (const ref of parsed.projectReferences ?? []) {
    let p = ref.path;
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "tsconfig.json");
    if (fs.existsSync(p)) out.push(...loadConfigs(p, warn, seen));
  }
  return out;
}

export function extract(repo: string, cfg: Config, warn: (s: string) => void = () => {}): Graph {
  repo = path.resolve(repo);
  const exclude = (cfg.exclude ?? []).map(globToRegExp);
  const roots = cfg.roots?.length ? cfg.roots : detectRoots(repo, exclude);
  const prefixes = cfg.base_url_prefixes ?? [];
  const clients = cfg.http_clients ?? [];
  const depth = cfg.module_depth ?? 0;

  const rel = (abs: string) => toPosix(path.relative(repo, abs));
  const excluded = (r: string) =>
    r.startsWith("..") || r.split("/").some((s) => s === "node_modules") || /\.d\.[cm]?ts$/.test(r) || exclude.some((re) => re.test(r));

  // Load programs. Each source file is owned by the first program that lists it.
  const owned = new Map<string, { prog: ts.Program; sf: ts.SourceFile }>();
  const progs: { prog: ts.Program; root: string; files: ts.SourceFile[] }[] = [];
  for (const root of roots) {
    const rootAbs = path.resolve(repo, root);
    const cfgFile = path.join(rootAbs, "tsconfig.json");
    let parsed: ts.ParsedCommandLine[];
    if (fs.existsSync(cfgFile)) parsed = loadConfigs(cfgFile, warn);
    else {
      warn(`${root}: no tsconfig.json; using defaults`);
      const files = ts.sys.readDirectory(rootAbs, [".ts", ".tsx", ".js", ".jsx"], ["**/node_modules", "**/dist", "**/build"]);
      parsed = [{ options: { allowJs: true, jsx: ts.JsxEmit.Preserve, noEmit: true }, fileNames: files, errors: [] }];
    }
    for (const pc of parsed) {
      const names = pc.fileNames.filter((f) => SRC_EXT.test(f) && !excluded(rel(f)) && !owned.has(path.resolve(f)));
      if (names.length === 0) continue;
      const prog = ts.createProgram({ rootNames: names, options: pc.options });
      prog.getTypeChecker(); // binds every file, which also sets parent pointers
      const files: ts.SourceFile[] = [];
      for (const n of names) {
        const sf = prog.getSourceFile(n);
        if (!sf || owned.has(path.resolve(n))) continue;
        owned.set(path.resolve(n), { prog, sf });
        files.push(sf);
      }
      progs.push({ prog, root: rootAbs, files });
    }
  }

  const modules = new Map<string, Module>();
  const moduleOf = (relFile: string): string => {
    let dir = path.posix.dirname(relFile);
    if (depth > 0 && dir !== ".") dir = dir.split("/").slice(0, depth).join("/");
    const id = "mod:ts:" + dir;
    if (!modules.has(id)) modules.set(id, { id, label: dir, lang: "ts", path: dir });
    return id;
  };

  const key = (n: ts.Node) => path.resolve(n.getSourceFile().fileName) + "@" + n.pos + ":" + n.kind;
  const fns = new Map<string, Fn>(); // by id
  const byKey = new Map<string, Fn>(); // declaration or function node key → fn
  const fnNodes = new Set<string>(); // keys of function-like nodes that are their own fn
  const tests: TestBlock[] = [];
  const nodes: GNode[] = [];
  const edges: Edge[] = [];
  const edgeSeen = new Set<string>();
  const addEdge = (e: Edge) => {
    if (e.from === e.to) return;
    const k = e.from + "\0" + e.to + "\0" + e.type;
    if (edgeSeen.has(k)) return;
    edgeSeen.add(k);
    edges.push(e);
  };

  // ---- Pass 1: find functions (syntactic). ----
  for (const { files } of progs) {
    for (const sf of files) {
      const r = rel(sf.fileName);
      moduleOf(r);
      collectFns(sf, r, isTestFile(r));
      if (isTestFile(r)) collectTests(sf, r);
    }
  }

  function register(label: string, kind: string, sf: ts.SourceFile, r: string, span: ts.Node, docNode: ts.Node, decls: ts.Node[], body: ts.Node, helper: boolean): Fn {
    let id = "ts:" + r + "#" + label;
    for (let i = 2; fns.has(id); i++) id = "ts:" + r + "#" + label + "~" + i;
    const fn: Fn = {
      id, label, kind, file: r,
      line: lineOf(sf, span.getStart(sf)),
      endLine: lineOf(sf, span.getEnd()),
      doc: docOf(sf, docNode),
      bodies: [body], helper,
    };
    fns.set(id, fn);
    for (const d of decls) byKey.set(key(d), fn);
    fnNodes.add(key(body));
    return fn;
  }

  function collectFns(sf: ts.SourceFile, r: string, helper: boolean) {
    const tsx = /\.[jt]sx$/.test(r);
    const kindFor = (name: string, fnNode: ts.Node) =>
      tsx && /^[A-Z]/.test(name) && containsJsx(fnNode) ? "component" : "function";
    const join = (owner: string | null, name: string) => (owner ? owner + "." + name : name);

    const visit = (n: ts.Node, owner: string | null): void => {
      if (ts.isFunctionDeclaration(n) && n.body) {
        const isDefault = n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        const name = n.name?.text ?? (isDefault ? "default" : undefined);
        if (name) {
          const label = join(owner, name);
          register(label, kindFor(name, n), sf, r, n, n, [n], n, helper);
          ts.forEachChild(n, (c) => visit(c, label));
          return;
        }
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const name = n.name.text;
        const fnNode = functionOf(n.initializer, owner === null);
        const stmt = n.parent?.parent && ts.isVariableStatement(n.parent.parent) && (n.parent as ts.VariableDeclarationList).declarations[0] === n ? n.parent.parent : n;
        if (fnNode) {
          const label = join(owner, name);
          register(label, kindFor(name, fnNode), sf, r, stmt, stmt, [n, fnNode], fnNode, helper);
          ts.forEachChild(fnNode, (c) => visit(c, label));
          return;
        }
        const obj = unwrapExpr(n.initializer);
        if (owner === null && ts.isObjectLiteralExpression(obj)) {
          collectObject(obj, name);
          return;
        }
      }
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
        collectClass(n, owner);
        return;
      }
      if (ts.isExportAssignment(n) && owner === null) {
        const fnNode = functionOf(n.expression, true);
        if (fnNode && !(ts.isFunctionExpression(fnNode) && fnNode.name && byKey.has(key(fnNode)))) {
          const name = (ts.isFunctionExpression(fnNode) && fnNode.name?.text) || "default";
          register(name, kindFor(name, fnNode), sf, r, n, n, [n, fnNode], fnNode, helper);
          ts.forEachChild(fnNode, (c) => visit(c, name));
          return;
        }
      }
      ts.forEachChild(n, (c) => visit(c, owner));
    };

    const collectObject = (obj: ts.ObjectLiteralExpression, prefix: string) => {
      for (const p of obj.properties) {
        const pname = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
        if (!pname) {
          visit(p, null);
          continue;
        }
        const label = prefix + "." + pname;
        let fnNode: ts.Node | undefined;
        if (ts.isMethodDeclaration(p) && p.body) fnNode = p;
        else if (ts.isPropertyAssignment(p)) {
          fnNode = functionOf(p.initializer, false);
          const inner = unwrapExpr(p.initializer);
          if (!fnNode && ts.isObjectLiteralExpression(inner)) {
            collectObject(inner, label);
            continue;
          }
        }
        if (fnNode) {
          register(label, kindFor(pname, fnNode), sf, r, p, p, [p, fnNode], fnNode, helper);
          ts.forEachChild(fnNode, (c) => visit(c, label));
        } else visit(p, null);
      }
    };

    const collectClass = (c: ts.ClassLikeDeclaration, owner: string | null) => {
      const isDefault = c.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      let cname = c.name?.text ?? (isDefault ? "default" : undefined);
      if (!cname && ts.isClassExpression(c) && ts.isVariableDeclaration(c.parent) && ts.isIdentifier(c.parent.name)) cname = c.parent.name.text;
      if (!cname) {
        ts.forEachChild(c, (x) => visit(x, owner));
        return;
      }
      const clabel = join(owner, cname);
      const render = c.members.find((m) => ts.isMethodDeclaration(m) && m.name.getText(sf) === "render" && m.body) as ts.MethodDeclaration | undefined;
      const isComponent = tsx && /^[A-Z]/.test(cname) && !!render && containsJsx(render);
      if (isComponent) register(clabel, "component", sf, r, c, c, [c, render!], render!, helper);
      for (const m of c.members) {
        if (m === render && isComponent) {
          ts.forEachChild(m, (x) => visit(x, clabel));
          continue;
        }
        const mname = m.name && (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : undefined;
        let fnNode: ts.Node | undefined;
        if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.body) fnNode = m;
        else if (ts.isConstructorDeclaration(m) && m.body) fnNode = m;
        else if (ts.isPropertyDeclaration(m) && m.initializer) fnNode = functionOf(m.initializer, false);
        if (!fnNode) {
          ts.forEachChild(m, (x) => visit(x, clabel));
          continue;
        }
        const label = clabel + "." + (ts.isConstructorDeclaration(m) ? "constructor" : mname ?? "anonymous");
        const decls = ts.isConstructorDeclaration(m) && !isComponent ? [m, fnNode, c] : [m, fnNode];
        register(label, "function", sf, r, m, m, decls, fnNode, helper);
        ts.forEachChild(fnNode, (x) => visit(x, label));
      }
    };

    visit(sf, null);
  }

  function collectTests(sf: ts.SourceFile, r: string) {
    // vi.mock("x") / jest.mock("x"): what the test imports from x is a mock.
    const mocked = new Set<string>();
    const opts = owned.get(path.resolve(sf.fileName))!.prog.getCompilerOptions();
    const scan = (n: ts.Node) => {
      if (ts.isCallExpression(n) && /^(vi|jest)\.(mock|doMock)$/.test(n.expression.getText(sf)) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        const spec = n.arguments[0].text;
        mocked.add("spec:" + spec);
        const res = ts.resolveModuleName(spec, sf.fileName, opts, ts.sys).resolvedModule;
        if (res) mocked.add(path.resolve(res.resolvedFileName));
      }
      ts.forEachChild(n, scan);
    };
    scan(sf);

    const visit = (n: ts.Node, describes: string[]) => {
      if (ts.isCallExpression(n)) {
        const t = testCall(n, sf);
        if (t && t.kind === "describe") {
          const fn = n.arguments.find((a) => ts.isFunctionLike(a));
          if (fn) ts.forEachChild(fn, (c) => visit(c, [...describes, t.name]));
          return;
        }
        if (t && t.kind === "test") {
          const body = n.arguments.find((a, i) => i > 0 && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)));
          if (body) {
            const label = [...describes, t.name].join(" > ");
            let id = "test:ts:" + r + "#" + label;
            for (let i = 2; tests.some((x) => x.id === id); i++) id = "test:ts:" + r + "#" + label + " ~" + i;
            tests.push({ id, label, file: r, line: lineOf(sf, n.getStart(sf)), endLine: lineOf(sf, n.getEnd()), body, mocked });
          }
          return;
        }
      }
      ts.forEachChild(n, (c) => visit(c, describes));
    };
    visit(sf, []);
  }

  // ---- Pass 2: resolve references, JSX, requests, pages. ----
  const fetches: { from: string; edge: Edge }[] = [];
  const pages = new Map<string, GNode>();

  const fnsByFile = new Map<string, Fn[]>();
  for (const f of fns.values()) {
    if (!fnsByFile.has(f.file)) fnsByFile.set(f.file, []);
    fnsByFile.get(f.file)!.push(f);
  }

  for (const { prog, root, files } of progs) {
    const checker = prog.getTypeChecker();

    const symOf = (n: ts.Node): ts.Symbol | undefined => {
      try {
        if (ts.isShorthandPropertyAssignment(n)) return checker.getShorthandAssignmentValueSymbol(n);
        return checker.getSymbolAtLocation(n);
      } catch {
        return undefined;
      }
    };
    const unalias = (s: ts.Symbol): ts.Symbol => {
      if (s.flags & ts.SymbolFlags.Alias) {
        try {
          const a = checker.getAliasedSymbol(s);
          if (a && !(a.flags & ts.SymbolFlags.Alias) && a.declarations?.length) return a;
          return a ?? s;
        } catch {
          return s;
        }
      }
      return s;
    };

    // Resolves a symbol to the fn it declares, following aliases, `export default X`,
    // `const X = memo(Y)` and `lazy(() => import("./X"))`.
    const fnOfSymbol = (s: ts.Symbol | undefined, depth = 0): Fn | undefined => {
      if (!s || depth > 5) return undefined;
      s = unalias(s);
      for (const d of s.declarations ?? []) {
        const f = byKey.get(key(d));
        if (f) return f;
        if (ts.isExportAssignment(d)) {
          const f2 = fnOfExpr(d.expression, depth + 1);
          if (f2) return f2;
        }
        if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer) {
          const f2 = fnOfExpr(d.initializer, depth + 1);
          if (f2) return f2;
        }
        if (ts.isExportSpecifier(d) || ts.isImportSpecifier(d) || ts.isImportClause(d)) {
          const f2 = fnOfSymbol(symOf(d.name ?? d), depth + 1);
          if (f2) return f2;
        }
      }
      return undefined;
    };
    const fnOfExpr = (e: ts.Expression, depth = 0): Fn | undefined => {
      if (depth > 5) return undefined;
      e = unwrapExpr(e);
      const direct = byKey.get(key(e));
      if (direct) return direct;
      if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) return fnOfSymbol(symOf(ts.isPropertyAccessExpression(e) ? e.name : e), depth + 1);
      if (ts.isCallExpression(e)) {
        const imp = lazyImport(e);
        if (imp) return defaultExportFn(imp, depth + 1);
        for (const a of e.arguments) {
          const f = fnOfExpr(a, depth + 1);
          if (f) return f;
        }
      }
      return undefined;
    };
    // The module behind `import("./X")`: its default export, or `Component` (React Router lazy).
    const defaultExportFn = (spec: ts.Expression, depth: number): Fn | undefined => {
      const mod = symOf(spec);
      if (!mod) return undefined;
      for (const name of ["default", "Component"]) {
        let s: ts.Symbol | undefined;
        try {
          s = checker.tryGetMemberInModuleExports(name, mod);
        } catch {
          s = undefined;
        }
        const f = fnOfSymbol(s, depth);
        if (f) return f;
      }
      return undefined;
    };
    const fnOfSourceFileDefault = (sf: ts.SourceFile): Fn | undefined => {
      const mod = checker.getSymbolAtLocation(sf);
      if (!mod) return undefined;
      return fnOfSymbol(checker.tryGetMemberInModuleExports("default", mod));
    };

    // Walk one fn body (or test body), reporting resolved references.
    const walk = (root: ts.Node, sf: ts.SourceFile, from: string, onRef: (f: Fn, type: string, at: ts.Node) => void, inTest?: TestBlock) => {
      const mockedRef = (n: ts.Node): boolean => {
        if (!inTest) return false;
        let left: ts.Node = n;
        if (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) {
          left = n.parent.expression;
          while (ts.isPropertyAccessExpression(left)) left = left.expression;
        }
        const s = symOf(left);
        const d = s?.declarations?.[0];
        if (!d) return false;
        const imp = ts.findAncestor(d, ts.isImportDeclaration);
        if (!imp || !ts.isStringLiteral(imp.moduleSpecifier)) return false;
        if (inTest.mocked.has("spec:" + imp.moduleSpecifier.text)) return true;
        const res = ts.resolveModuleName(imp.moduleSpecifier.text, sf.fileName, prog.getCompilerOptions(), ts.sys).resolvedModule;
        return !!res && inTest.mocked.has(path.resolve(res.resolvedFileName));
      };
      const ref = (target: ts.Node, at: ts.Node, type: string) => {
        if (mockedRef(target)) return;
        const f = fnOfSymbol(symOf(target));
        if (!f || f.id === from) return;
        if (inTest && inTest.mocked.has(path.resolve(repo, f.file))) return;
        onRef(f, type, at);
      };
      const visit = (n: ts.Node): void => {
        if (n !== root && fnNodes.has(key(n))) return;
        if (ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isImportDeclaration(n)) return;
        if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
          const tag = n.tagName;
          const target = ts.isPropertyAccessExpression(tag) ? tag.name : tag;
          if (ts.isIdentifier(target) && /^[A-Z]/.test(target.text) || ts.isPropertyAccessExpression(tag)) ref(target, n, "renders");
          visit(n.attributes);
          return;
        }
        if (ts.isJsxClosingElement(n)) return;
        if (ts.isShorthandPropertyAssignment(n)) {
          ref(n, n, "calls");
          return;
        }
        if (ts.isIdentifier(n)) {
          const p = n.parent;
          const isName = !ts.isPropertyAccessExpression(p) && ((p as any).name === n || (p as any).propertyName === n);
          if (!isName) ref(n, n, "calls");
          return;
        }
        if (ts.isCallExpression(n) && !inTest) {
          const req = detectRequest(n, sf);
          if (req) {
            const p = requestPath(req.parts, prefixes);
            if (p) {
              fetches.push({
                from,
                edge: { from, to: "route:" + req.method + " " + p.path, type: "fetches", detail: req.method + " " + p.pretty, file: rel(sf.fileName), line: lineOf(sf, n.getStart(sf)) },
              });
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(root);
    };

    // ---- Requests to the server. ----
    const constParts = (e: ts.Expression, depth: number): Part[] | null => {
      e = unwrapExpr(e);
      if (ts.isStringLiteralLike(e)) return [{ lit: e.text }];
      if (ts.isTemplateExpression(e)) {
        const out: Part[] = [{ lit: e.head.text }];
        for (const s of e.templateSpans) {
          out.push(...(constParts(s.expression, depth + 1) ?? [{ param: exprName(s.expression) }]));
          out.push({ lit: s.literal.text });
        }
        return out;
      }
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const l = constParts(e.left, depth + 1);
        const r = constParts(e.right, depth + 1);
        if (!l && !r) return null;
        return [...(l ?? [{ param: exprName(e.left) }]), ...(r ?? [{ param: exprName(e.right) }])];
      }
      if ((ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) && depth < 4) {
        const s = symOf(ts.isPropertyAccessExpression(e) ? e.name : e);
        const d = s && unalias(s).declarations?.[0];
        if (d && ts.isVariableDeclaration(d) && d.initializer && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) {
          return constParts(d.initializer, depth + 1);
        }
      }
      return null;
    };
    const constString = (e: ts.Expression): string | null => {
      const p = constParts(e, 0);
      if (!p || p.some((x) => "param" in x)) return null;
      return p.map((x) => ("lit" in x ? x.lit : "")).join("");
    };
    // Reads {url, method} from a request config object.
    const fromConfig = (o: ts.Expression, method: string | null): Request | null => {
      o = unwrapExpr(o);
      if (!ts.isObjectLiteralExpression(o)) return null;
      let url: Part[] | null = null;
      for (const p of o.properties) {
        if (!ts.isPropertyAssignment(p) || !p.name || !ts.isIdentifier(p.name)) continue;
        if (p.name.text === "url") url = constParts(p.initializer, 0);
        if (p.name.text === "method") {
          const m = constString(p.initializer);
          if (!m) return null;
          method = m.toUpperCase();
        }
      }
      return url ? { method: method ?? "GET", parts: url } : null;
    };
    const methodOption = (o: ts.Expression | undefined): string | null | undefined => {
      // undefined: no method given; null: given but not a constant.
      if (!o) return undefined;
      o = unwrapExpr(o);
      if (!ts.isObjectLiteralExpression(o)) return null;
      for (const p of o.properties) {
        if (p.name && ts.isIdentifier(p.name) && p.name.text === "method") {
          if (!ts.isPropertyAssignment(p)) return null;
          const m = constString(p.initializer);
          return m ? m.toUpperCase() : null;
        }
        if (ts.isSpreadAssignment(p)) return null;
      }
      return undefined;
    };
    const isAxiosInstance = (e: ts.Expression): boolean => {
      const s = symOf(e);
      const d = s && unalias(s).declarations?.[0];
      if (!d || !(ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)) || !d.initializer) return false;
      const init = unwrapExpr(d.initializer);
      return ts.isCallExpression(init) && /(^|\.)axios\.create$/.test(calleeText(init.expression));
    };
    const detectRequest = (call: ts.CallExpression, sf: ts.SourceFile): Request | null => {
      const callee = calleeText(call.expression);
      const args = call.arguments;
      if (/^((window|globalThis|self)\.)?fetch$/.test(callee)) {
        if (fnOfSymbol(symOf(call.expression))) return null; // a local function called fetch
        const parts = args[0] && constParts(args[0], 0);
        if (!parts) return null;
        const m = methodOption(args[1]);
        if (m === null) return null;
        return { method: m ?? "GET", parts };
      }
      // axios.get(url), axios(config), axios.request(config), and instances from axios.create().
      let verb: string | null = null;
      let isAxios = false;
      if (callee === "axios") isAxios = true;
      else if (ts.isPropertyAccessExpression(call.expression)) {
        const obj = call.expression.expression;
        const name = call.expression.name.text;
        if (calleeText(obj) === "axios" || isAxiosInstance(obj)) {
          isAxios = true;
          verb = name === "request" ? null : methodFromName(name);
          if (!verb && name !== "request") return null;
        }
      }
      if (isAxios) {
        if (!verb) return args[0] ? fromConfig(args[0], null) : null;
        const parts = args[0] && constParts(args[0], 0);
        return parts ? { method: verb, parts } : null;
      }
      // Configured wrappers, matched by callee text or by the label of the declaration it resolves to.
      let pattern = clients.find((c) => matchesClient(callee, c));
      if (!pattern) {
        const f = fnOfSymbol(symOf(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression));
        if (f) pattern = clients.find((c) => matchesClient(f.label, c));
      }
      if (!pattern) return null;
      let method = methodFromName(pattern.split(".").pop()!);
      let i = 0;
      if (!method) {
        // request("POST", "/x") style: a constant HTTP method, then the URL.
        const m = args[0] && constString(args[0]);
        if (m && HTTP_METHODS.includes(m.toUpperCase())) {
          method = m.toUpperCase();
          i = 1;
        }
      }
      const a = args[i];
      if (!a) return null;
      const parts = constParts(a, 0);
      if (!parts) return fromConfig(a, method);
      return parts ? { method: method ?? "GET", parts } : null;
    };

    for (const sf of files) {
      const r = rel(sf.fileName);
      // Function bodies.
      for (const fn of fnsByFile.get(r) ?? []) {
        if (fn.helper) continue;
        for (const b of fn.bodies) {
          walk(b, sf, fn.id, (f, type, at) => {
            if (f.helper) return;
            addEdge({ from: fn.id, to: f.id, type, file: r, line: lineOf(sf, at.getStart(sf)) });
          });
        }
      }
      // Tests: walk the body, and through helpers declared in test files.
      for (const t of tests) {
        if (t.file !== r) continue; // tests are few; a linear scan is fine
        const seen = new Set<string>();
        const onRef = (f: Fn, type: string, at: ts.Node) => {
          if (f.helper) {
            if (seen.has(f.id)) return;
            seen.add(f.id);
            for (const b of f.bodies) walk(b, b.getSourceFile(), t.id, onRef, t);
            return;
          }
          addEdge({ from: t.id, to: f.id, type, file: t.file, line: lineOf(at.getSourceFile(), at.getStart()) });
        };
        walk(t.body, sf, t.id, onRef, t);
      }
      // React Router pages.
      findRouterPages(sf, r);
    }

    // Next.js file-convention pages and app/ route handlers.
    if (isNext(root)) {
      for (const sf of files) {
        const abs = path.resolve(sf.fileName);
        for (const dir of ["app", "src/app", "pages", "src/pages"]) {
          const base = path.join(root, dir) + path.sep;
          if (!abs.startsWith(base)) continue;
          const sub = toPosix(abs.slice(base.length));
          const kind = dir.endsWith("app") ? "app" : "pages";
          if (kind === "app" && /(^|\/)route\.[jt]sx?$/.test(sub)) {
            appRouteHandlers(sf, sub);
            continue;
          }
          if (isTestFile(sub)) continue;
          const p = nextPagePath(sub, kind);
          if (!p) continue;
          const f = fnOfSourceFileDefault(sf);
          addPage(p, f ? [f] : [], sf, sf.statements.find((s) => ts.isExportAssignment(s) || hasDefault(s)) ?? sf);
        }
      }
    }

    function appRouteHandlers(sf: ts.SourceFile, sub: string) {
      const segs = sub.split("/");
      segs.pop();
      const out: string[] = [];
      for (const s of segs) {
        if (/^\(.*\)$/.test(s) || s.startsWith("@")) continue;
        const m = /^\[{1,2}(?:\.\.\.)?([^\]]+)\]{1,2}$/.exec(s);
        out.push(m ? ":" + m[1] : s);
      }
      const p = normalizeRoutePath("/" + out.join("/"));
      const r = rel(sf.fileName);
      for (const m of HTTP_METHODS) {
        const f = byKeyName(r, m);
        if (!f) continue;
        const id = "route:" + m + " " + p;
        nodes.push({ id, kind: "route", label: p, module: moduleOf(r), file: r, line: f.line, entry: true, fields: { method: m } });
        addEdge({ from: id, to: f.id, type: "calls" });
      }
    }

    function byKeyName(r: string, label: string): Fn | undefined {
      return fns.get("ts:" + r + "#" + label);
    }

    function findRouterPages(sf: ts.SourceFile, r: string) {
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) {
          const name = calleeText(n.expression).split(".").pop()!;
          if (ROUTER_CALLS.includes(name) && n.arguments[0]) {
            const arr = resolveArray(n.arguments[0]);
            if (arr) routesFromArray(arr, "");
          }
        }
        if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && isRouteTag(n)) {
          routeFromJsx(n, "");
          return;
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }

    function resolveArray(e: ts.Expression, depth = 0): ts.ArrayLiteralExpression | undefined {
      e = unwrapExpr(e);
      if (ts.isArrayLiteralExpression(e)) return e;
      if ((ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) && depth < 4) {
        const s = symOf(ts.isPropertyAccessExpression(e) ? e.name : e);
        const d = s && unalias(s).declarations?.[0];
        if (d && ts.isVariableDeclaration(d) && d.initializer) return resolveArray(d.initializer, depth + 1);
      }
      return undefined;
    }

    function resolveObject(e: ts.Expression, depth = 0): ts.ObjectLiteralExpression | undefined {
      e = unwrapExpr(e);
      if (ts.isObjectLiteralExpression(e)) return e;
      if (ts.isIdentifier(e) && depth < 4) {
        const d = symOf(e) && unalias(symOf(e)!).declarations?.[0];
        if (d && ts.isVariableDeclaration(d) && d.initializer) return resolveObject(d.initializer, depth + 1);
      }
      return undefined;
    }

    function routesFromArray(arr: ts.ArrayLiteralExpression, prefix: string) {
      for (const el of arr.elements) {
        if (ts.isSpreadElement(el)) {
          const a = resolveArray(el.expression);
          if (a) routesFromArray(a, prefix);
          continue;
        }
        const o = resolveObject(el);
        if (!o) continue;
        let p: string | undefined;
        let index = false;
        let comps: Fn[] = [];
        let children: ts.ArrayLiteralExpression | undefined;
        for (const prop of o.properties) {
          if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
          const name = prop.name.getText();
          const init = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
          if (name === "path") p = constString(init) ?? undefined;
          else if (name === "index") index = init.kind === ts.SyntaxKind.TrueKeyword;
          else if (name === "element") comps = jsxComponents(init);
          else if (name === "Component" || name === "component") {
            const f = fnOfExpr(init);
            if (f) comps = [f];
          } else if (name === "lazy") {
            const imp = lazyImport(init);
            const f = imp && defaultExportFn(imp, 0);
            if (f) comps = [f];
          } else if (name === "children") children = resolveArray(init);
        }
        const full = p !== undefined ? joinRoutePath(prefix, p) : prefix;
        if ((p !== undefined || index) && (comps.length || !children)) addPage(full || "/", comps, o.getSourceFile(), o);
        if (children) routesFromArray(children, full);
      }
    }

    function routeFromJsx(el: ts.JsxElement | ts.JsxSelfClosingElement, prefix: string) {
      const attrs = ts.isJsxElement(el) ? el.openingElement.attributes : el.attributes;
      let p: string | undefined;
      let index = false;
      let comps: Fn[] = [];
      for (const a of attrs.properties) {
        if (!ts.isJsxAttribute(a)) continue;
        const name = a.name.getText();
        const init = a.initializer;
        const expr = init && ts.isJsxExpression(init) ? init.expression : init && ts.isStringLiteral(init) ? init : undefined;
        if (name === "index") index = !init || (expr?.kind === ts.SyntaxKind.TrueKeyword);
        if (!expr) continue;
        if (name === "path") p = constString(expr) ?? undefined;
        else if (name === "element" || name === "render") comps = jsxComponents(expr);
        else if (name === "Component" || name === "component") {
          const f = fnOfExpr(expr);
          if (f) comps = [f];
        }
      }
      const full = p !== undefined ? joinRoutePath(prefix, p) : prefix;
      // A Route with children but no element is just a path prefix.
      if (ts.isJsxElement(el) && !comps.length) {
        // Route children given directly (v5 style): <Route path="/x"><Page /></Route>
        const direct = el.children.flatMap((c) => (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) && !isRouteTag(c) ? jsxComponents(c) : []);
        if (direct.length && (p !== undefined || index)) addPage(full || "/", direct, el.getSourceFile(), el);
      } else if (p !== undefined || index) addPage(full || "/", comps, el.getSourceFile(), el);
      if (ts.isJsxElement(el)) {
        const kids = (n: ts.Node) => {
          if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && isRouteTag(n)) {
            routeFromJsx(n, full);
            return;
          }
          ts.forEachChild(n, kids);
        };
        el.children.forEach(kids);
      }
    }

    // Components rendered by a JSX expression, outermost first.
    function jsxComponents(e: ts.Node): Fn[] {
      const out: Fn[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
          const t = ts.isPropertyAccessExpression(n.tagName) ? n.tagName.name : n.tagName;
          const f = fnOfSymbol(symOf(t));
          if (f && !out.includes(f)) out.push(f);
        }
        ts.forEachChild(n, visit);
      };
      visit(e);
      return out;
    }

    function addPage(p: string, comps: Fn[], sf: ts.SourceFile, at: ts.Node) {
      const id = "page:" + normalizeRoutePath(p);
      const r = rel(sf.fileName);
      if (!pages.has(id)) {
        const mod = comps.length ? moduleOf(comps[comps.length - 1].file) : moduleOf(r);
        const node: GNode = { id, kind: "page", label: normalizeRoutePath(p), module: mod, file: r, line: lineOf(sf, at === sf ? 0 : at.getStart(sf)), entry: true };
        pages.set(id, node);
      }
      for (const c of comps) addEdge({ from: id, to: c.id, type: "renders" });
    }
  }

  // Requests inside a configured wrapper's own definition (and the same-file
  // functions it calls) are the wrapper's plumbing, not calls to a route.
  const wrapperDefs = new Set<string>();
  for (const f of fns.values()) if (clients.some((c) => matchesClient(f.label, c))) wrapperDefs.add(f.id);
  const queue = [...wrapperDefs];
  while (queue.length) {
    const id = queue.pop()!;
    const file = fns.get(id)!.file;
    for (const e of edges) {
      if (e.from === id && e.type === "calls" && fns.get(e.to)?.file === file && !wrapperDefs.has(e.to)) {
        wrapperDefs.add(e.to);
        queue.push(e.to);
      }
    }
  }
  for (const { from, edge } of fetches) if (!wrapperDefs.has(from)) addEdge(edge);

  for (const f of fns.values()) {
    if (f.helper) continue;
    const n: GNode = { id: f.id, kind: f.kind, label: f.label, module: moduleOf(f.file), file: f.file, line: f.line };
    if (f.endLine > f.line) n.endLine = f.endLine;
    if (f.doc) n.doc = f.doc;
    nodes.push(n);
  }
  for (const t of tests) {
    nodes.push({ id: t.id, kind: "test", label: t.label, module: moduleOf(t.file), file: t.file, line: t.line, endLine: t.endLine });
  }
  nodes.push(...pages.values());

  return { version: 1, modules: [...modules.values()], nodes, edges };
}

function isNext(root: string): boolean {
  if (["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"].some((f) => fs.existsSync(path.join(root, f)))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return !!(pkg.dependencies?.next || pkg.devDependencies?.next);
  } catch {
    return false;
  }
}

function hasDefault(s: ts.Statement): boolean {
  return ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function isRouteTag(n: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  const tag = ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName;
  const t = tag.getText();
  return t === "Route" || t.endsWith(".Route");
}

/** `test("name", fn)`, `it.only(…)`, `test.each(rows)("name", fn)`, `describe(…)`. */
export function testCall(n: ts.CallExpression, sf: ts.SourceFile): { kind: "test" | "describe"; name: string } | null {
  let callee = n.expression;
  if (ts.isCallExpression(callee)) callee = callee.expression; // .each(rows)
  const text = callee.getText(sf).replace(/\.(only|skip|concurrent|sequential|fails|todo|each|skipIf\(.*\)|runIf\(.*\))/g, "");
  const kind = text === "test" || text === "it" ? "test" : text === "describe" || text === "suite" ? "describe" : null;
  if (!kind) return null;
  const a = n.arguments[0];
  if (!a) return null;
  const name = ts.isStringLiteralLike(a) ? a.text : a.getText(sf);
  return { kind, name };
}

/** Returns the function an initializer stands for: the function itself, or for
 *  top-level declarations, a function passed to a wrapping call (`memo(() => …)`). */
function functionOf(e: ts.Expression, unwrapCalls: boolean): ts.FunctionLikeDeclaration | undefined {
  e = unwrapExpr(e);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
  if (ts.isCallExpression(e)) {
    const callee = calleeText(e.expression);
    if (!unwrapCalls && !/(^|\.)useCallback$/.test(callee)) return undefined;
    if (lazyImport(e)) return undefined;
    for (const a of e.arguments) {
      const f = functionOf(a, unwrapCalls);
      if (f) return f;
    }
  }
  return undefined;
}

function unwrapExpr(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

/** For `lazy(() => import("./X"))`-style calls (or a bare `() => import("./X")`), the module specifier. */
function lazyImport(e: ts.Expression): ts.Expression | undefined {
  e = unwrapExpr(e);
  if (ts.isCallExpression(e) && !(e.expression.kind === ts.SyntaxKind.ImportKeyword)) {
    const name = calleeText(e.expression).split(".").pop()!;
    if (!LAZY_CALLS.includes(name) || !e.arguments[0]) return undefined;
    e = unwrapExpr(e.arguments[0]);
  }
  if (!(ts.isArrowFunction(e) || ts.isFunctionExpression(e))) return undefined;
  let found: ts.Expression | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0]) found = n.arguments[0];
    else ts.forEachChild(n, visit);
  };
  visit(e.body);
  return found;
}

function calleeText(e: ts.Expression): string {
  e = unwrapExpr(e);
  if (ts.isIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(e)) {
    const left = calleeText(e.expression);
    const s = left === "this" ? e.name.text : left + "." + e.name.text;
    return s;
  }
  return "";
}

function exprName(e: ts.Expression): string {
  e = unwrapExpr(e);
  if (ts.isIdentifier(e)) return paramName(e.text);
  if (ts.isPropertyAccessExpression(e)) return paramName(e.name.text);
  if (ts.isCallExpression(e) && e.arguments[0]) return exprName(e.arguments[0]);
  return "param";
}

function containsJsx(n: ts.Node): boolean {
  let found = false;
  const visit = (c: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c) || ts.isJsxFragment(c)) found = true;
    else ts.forEachChild(c, visit);
  };
  ts.forEachChild(n, visit);
  return found;
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** The JSDoc or comment directly above a declaration, as one line of text. */
export function docOf(sf: ts.SourceFile, n: ts.Node): string {
  const text = sf.getFullText();
  const ranges = ts.getLeadingCommentRanges(text, n.getFullStart()) ?? [];
  if (!ranges.length) return "";
  // Take the last comment, plus any // comments on the lines right above it.
  let i = ranges.length - 1;
  if (lineOf(sf, n.getStart(sf)) - lineOf(sf, ranges[i].end) > 1) return "";
  let start = i;
  while (start > 0 && ranges[start].kind === ts.SyntaxKind.SingleLineCommentTrivia && ranges[start - 1].kind === ts.SyntaxKind.SingleLineCommentTrivia && lineOf(sf, ranges[start].pos) - lineOf(sf, ranges[start - 1].pos) === 1) start--;
  const lines: string[] = [];
  for (let j = start; j <= i; j++) {
    const raw = text.slice(ranges[j].pos, ranges[j].end);
    if (ranges[j].kind === ts.SyntaxKind.SingleLineCommentTrivia) lines.push(raw.replace(/^\/\/+\s?/, ""));
    else lines.push(...raw.replace(/^\/\*+/, "").replace(/\*+\/$/, "").split("\n").map((l) => l.replace(/^\s*\*?\s?/, "")));
  }
  const out: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("@")) break; // JSDoc tags
    if (t) out.push(t);
  }
  const doc = out.join(" ");
  if (/^(eslint|@ts-|prettier-ignore|istanbul|#region|biome-ignore|TODO\b)/i.test(doc)) return "";
  return doc;
}
