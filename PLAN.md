# codemap — implementation plan

codemap turns a codebase into an interactive architecture map. A person uses it to understand
a system they mostly didn't write by hand, and to sketch changes they want an agent to make.

The clickable prototype in `docs/prototype.html` is the UI spec. Open it in a browser. Its
sample data is hand-written, and this plan describes how to generate the same thing from a
real repo.

---

## 1. Direction so far

This is where the design has landed after exploring it in the prototype. Treat it as the
current direction, not as fixed rules. Any of it can change as the tool gets built and used.

- The map comes from the code itself (parsing, call graphs, files in `.codemap/`) rather than
  from AI-generated summaries.
- Graphs are built per git commit, and user arrangements live as plain files in the repo.
- There is one node shape and one edge shape, and fields display based on what their values
  look like, so new kinds of things don't need viewer changes.
- It should work on real repos, not just the fixture.
- Proposals are sketches of intent, not specs to check the code against.
- The UI keeps on-screen text light.
- Keep it simple: build what's needed now and generalise when a real case calls for it.

---

## 2. Architecture

```
                 ┌─────────────── codemap (single Go binary) ───────────────┐
 repo @ commit ─▶│ extractors ──▶ graph.json ──▶ merge .codemap/* ──▶ cache │
                 │   go (go/packages + ssa)                                  │
                 │   ts (node subprocess, TS compiler API)                  │
                 │   sql + migrations, queues, http clients, tests          │
                 │                                                          │
                 │ cli:  codemap build | serve | show | callers | search …  │
                 │ serve: HTTP API + embedded viewer + file watcher (SSE)   │
                 └──────────────────────────────────────────────────────────┘
                                        │
                                 viewer (TS + React, SVG, ELK layout)
```

- **Language:** Go for the binary. The TypeScript extractor is a small Node program embedded
  in the binary and run as a subprocess (any TS repo already has Node). Both output the same
  partial-graph JSON, which the Go side merges.
- **Viewer:** TypeScript + React + Vite, built to static files and embedded with `go:embed`.

### Repo layout

```
cmd/codemap/            main, CLI commands
internal/graph/         types, IDs, merge, queries (callers, reach, tree)
internal/extract/go/    Go extractor
internal/extract/ts/    runs the embedded TS extractor, decodes its output
internal/extract/sql/   SQL string classification + migration parser
internal/extract/declared/  reads .codemap/external.yaml
internal/project/       loads/saves .codemap/* files
internal/gitrev/        builds a graph at a commit, cache
internal/server/        HTTP API, SSE, file watching, editor launch
extractor-ts/           Node/TS source for the TS extractor (built to a single .js and embedded)
viewer/                 React app
testdata/shop/          fixture repo: Go server + TS web app (see §10)
docs/prototype.html     UI spec
```

---

## 3. Data model

### 3.1 graph.json

```jsonc
{
  "version": 1,
  "rev": "3f2c9e1…",            // commit sha, or "worktree"
  "modules": [
    { "id": "mod:go:shop/internal/orders", "label": "internal/orders", "lang": "go",
      "path": "internal/orders", "doc": "Package orders owns the order lifecycle…" }
  ],
  "nodes": [
    { "id": "go:shop/internal/orders.(*Service).Place",
      "kind": "function", "label": "Service.Place",
      "module": "mod:go:shop/internal/orders",
      "file": "internal/orders/service.go", "line": 19, "endLine": 34,
      "doc": "Place reserves stock, charges the card…",
      "entry": false, "external": false,
      "fields": {} }
  ],
  "edges": [
    { "from": "go:…Place", "to": "go:…(*Store).Reserve", "type": "calls",
      "file": "internal/orders/service.go", "line": 20 },
    { "from": "go:…(*Repo).Insert", "to": "table:orders", "type": "writes",
      "detail": "INSERT INTO orders (…) RETURNING id" }
  ]
}
```

**Node.** Only `id`, `kind`, `label` and `module` are required. The flags `entry` and
`external` are the *only* things the viewer looks at besides `fields`:
- `entry: true` puts a node in the entry-point role: traces start from it, and it shows a
  method or kind prefix.
- `external: true` marks it as an external system: traced paths stop at it, and it's grouped
  with external nodes.

Built-in kinds are `function`, `route`, `page`, `job`, `subscriber`, `component`, `table`,
`topic`, `service` and `test`. These are labels only, and any other string is fine.

