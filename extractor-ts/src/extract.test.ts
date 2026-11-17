import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extract, type Config, type Graph } from "./extract.ts";

const tsconfig = JSON.stringify({ compilerOptions: { jsx: "react-jsx", module: "ESNext", moduleResolution: "Bundler", strict: true, paths: { "@/*": ["./src/*"] } }, include: ["src", "app", "pages"] });

/** Writes files into a fresh temp repo (with a tsconfig at the root) and extracts it. */
function run(files: Record<string, string>, cfg: Config = {}): Graph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-ts-"));
  files = { "tsconfig.json": tsconfig, ...files };
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  try {
    return extract(dir, cfg);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const edgeSet = (g: Graph, type?: string) => new Set(g.edges.filter((e) => !type || e.type === type).map((e) => `${e.from} -> ${e.to}`));
const ids = (g: Graph) => new Set(g.nodes.map((n) => n.id));

test("React Router: createBrowserRouter with nested children, Component and lazy", () => {
  const g = run({
    "src/pages/Home.tsx": "export function Home() { return <div/>; }",
    "src/pages/Shell.tsx": "export function Shell() { return <main/>; }",
    "src/pages/Order.tsx": "export function Order() { return <p/>; }",
    "src/pages/Lazy.tsx": "export default function LazyPage() { return <p/>; }",
    "src/routes.tsx": `
      import { createBrowserRouter } from "react-router-dom";
      import { Home } from "./pages/Home";
      import { Shell } from "@/pages/Shell";
      import { Order } from "./pages/Order";
      const paths = { orders: { path: "orders" } } as const;
      const orderRoutes = [{ path: ":id", Component: Order }];
      export const router = createBrowserRouter([
        { path: "/", element: <Shell />, children: [
          { index: true, element: <Home /> },
          { path: paths.orders.path, children: orderRoutes },
          { path: "lazy", lazy: () => import("./pages/Lazy") },
        ] },
      ]);`,
  });
  const r = edgeSet(g, "renders");
  assert.ok(r.has("page:/ -> ts:src/pages/Shell.tsx#Shell"), "path alias resolves");
  assert.ok(r.has("page:/ -> ts:src/pages/Home.tsx#Home"), "index route joins parent");
  assert.ok(r.has("page:/orders/:id -> ts:src/pages/Order.tsx#Order"), "nested via identifier");
  assert.ok(r.has("page:/lazy -> ts:src/pages/Lazy.tsx#LazyPage"), "lazy import");
  assert.ok(!ids(g).has("page:/orders"), "a pathless-element route is just a prefix");
  const page = g.nodes.find((n) => n.id === "page:/orders/:id")!;
  assert.equal(page.module, "mod:ts:src/pages");
  assert.equal(page.entry, true);
});

test("React Router: <Route> JSX, nested paths joined, React.lazy components", () => {
  const g = run({
    "src/A.tsx": "export function A() { return <div/>; }",
    "src/B.tsx": "export default function B() { return <div/>; }",
    "src/App.tsx": `
      import { lazy } from "react";
      import { Routes, Route } from "react-router-dom";
      import { A } from "./A";
      const B = lazy(() => import("./B"));
      export function App() {
        return <Routes>
          <Route path="/admin">
            <Route path="users/:id" element={<A />} />
            <Route index element={<B />} />
          </Route>
        </Routes>;
      }`,
  });
  const r = edgeSet(g, "renders");
  assert.ok(r.has("page:/admin/users/:id -> ts:src/A.tsx#A"));
  assert.ok(r.has("page:/admin -> ts:src/B.tsx#B"));
  assert.ok(r.has("ts:src/App.tsx#App -> ts:src/A.tsx#A"), "component renders through JSX");
});

test("wrappers: configured clients fetch, the wrapper's own fetch does not", () => {
  const g = run(
    {
      "src/http.ts": `
        const BASE = "/api";
        async function send(method: string, path: string) { return fetch(\`\${BASE}\${path}\`, { method }); }
        export const http = { get: (p: string) => send("GET", p), del: (p: string) => send("DELETE", p) };
        export function request(method: string, url: string) { return fetch(BASE + url, { method }); }`,
      "src/api.ts": `
        import { http as client, request } from "./http";
        export const listOrders = () => client.get("/orders");
        export function removeOrder(o: { id: string }) { return client.del(\`/orders/\${o.id}\`); }
        export function refund(id: string) { return request("POST", "/api/orders/" + id + "/refund"); }`,
    },
    { http_clients: ["http.get", "http.del", "request"], base_url_prefixes: ["/api"] },
  );
  const f = g.edges.filter((e) => e.type === "fetches").map((e) => `${e.from} -> ${e.to} | ${e.detail}`).sort();
  assert.deepEqual(f, [
    "ts:src/api.ts#listOrders -> route:GET /orders | GET /orders",
    "ts:src/api.ts#refund -> route:POST /orders/:param/refund | POST /orders/:id/refund",
    "ts:src/api.ts#removeOrder -> route:DELETE /orders/:param | DELETE /orders/:id",
  ]);
});

test("fetch and axios", () => {
  const g = run({
    "src/client.ts": `
      import axios from "axios";
      const api = axios.create({ baseURL: "/api" });
      const API_URL = import.meta.env.VITE_API;
      export async function a() { return fetch("/a"); }
      export async function b(id: string) { return fetch(\`\${API_URL}/b/\${id}\`, { method: "PUT" }); }
      export async function c(m: string) { return fetch("/c", { method: m }); }
      export async function d() { return axios.post("/d", {}); }
      export async function e() { return api.delete("/e"); }
      export async function f() { return axios({ url: "/f", method: "patch" }); }
      export async function g(url: string) { return fetch(url); }
      export async function h() { return fetch("https://api.github.com/repos/x"); }`,
    "src/inst.ts": `import Axios from "axios";\nexport const client = Axios.create({});`,
    "src/use.ts": `import { client } from "./inst";\nexport const i = () => client.put("/i");`,
  });
  const f = g.edges.filter((e) => e.type === "fetches").map((e) => `${e.from.split("#")[1]} ${e.to}`).sort();
  assert.deepEqual(f, ["a route:GET /a", "b route:PUT /b/:param", "d route:POST /d", "e route:DELETE /e", "f route:PATCH /f", "i route:PUT /i"]);
});

test("functions: inner handlers, hooks, object methods, classes, docs", () => {
  const g = run({
    "src/C.tsx": `
      import { useCallback } from "react";
      import * as util from "./util";
      // Shows a thing.
      export const C = () => {
        const onClick = useCallback(() => util.go(), []);
        function onKey() { util.go(); }
        return <button onClick={onClick} onKeyDown={onKey} />;
      };
      export class Old extends React.Component {
        handle = () => util.go();
        render() { return <div onClick={this.handle} />; }
      }`,
    "src/util.ts": `
      /**
       * Goes.
       * @returns nothing
       */
      export function go() {}`,
  });
  const n = new Map(g.nodes.map((x) => [x.id, x]));
  assert.equal(n.get("ts:src/C.tsx#C")?.kind, "component");
  assert.equal(n.get("ts:src/C.tsx#C")?.doc, "Shows a thing.");
  assert.equal(n.get("ts:src/util.ts#go")?.doc, "Goes.");
  assert.equal(n.get("ts:src/C.tsx#Old")?.kind, "component");
  const c = edgeSet(g, "calls");
  for (const e of [
    "ts:src/C.tsx#C -> ts:src/C.tsx#C.onClick",
    "ts:src/C.tsx#C -> ts:src/C.tsx#C.onKey",
    "ts:src/C.tsx#C.onClick -> ts:src/util.ts#go",
    "ts:src/C.tsx#Old -> ts:src/C.tsx#Old.handle",
    "ts:src/C.tsx#Old.handle -> ts:src/util.ts#go",
  ]) assert.ok(c.has(e), e);
});

test("tests: describe names, helpers followed, mocked modules not reached", () => {
  const g = run({
    "src/a.ts": "export function a() {}\nexport function b() {}",
    "src/a.test.ts": `
      import { a } from "./a";
      import { b } from "./mocked";
      vi.mock("./mocked");
      function helper() { a(); }
      describe("group", () => {
        it("works", () => { helper(); b(); });
      });`,
    "src/mocked.ts": "export { b } from './a';",
  });
  const t = "test:ts:src/a.test.ts#group > works";
  assert.ok(ids(g).has(t));
  const c = edgeSet(g, "calls");
  assert.ok(c.has(`${t} -> ts:src/a.ts#a`), "through helper");
  assert.ok(!c.has(`${t} -> ts:src/a.ts#b`), "mocked import");
  assert.ok(!ids(g).has("ts:src/a.test.ts#helper"), "helpers aren't nodes");
});

test("Next.js app/ and pages/ conventions", () => {
  const g = run({
    "package.json": JSON.stringify({ dependencies: { next: "15.0.0" } }),
    "app/page.tsx": "export default function Home() { return <div/>; }",
    "app/(shop)/orders/[id]/page.tsx": "export default function OrderPage() { return <div/>; }",
    "app/api/orders/route.ts": "export async function POST() { return new Response(); }",
    "pages/blog/[slug].tsx": "const Post = () => <article/>;\nexport default Post;",
    "pages/_app.tsx": "export default function App() { return <div/>; }",
    "src/x.ts": "export async function create() { return fetch('/api/orders', { method: 'POST' }); }",
  });
  const r = edgeSet(g, "renders");
  assert.ok(r.has("page:/ -> ts:app/page.tsx#Home"));
  assert.ok(r.has("page:/orders/:id -> ts:app/(shop)/orders/[id]/page.tsx#OrderPage"));
  assert.ok(r.has("page:/blog/:slug -> ts:pages/blog/[slug].tsx#Post"));
  assert.ok(!ids(g).has("page:/_app"));
  assert.ok(edgeSet(g, "calls").has("route:POST /api/orders -> ts:app/api/orders/route.ts#POST"));
  assert.ok(edgeSet(g, "fetches").has("ts:src/x.ts#create -> route:POST /api/orders"));
});

test("pages/ is not treated as Next.js without next", () => {
  const g = run({ "pages/Home.tsx": "export function Home() { return <div/>; }" });
  assert.ok(![...ids(g)].some((id) => id.startsWith("page:")));
});

test("module depth", () => {
  const g = run({ "src/a/b/c.ts": "export function c() {}" }, { module_depth: 2 });
  assert.deepEqual(g.modules.map((m) => m.id), ["mod:ts:src/a"]);
  assert.equal(g.nodes[0].module, "mod:ts:src/a");
});

test("solution tsconfig with project references (Vite template)", () => {
  const g = run({
    "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }] }),
    "tsconfig.app.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx" }, include: ["src"] }),
    "tsconfig.node.json": JSON.stringify({ include: ["vite.config.ts"] }),
    "src/App.tsx": "export function App() { return <div/>; }",
    "vite.config.ts": "export default { plugins: [] };",
  });
  assert.ok(ids(g).has("ts:src/App.tsx#App"));
  assert.equal(g.nodes.find((n) => n.id === "ts:src/App.tsx#App")?.kind, "component");
});
