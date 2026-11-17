import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, joinRoutePath, matchesClient, methodFromName, nextPagePath, normalizeRoutePath, requestPath } from "./urls.ts";

test("normalizeRoutePath mirrors graph.NormalizeRoutePath", () => {
  const cases: [string, string][] = [
    ["/orders/{id}", "/orders/:id"],
    ["/orders/{id:[0-9]+}", "/orders/:id"],
    ["/orders/${order.id}", "/orders/:param"],
    ["orders/:id/", "/orders/:id"],
    ["/static/{path...}", "/static/:path"],
    ["/a//b?x=1#f", "/a/b"],
    ["/", "/"],
    ["", "/"],
  ];
  for (const [in_, want] of cases) assert.equal(normalizeRoutePath(in_), want, in_);
});

test("requestPath", () => {
  const lit = (s: string) => ({ lit: s });
  const p = (s: string) => ({ param: s });
  const cases: [Parameters<typeof requestPath>[0], string[], { path: string; pretty: string } | null][] = [
    [[lit("/orders")], [], { path: "/orders", pretty: "/orders" }],
    [[lit("/orders/"), p("id")], [], { path: "/orders/:param", pretty: "/orders/:id" }],
    [[lit("/orders/"), p("id"), lit("/refund?x="), p("x")], [], { path: "/orders/:param/refund", pretty: "/orders/:id/refund" }],
    // a dynamic base URL in front is dropped
    [[p("API_URL"), lit("/users/"), p("id")], [], { path: "/users/:param", pretty: "/users/:id" }],
    // literal absolute URLs are other hosts, unless a prefix covers them
    [[lit("https://api.github.com/repos/x")], [], null],
    [[lit("//cdn.example.com/x")], [], null],
    [[lit("https://api.example.com/v1/users")], ["https://api.example.com/v1/"], { path: "/users", pretty: "/users" }],
    [[lit("https://api.example.com/v1")], ["https://api.example.com/v1"], { path: "/", pretty: "/" }],
    // configured base prefixes are stripped
    [[lit("/api/orders")], ["/api"], { path: "/orders", pretty: "/orders" }],
    [[lit("/api")], ["/api/"], { path: "/", pretty: "/" }],
    [[lit("/apix/orders")], ["/api"], { path: "/apix/orders", pretty: "/apix/orders" }],
    // relative paths get a leading slash
    [[lit("users")], [], { path: "/users", pretty: "/users" }],
    // nothing static: no route
    [[p("url")], [], null],
    [[lit("/"), p("path")], [], null],
    [[p("base"), p("path")], [], null],
    [[lit("not a url")], [], null],
    [[lit("/images/rocket.jpeg")], [], null],
    // odd parameter expressions get a generic name
    [[lit("/x/"), p("a-b")], [], { path: "/x/:param", pretty: "/x/:param" }],
  ];
  for (const [parts, prefixes, want] of cases) assert.deepEqual(requestPath(parts, prefixes), want, JSON.stringify(parts));
});

test("methodFromName and matchesClient", () => {
  assert.equal(methodFromName("post"), "POST");
  assert.equal(methodFromName("del"), "DELETE");
  assert.equal(methodFromName("request"), null);
  assert.ok(matchesClient("http.post", "http.post"));
  assert.ok(matchesClient("api.http.post", "http.post"));
  assert.ok(!matchesClient("xhttp.post", "http.post"));
});

test("joinRoutePath", () => {
  assert.equal(joinRoutePath("", "/a"), "/a");
  assert.equal(joinRoutePath("/a", "b"), "/a/b");
  assert.equal(joinRoutePath("/a/", ":id"), "/a/:id");
  assert.equal(joinRoutePath("/a", "/abs"), "/abs");
  assert.equal(joinRoutePath("/a", undefined), "/a");
  assert.equal(joinRoutePath("", undefined), "/");
});

test("nextPagePath", () => {
  assert.equal(nextPagePath("page.tsx", "app"), "/");
  assert.equal(nextPagePath("(shop)/orders/[id]/page.tsx", "app"), "/orders/:id");
  assert.equal(nextPagePath("docs/[...slug]/page.mdx", "app"), "/docs/:slug");
  assert.equal(nextPagePath("@modal/login/page.tsx", "app"), "/login");
  assert.equal(nextPagePath("_components/page.tsx", "app"), null);
  assert.equal(nextPagePath("orders/layout.tsx", "app"), null);
  assert.equal(nextPagePath("index.tsx", "pages"), "/");
  assert.equal(nextPagePath("blog/[[...slug]].tsx", "pages"), "/blog/:slug");
  assert.equal(nextPagePath("blog/index.js", "pages"), "/blog");
  assert.equal(nextPagePath("_app.tsx", "pages"), null);
  assert.equal(nextPagePath("api/hello.ts", "pages"), null);
});

test("globToRegExp", () => {
  assert.ok(globToRegExp("vendor/**").test("vendor/a/b.ts"));
  assert.ok(globToRegExp("**/*.gen.ts").test("a/b/c.gen.ts"));
  assert.ok(globToRegExp("**/*.gen.ts").test("c.gen.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
});