**Edge types** are `calls`, `renders`, `fetches` (frontend to route), `reads`, `writes`,
`publishes`, `subscribes` and `declared`. The viewer styles them by type with a default
fallback. `declared: true` marks edges that came from `.codemap/external.yaml`.

**Tests** are nodes with `kind: "test"`, and they're hidden from the map. "Tests that reach
this" means reverse reachability from test nodes over `calls`/`renders` edges. That walk
never crosses `fetches` edges or external nodes, because a frontend test mocks the API.

### 3.2 Stable IDs

Layout, areas, blocks, views and proposals all refer to IDs, so IDs must survive unrelated
edits.

| Thing | ID format | Example |
|---|---|---|
| Go func/method | `go:<importpath>.<name>` (go/ssa naming) | `go:shop/internal/orders.(*Service).Place` |
| TS function | `ts:<relpath>#<exportName>[.<inner>]` | `ts:web/src/components/PlaceOrderButton.tsx#PlaceOrderButton.onClick` |
| HTTP route | `route:<METHOD> <path>` with `:param` style | `route:POST /orders/:id/refund` |
| Page | `page:<path>` | `page:/orders/:id` |
| Job | `job:<name>` | `job:expire-carts` |
| Subscriber | `sub:<topic>:<handler id>` | `sub:order.placed:go:shop/internal/notify.(*Mailer).SendConfirmation` |
| Table | `table:<name>` (schema-qualified if not `public`) | `table:orders` |
| Topic | `topic:<name>` | `topic:order.placed` |
| External service | `ext:<name>` | `ext:stripe` |
| Test | `test:<lang>:<id>` | `test:go:shop/internal/orders.TestPlace_OutOfStock` |
| Module | `mod:<lang>:<importpath or dir>` | `mod:ts:web/src/components` |
| Proposal-only | `new:<anything>` | `new:orders.Service.Refund` |

Module conventions settled in M0 (`testdata/shop.expected.json` shows all of them):
- Tables go in `mod:sql:database`, topics in `mod:queue:topics`, and external services in
  `mod:ext:services`. All three modules are marked `external`.
- Page nodes go in the module of the component they render, so pages sit with the page
  components.
- Go labels are `Func` or `Type.Method`, for example `Service.Place` or `CreateOrder.Total`.
- Helpers in `_test.go` files (fakes, `newTestService`) aren't map nodes. A test node gets
  direct `calls` edges to the non-test functions its helpers reach.
- External service nodes keep the SDK import path in `fields.import`.
- Known over-approximation: one merged call graph can't tell test wiring from production
  wiring. So a test that uses fakes still "reaches" the real implementation behind an
  interface. That's accepted for now.

### 3.3 Rendering fields by their values

A node's `fields` map can hold anything. The viewer renders each value according to the
first rule that matches:

| Value | Renders as |
|---|---|
| string matching `^https?://` | link |
| `{label, url}` or a list of them | link list |
| string that is an existing node ID | clickable reference |
| list of node IDs | reference list |
| list of objects with the same keys, or a list of lists | small table |
| `{code, lang?, file?, line?}` | highlighted code block |
| number, bool, other string | text |
| other object | nested key/value list |

Fields show in insertion order, with the key as the label (`snake_case` becomes "Snake case").
The extractors use this same mechanism. For example, table columns are just
`fields.columns = [[name, type, note], …]`.

---

## 4. `.codemap/` files

All of these are committed, human-editable, and writable by agents. The GUI edits them
through the server (§8), and edits always round-trip through the file.

| File | Contents |
|---|---|
| `config.yaml` | Extractor settings (§5.7). Optional; everything has defaults. |
| `areas.yaml` | `- name: Commerce` / `  modules: [mod:…, block:…]`. Any number of areas. |
| `blocks.yaml` | Splits of a module into named blocks, as **rules** so new code lands automatically (§4.1). |
| `layout.json` | Positions written by the viewer: `{ "<module or block id>": [x, y], "area:<name>": [x, y] }`. Machine-written, sorted keys. |
| `views.yaml` | Saved views: `name`, `selection: [ids]`, `focus: bool`, `collapsed: [ids]`. |
| `external.yaml` | Declared nodes and edges, plus extra fields merged into extracted nodes (§5.6). |
| `proposals/<slug>.md` | One proposal per file (§6). |

### 4.1 blocks.yaml

```yaml
- id: block:pages-checkout          # stable, generated from name on create
  name: pages · checkout
  from: mod:ts:web/src/pages
  match: ["/checkout*", "/orders/*"]   # globs on node label
  files: ["web/src/pages/checkout/**"] # globs on node file (either or both)
```

A node goes into the first block whose rules match it. Anything unmatched stays in the
original module. Picking items in the GUI writes an exact `match` list, which the user can
broaden later. Merging a block back deletes its entry.

---

## 5. Extractors

Each extractor returns a partial graph (modules, nodes, edges). `internal/graph` merges them
(union by ID, fields shallow-merged, edges deduplicated by `from+to+type`). Extractors never
read `.codemap/` except `config.yaml`.

### 5.1 Go (`internal/extract/go`)

- **Loading:** `golang.org/x/tools/go/packages` with types and syntax, for every package under
  the module root (respecting `config.exclude`). Each package becomes one module, with its doc
  from the package comment.
- **Functions:** all funcs and methods, including closures that are assigned or passed as
  handlers. Labels are `Func` or `Type.Method`. Doc comments come from `ast.FuncDecl.Doc`.
- **Call graph:** build SSA and use `golang.org/x/tools/go/callgraph/vta`, so calls through
  interfaces resolve to their implementations (`s.payments.Charge` → `(*payments.Client).Charge`).
  Keep only edges between functions in the repo, plus edges to external nodes (§5.5). Record
  the call site's file and line.
- **Routes:** v1 supports `net/http` ServeMux (Go 1.22 `"POST /orders/{id}"` patterns), `chi`,
  `gorilla/mux`, `echo` and `gin`. Detect calls whose receiver is a known router type and whose
  first argument is a constant string, then resolve the handler argument to a function node.
  Middleware chained with `.With(mw)` or `Use(mw)` adds `calls` edges from the route to the
  middleware. Route groups (`r.Route("/orders", …)`) concatenate prefixes. Paths are
  normalised to `:param`.
- **Jobs and subscribers:** these are pattern-based from config (§5.7): a call to a configured
  function or method with a constant name/topic argument and a handler argument creates a
  `job` or `subscriber` node with an edge to the handler. Subscribers also get a
  `topic:<name> → sub:…` edge with type `subscribes`.
- **Tests:** each `TestXxx` in `_test.go` becomes a `test` node with `calls` edges from its body.
- **`main`:** each `main.main` becomes an entry node of kind `function`.

### 5.2 TypeScript (`extractor-ts/`, run via `internal/extract/ts`)

- A Node program using the TypeScript compiler API (`typescript` package, bundled with esbuild
  into one file embedded in the binary). It's invoked as `node <tmp>/extractor.js --root <dir>
  --config <json>`, and it writes the partial graph to stdout. The repo's own `tsconfig.json`
  is used for module resolution, including path aliases.
- **Modules:** a directory of source files (depth set by config, default: each directory
  containing `.ts`/`.tsx` files).
- **Functions:** exported functions, React components (functions returning JSX), and named
  inner functions or handlers (`onClick`, `onSubmit`, `useXxx` hooks). Doc comes from JSDoc.
- **Calls:** resolve call expressions through the type checker to their declarations. Also
  add `renders` edges (component → component) from JSX element names.
- **Pages:** v1 supports React Router (`createBrowserRouter` objects and `<Route path element>`
  JSX) and the Next.js `app/` and `pages/` file conventions. Each page is an entry node with an
  edge to its component.
- **Calls to the server:** `fetch`, `axios.*` and configured wrapper functions
  (`config.ts.http_clients`, e.g. `http.post`) whose URL argument is a string or template
  literal. Normalise `${x}` to `:param`, strip any configured base URL, and emit a `fetches`
  edge to `route:<METHOD> <path>`. Merging resolves it against the Go routes. If no route
  matches, keep the edge pointing at a placeholder route node with `fields.unmatched: true`.
- **Tests:** `test()`/`it()` blocks in `*.test.ts(x)` and `*.spec.ts(x)` become `test` nodes.

### 5.3 SQL and migrations (`internal/extract/sql`)

- **Queries in Go:** string constants passed to configured database methods (defaults cover
  `database/sql`, `pgx`, `sqlx` and `sqlc`-generated code: `Query`, `QueryRow`, `Exec`, `Get`,
  `Select`, and so on). Classify the first keyword: `SELECT` → `reads`; `INSERT`, `UPDATE` or
  `DELETE` → `writes`. Extract table names from `FROM`, `JOIN`, `INTO` and `UPDATE` with a
  small tokenizer, not a full parser. The edge `detail` is the query collapsed to one line.
  Queries that aren't constants produce no edge (don't guess).
- **Migrations:** read `config.migrations` (default: `db/migrations/*.sql`, `migrations/*.sql`)
  in sorted order. Apply `CREATE TABLE`, `ALTER TABLE ADD/DROP/RENAME COLUMN` and `DROP TABLE`
  to build the current schema. Each table becomes `kind: table, external: true` with
  `fields.columns` (name, type, note: `pk`, `unique`, `→ other.col`, `index`) and
  `fields.source` listing the migration files.

### 5.4 Queues

Configured publish and subscribe patterns (§5.7) produce `topic:<name>` nodes
(`external: true`):
- A publish call creates a `publishes` edge from the calling function to the topic.
- A subscribe call creates a `subscribes` edge from the topic to the subscriber.
- The Go type of the published value (from `go/types`) goes in `fields.message` as a
  `{code, file, line}` block showing that type's declaration.

### 5.5 External services

- Built-in import-path table: `github.com/stripe/stripe-go` → `ext:stripe`, plus AWS SDK
  services, Postmark, Twilio, SendGrid, Slack, OpenAI, and so on. Extend it through
  `config.external.imports`. Calls into those packages create a `calls` edge to the `ext:`
  node, and the method name goes in `detail`.
- `http.NewRequest`/`http.Get` with a constant URL becomes `ext:<host>`, with method and path
  in `detail`.

### 5.6 Declared (`.codemap/external.yaml`)

```yaml
nodes:
  - id: ext:stripe            # existing id: fields are merged in
    owner: Payments team
    setup: Live and test accounts; key in STRIPE_SECRET_KEY
    links:
      - {label: Dashboard, url: https://dashboard.stripe.com}
  - id: ext:s3-uploads        # new id: a new node
    kind: bucket
    label: s3://shop-uploads
    region: us-east-1
edges:
  - {from: ext:stripe, to: "route:POST /webhooks/stripe", detail: sends payment_intent.succeeded}
```

Any key other than `id`, `kind`, `label` and `module` becomes a field. Declared nodes
default to `external: true`. Declared edges have `type: declared` and `declared: true`.

### 5.7 config.yaml (all optional)

```yaml
exclude: ["vendor/**", "**/*_gen.go"]
go:
  jobs:        [{call: "(*sched.Scheduler).Every", name_arg: 1, handler_arg: 2}]
  subscribers: [{call: "(*events.Bus).Subscribe", topic_arg: 0, handler_arg: 1}]
  publishers:  [{call: "(*events.Bus).Publish", topic_arg: 1, value_arg: 2}]
  db_methods:  ["Query", "QueryRow", "Exec"]   # added to defaults
ts:
  roots: ["web"]
  module_depth: 3
  http_clients: ["http.get", "http.post", "api.request"]
  base_url_prefixes: ["/api"]
migrations: ["db/migrations/*.sql"]
external:
  imports: {"github.com/acme/billing-sdk": "ext:billing"}
editor: "code -g {file}:{line}"    # default: $VISUAL/$EDITOR with +{line}
```

---

## 6. Proposals

One Markdown file per proposal. The frontmatter holds the sketch, and the body is the
document. Agents write these files directly, and the GUI edits the same file.

```markdown
---
name: Refunds
status: open                 # open | archived
base: 3f2c9e1                # commit it was drawn against (set on create)
pr: "#91"                    # set when archived
updated: 2026-11-16
modules:
  - {id: new:mod:refunds, label: internal/refunds, area: Commerce}
nodes:
  - {id: new:RefundButton.onClick, kind: function, label: RefundButton.onClick, module: mod:ts:web/src/components}
  - {id: "new:route:POST /orders/:id/refund", kind: route, label: /orders/:id/refund, module: mod:go:shop/cmd/server, entry: true, method: POST}
edges:
  - {from: new:RefundButton.onClick, to: "new:route:POST /orders/:id/refund"}
  - {from: new:orders.Service.Refund, to: go:shop/internal/orders.(*Repo).UpdateStatus}
---
## Why
Support refunds orders by hand in the Stripe dashboard…
```

- Edges and nodes can refer to real IDs or `new:` IDs. Proposal nodes accept any fields
  (duck typing).
- **Open** proposals draw over the current graph. A real ID that no longer exists shows as a
  faint outline instead of disappearing.
- **Archived** proposals draw over the graph at `base`, with a toggle to draw over the current
  code instead.
- `codemap proposal archive <slug> --pr 91` sets the status and PR. Archiving automatically
  when a PR merges (via `gh`) is a later addition.
- Nothing ever validates a proposal against the code.

---

## 7. Git layer (`internal/gitrev`)

- `Build(rev)`: for `worktree`, extract from the working directory. For a commit, create a
  temporary `git worktree add --detach` (or reuse one from a pool) under the cache dir,
  extract there, then remove it.
- **Cache:** `$XDG_CACHE_HOME/codemap/<repo-id>/<sha>-<extractor-version>-<config-hash>.json.zst`.
  Commits never change, so the cache never goes stale. Only the worktree graph is rebuilt.
- `.codemap/*` user state is read from the **same revision** as the graph (`git show
  <rev>:.codemap/…`), except in worktree mode, which reads the files on disk. Archived
  proposals use their `base`.
- Source snippets for the details panel are served from the revision being viewed, so code
  and graph always agree.

---

## 8. Server (`codemap serve`)

Listens on localhost only (default `127.0.0.1:7777`), serves the embedded viewer, and opens
the browser.

| Endpoint | Purpose |
|---|---|
| `GET /api/graph?rev=` | Merged graph + `.codemap` state for a rev (default worktree) |
| `GET /api/source?rev=&file=&from=&to=` | Source lines for snippets |
| `GET /api/project/{file}` · `PUT /api/project/{file}` | Read/write a `.codemap/` file (worktree only; path allow-list; atomic write) |
| `GET /api/proposals` · `GET/PUT/DELETE /api/proposals/{slug}` | List, read, write and delete proposal files |
| `POST /api/open` `{file, line}` | Launch the editor command |
| `GET /api/events` (SSE) | `graph-changed` and `project-changed` events |

- **Watching:** `fsnotify` on the repo (respecting exclude and `.gitignore`), debounced by
  300 ms. Rebuild only the extractors whose files changed: a Go change re-runs Go, a TS change
  re-runs TS, `.sql` re-runs SQL. Edits in `.codemap/` only re-merge. Full rebuilds are fine
  for v1, but keep extractors separable so per-package incremental builds can come later.
- **Conflicts:** `PUT` includes the file's last-seen hash and gets `409` if the file changed on
  disk (for example, an agent edited it). The viewer then reloads that file.

---

## 9. Viewer (`viewer/`)

Port the prototype's behaviour. `docs/prototype.html` is the reference for look, interaction
and wording.

- **Rendering:** SVG with the same visual language as the prototype, kept to a single render
  pass. Use React for the panel and controls. For the map, plain SVG strings or memoised
  components are fine. It must stay responsive at about 3,000 functions and 300 modules (zoomed
  out, only module boxes render).
- **Layout:** ELK.js, `layered` algorithm, left to right, in a Web Worker. Saved positions from
  `layout.json` are fixed, and ELK places only modules that don't have a position yet. Dragging
  writes to `layout.json` (debounced). Layout stays stable between runs.
- **Map features:**
  - modules and blocks with function rows
  - user-defined areas: create, rename, delete, drag modules in and out, drag an area to move
    its contents
  - zooming out simplifies the map: below about 0.55× each module becomes one box, calls
    between modules merge into one line whose thickness shows the call count, and labels scale
    up
  - collapse and expand
  - drag modules
  - search (`/`), covering labels, files and doc comments
  - Focus, which shows only the selected path
  - Shift-click multi-selection, offering "Split into a new block" and "New area from these"
  - saved views
- **Selection:**
  - Selecting a node lights up everything upstream and downstream of it. Traced paths stop at
    external nodes unless the external node itself is selected.
  - Selecting a module or area lights up its direct connections.
- **Details panel:**
  - Entry points show who calls them, the call tree with SQL and request details, the source,
    and the tests along the path.
  - Functions show their doc comment, who calls them and what they call, which entry points
    reach them, their source, and their tests (click to expand the test's code).
  - Modules show their doc comment, what uses them, what they depend on, what they contain,
    and the Split… and Merge back actions.
  - External nodes show any fields by duck typing, then kind-neutral sections built from edge
    types: Writes and Reads (from `writes`/`reads` edges), Published by and Subscribers
    (`publishes`/`subscribes`), and Called by and Calls us (`calls` in, `declared` out).
    These sections depend on edge types, never on node kind.
- **Source:** clicking a file and line in the panel calls `/api/open`.
- **Propose mode:**
  - The proposals list has search, sort (recently updated, name, status) and a
    status filter.
  - The proposal view has an editable title, the Markdown document (rendered, with Edit to
    switch to raw text; marked + DOMPurify), the list of changes, and archive/reopen.
  - On the map, proposals draw in dashed purple. You can add to modules, add modules, and draw
    calls.
- **Live updates:** a `graph-changed` event re-fetches the graph, keeps the selection, and
  animates nothing.
- **Revision picker:** a small control in the top bar: worktree (default), a branch, or a commit.
- **Copy:** minimal text, no explanatory paragraphs, no per-row status badges. Both light and
  dark themes, following the prototype's tokens.

---

## 10. CLI

```
codemap build [--rev R] [--out graph.json]
codemap serve [--rev R] [--port 7777] [--no-open]
codemap show <id|label|"POST /orders">      # call tree as indented text, with SQL and HTTP details
codemap callers <id|label> [--depth N]
codemap module <id|path>                    # contents, uses, depends on
codemap search <text>
codemap proposal list | new <name> | archive <slug> --pr N
```

All commands take `--json` and `--rev`. When a label is ambiguous, the command lists the
matching IDs and exits with status 2. Output is plain and compact, because agents read it too.

---

## 11. Fixture repo and testing

`testdata/shop/` is a small but real Go and TypeScript repo that mirrors the prototype's
sample. It should build and its tests should pass:
- `cmd/server` (chi routes, scheduler job, `order.placed` subscriber)
- `internal/{auth,orders,inventory,payments,notify,events}`
- `db/migrations/*.sql`
- `web/src/{pages,components,api}` (React Router) with one vitest test
- `.codemap/` with areas, external.yaml and two proposals

The fixture uses pgx, stripe-go, a fake NATS-like bus, and a postmark client stub.

Tests:
- **Golden tests:** each extractor run on the fixture is compared with a checked-in
  `*.golden.json` (sorted, stable). Update with `go test ./... -update`.
- **Unit tests:** ID normalisation, route path normalisation, the SQL classifier, the
  migration schema builder, the duck-typing renderer rules, and blocks rule matching.
- **Real-repo check:** CI also runs `codemap build` on two or three pinned open-source repos
  (a chi-based Go API, and a React Router or Next app). It asserts no crash and checks a few
  basic counts (modules > 0, routes > 0), so nothing only works on the fixture.
- **Viewer:** Playwright against `codemap serve testdata/shop`. Select an entry point, confirm
  the traced path, split a block, create an area, edit a proposal and check that the file
  changed.

---

## 12. Milestones and agent workstreams

M0 settles a first version of the data formats (§3, §4, §6) so that workstreams A–E can run
in parallel. They can still change later.

| # | Workstream | Depends on | Done when |
|---|---|---|---|
| **M0** | Scaffold: Go module, `internal/graph` types + IDs + merge + reach/tree queries, `internal/project` file loaders, the fixture repo, and a hand-written `testdata/shop.expected.json` | — | `go test ./...` passes; the fixture builds; the expected graph validates against the types |
| **A** | Go extractor (§5.1, 5.3, 5.4, 5.5) | M0 | Golden test on the fixture; real-repo check passes |
| **B** | TS extractor (§5.2), including matching `fetches` to routes during merge | M0 | Golden test; `PlaceOrderButton.onClick → createOrder → route:POST /orders` resolves |
| **C** | Viewer: port the prototype onto the real graph format, with ELK layout, against `shop.expected.json` from a static file | M0 | Every prototype interaction works on the expected graph, plus the Playwright suite |
| **D** | Server + watch + SSE + project file writes + `/api/open` | M0 | The viewer runs live against the fixture; editing a Go file updates the map |
| **E** | CLI query commands (§10) | M0 | `codemap show "POST /orders"` prints the tree |
| **F** | Git layer: rev builds, cache, rev picker, archived proposals at `base` | A, B, D | Switching revs works; an archived proposal draws against its base |
| **G** | Hardening: real-repo checks, performance at 3k functions, docs (README with quick start) | all | CI green; a medium repo renders in under 3 s once cached |

Notes for agents:
- `docs/prototype.html` is the best reference for how the UI should look and behave.
- If you change the §3/§4/§6 formats, update this file too so the other workstreams see it.
- Where an extractor heuristic is approximate, make it configurable or document it, rather
  than special-casing the fixture.
- This plan is a starting point. Raise anything that doesn't hold up once you're in the code.

---

## 13. Open questions

- **Name:** check that "codemap" is free enough for a public binary or repo name before
  publishing.
- **Frameworks:** which Go routers and frontend frameworks matter first. This plan assumes
  chi + net/http, and React Router + Next.
- **Monorepos with several `go.mod` files:** treat each as its own root, merged into one graph.
  Confirm this is the expected behaviour.
