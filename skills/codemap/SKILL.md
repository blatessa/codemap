---
name: codemap
description: Use codemap to understand a project's architecture (entry points, call paths, modules, tables, external services) and to write architecture proposals the user reviews in the codemap viewer. Use when the project has a .codemap/ directory, when the user mentions codemap or a proposal, or before structural changes where knowing what calls what would help.
---

# codemap

codemap builds a map of a codebase from its code: modules, functions, the calls between them, HTTP routes, frontend pages, database tables (read vs. write), queue topics and external services. The user browses it in a viewer (`codemap serve`). You can query the same map from the terminal.

The map is context, not a spec. It comes from static analysis, so it can miss calls (reflection, dynamic dispatch through library code) and occasionally over-approximate (a test using fakes may appear to reach the real implementation). Check the code when it matters.

## Querying the map

Run these from the repo root. Each one builds the graph from the working tree. The first run on a repo can take a while, and after that it's quick. Add `--json` for machine-readable output.

```sh
codemap show "POST /orders"          # call tree below an entry point or function, with SQL and API details, then the tests of it
codemap show orders.Service.Place    # any function shows its own trace
codemap callers Repo.UpdateStatus    # what reaches this, up to the entry points
codemap module internal/orders       # contents, what it depends on, what uses it
codemap modules                      # every module at once, with its size and dependencies
codemap search refund                # labels, files and doc comments
```

You can name a node by its ID, a route (`"GET /orders/{id}"`), a page path (`/checkout`), a label (`Service.Place`), or a module-qualified label exactly as codemap prints it (`orders.Service.Place`). You can paste any row of output back in.

If a name matches several nodes, codemap lists their IDs and exits with status 2. Rerun the command with one of the IDs.

Output conventions:
- Tables, topics, services and tests carry a tag, such as `orders [table]`.
- Edge details follow the name, such as `writes: UPDATE orders …` or `PaymentIntents.New`.
- `(see above)` marks a node that's already expanded higher up the tree.
- Trees show a feature's architecture, not every call: short forwarding functions are skipped (A → C instead of A → B → C), and wiring, utility, generated and unreachable code is left out, counted on the parent line as `(+2 support)`. Utilities include widely used helpers such as a transaction wrapper or a logger. A node's `role:` line says which kind of support code it is. There's no option to show more; `show` a row on its own to see inside it.
- A widely used function that does something itself, or calls something that does (writes data, calls a service), shows as a row ending in `...`: it's part of the path, but the tree doesn't go into it. `show` it on its own to see inside.
- A call that may go to many functions (through an interface or a function value) is one row, such as `Error · 107 implementations`, and isn't followed.
- `show` goes 4 levels deep; rows with more below end in `...`.
- Nothing a trace leaves out hides an effect: a row ends in `→ writes orders · reads users · calls api.stripe.com` for the tables, topics, services and API calls reached below it that the tree doesn't show (past the depth limit, inside support code or a shared function, or behind an API call into the backend).
- Traces stop at external systems.
- `Tests:` lists the tests that call the code shown, directly `(direct)` or through one helper of their own (`via …`), direct ones first. Tests that only reach it through support code or longer chains aren't listed, so a short list doesn't mean the code is untested end to end. For a table or service, it's the tests of the code that uses it.

Useful before changing code: `show` an entry point to see everything a change could affect, `callers` to see who depends on a function, and `module` to see a package's boundaries.

Every query takes `--rev` (a commit, branch or tag) to ask about another revision: `codemap callers Repo.Find --rev main`.

## Reviewing what changed

After making changes, check what they did to the architecture:

```sh
codemap diff                  # uncommitted changes (HEAD..worktree)
codemap diff main...          # this branch since it left main, plus uncommitted changes
codemap diff HEAD~1..HEAD     # the last commit
codemap diff pr:42            # a GitHub pull request
```

It lists new and removed entry points, tables newly read or written (or no longer), new external services and topics, new module-to-module dependencies, and the nodes added (`+`), removed (`-`) and changed (`~`) per module. Look for surprises: an entry point you didn't mean to add or remove, a new write to a table, a dependency between modules that shouldn't know about each other. Mention them to the user. `--json` gives the full diff. The user can see the same comparison in the viewer.

## Proposals

A proposal is a sketch of how the architecture could change. The user reviews and edits it in the viewer, where it's drawn in dashed purple on top of the real map. It isn't checked against the code and doesn't have to match what eventually gets built. Its job is to show the user what you have in mind.

Proposals live in `.codemap/proposals/<slug>.md`. Create one with:

```sh
codemap proposal new "Refunds" --body body.md   # or --body - to read stdin
codemap proposal list
codemap proposal archive refunds --pr 91        # once the work has landed or been dropped
```

Then edit the file directly. The TOML frontmatter between the `+++` lines holds the sketch, and the Markdown below it is the document (why, the shape of the change, open questions):

```markdown
+++
name = "Refunds"
status = "open"

[[module]]
id = "new:mod:refunds"
label = "internal/refunds"

[[node]]
id = "new:route:POST /orders/:id/refund"
kind = "route"
label = "/orders/:id/refund"
module = "mod:go:shop/cmd/server"
entry = true
method = "POST"

[[node]]
id = "new:orders.Service.Refund"
kind = "function"
label = "Service.Refund"
module = "mod:go:shop/internal/orders"

[[edge]]
from = "new:route:POST /orders/:id/refund"
to = "new:orders.Service.Refund"

[[edge]]
from = "new:orders.Service.Refund"
to = "go:shop/internal/orders.(*Repo).UpdateStatus"

[[edge]]
from = "new:orders.Service.Refund"
to = "ext:stripe"
detail = "POST /v1/refunds"
+++
## Why
…
```

- New things use `new:` IDs. Existing things use their real IDs, which you can find with `codemap search` or `codemap show … --json`.
- `module` places a new node in an existing module (`mod:go:<import path>`, `mod:ts:<dir>`) or in a proposed one.
- Each `[[module]]`, `[[node]]` and `[[edge]]` table is one entry. Keep the top-level keys (`name`, `status`, …) above the first table.
- Nodes accept any extra fields, including arrays and inline tables such as `links = [{label = "Docs", url = "https://…"}]`. The viewer displays whatever you add.
- Leave `base` and `updated` alone. codemap sets them.
- To move an existing function to another module, list it with its real ID and the new module: `[[node]]` with `id = "go:shop/internal/orders.(*Service).MarkPaid"` and `module = "mod:go:shop/internal/payments"`.
- The user comments on a proposal from the viewer. Each comment is appended to the body under a `###` heading naming what it's about (a function, a module, or `file:lines` with the highlighted code quoted below). When asked to work through a proposal, read its body and treat those comments as the things to address.

## Splitting a module

The map lays itself out from the code every time: entry points on the left, data and external systems on the right, and folders with many similar modules folded into one box. Nothing about positions or grouping is stored. When the user asks, you can split a module that mixes unrelated jobs into blocks in `.codemap/blocks.toml`. A node goes into the first block whose rules match it; the rest stay in the module.

```toml
[[block]]
id = "block:handlers-billing"            # "block:" + a slug of the name
name = "handlers · billing"
from = "mod:go:app/internal/handlers"
match = ["Billing*", "*Invoice*"]        # globs on function labels
files = ["internal/handlers/billing*"]   # and/or globs on file paths
```

Run `codemap modules` afterwards and fix anything under "Problems". The viewer shows a module's package doc comment (Go) or file doc comment, so if those are missing and the user agrees, adding them is the best way to explain a module. (Old `.codemap/areas.toml` and `.codemap/layout.json` files are ignored and can be deleted.)

## Other .codemap files

These belong to the user. They edit them in the viewer, and the files are plain text if you're asked to change them:

| File | Contents |
|---|---|
| `blocks.toml` | A module split into blocks by pattern, one `[[block]]` each |
| `external.toml` | External systems and their details (`[[node]]`): owner, links, setup. Also calls into the code that the code can't show, such as a webhook from Stripe (`[[edge]]`). |
| `config.toml` | What the extractors look for (below) |

Don't rewrite them unprompted.

## Configuring extraction (config.toml)

Edit `.codemap/config.toml` when the map is missing things the code clearly has: jobs, queue handlers, calls from the frontend to the API, external services. Everything is optional. Top-level keys must come before the first `[table]`.

```toml
exclude = ["tools/**", "**/*_gen.go"]   # globs on paths from the repo root
migrations = ["db/migrations/*.sql"]     # default: db/migrations/*.sql, migrations/*.sql, **/migrations/*.sql
editor = "code -g {file}:{line}"         # default: $VISUAL or $EDITOR with +line

[go]
jobs = [{ call = "(*sched.Scheduler).Every", name_arg = 1, handler_arg = 2 }]
subscribers = [{ call = "(*events.Bus).Subscribe", topic_arg = 0, handler_arg = 1 }]
publishers = [{ call = "(*events.Bus).Publish", topic_arg = 0, value_arg = 1 }]
db_methods = ["Run"]                     # more methods whose first constant string argument is SQL

[ts]
roots = ["web"]                          # directories holding a tsconfig.json
module_depth = 3
http_clients = ["api.get", "api.post", "request"]
base_url_prefixes = ["/api"]

[external.imports]
"github.com/acme/billing-sdk" = "ext:billing"
```

- **Globs** (`exclude`, `migrations`): `**` matches any number of directories, `*` stays within one. A pattern is matched against the whole path from the repo root, so `*.config.ts` only matches files at the top level; write `**/*.config.ts` for anywhere. `vendor`, `node_modules`, `testdata`, `third_party`, and directories starting with `.` or `_` are always skipped.
- **Call patterns** (`jobs`, `subscribers`, `publishers`): `call` is the callee's go/types name, with the package as its full import path or just its name: `gitea.dev/modules/queue.CreateUniqueQueue`, `queue.CreateUniqueQueue`, `(*events.Bus).Publish`. Generic functions are written without type parameters. Argument indexes start at 0 and don't count the receiver. The name or topic argument must be a constant string, and the handler must resolve to a function. A call through an interface matches a pattern naming the implementation.
- **SQL**: `Query`, `QueryRow`, `Exec`, `Get`, `Select`, `Raw` and the other database/sql, pgx, sqlx and sqlc methods are built in; `db_methods` adds to them. Only constant SQL strings count.
- **ORMs**: xorm, gorm, bun and go-pg calls are built in. A chain like `db.Where(…).Find(&issues)` reads, and `Insert`/`Update`/`Delete`/`Create`/`Save` write. The table comes from the model's type: its `TableName()` method, a bun `table:` tag or go-pg `tableName` tag, a `Table("…")`/`Model(…)` argument, or else the ORM's naming convention (`Issue` is `issue` for xorm, `issues` for the others; a table a migration defines wins). The repo's own wrappers (`Insert(ctx, beans ...any)`, `GetByID[T any]`, `FindIDs(ctx, tableName)`) are followed, so the access belongs to whoever calls them with a model or table name. So are helpers that build and return a session (`issueQuery(ctx).Count()`), and `SQL("…")` in a chain is read as SQL. A type declared inside a function counts only if its table exists elsewhere, so a migration's local copy of a table is seen but a local result row isn't. Not seen: ent and sqlboiler (generated code), and queries whose model is only known at run time. Say so if the project relies on those.
- **Routes** are found for net/http `ServeMux` (Go 1.22 patterns), chi, gorilla/mux, echo, gin, fiber, httprouter and go-pkgz/routegroup, with constant paths. A project's own router type that wraps one of these (a struct holding the library's router) is followed too, when its methods use the usual names: `Get`/`Post`/… with a path then handlers (the last is the endpoint), `Methods`/`Match`, `Any`/`Handle`, `Group`/`Route` with a path and a callback (taking the router, or using the one it was called on), route builders such as `Combo("/x").Get(h).Post(h)`, `Mount` and `Use`. Routers that don't wrap one of these libraries, or use other method names, aren't seen and there's no setting for them; tell the user rather than working around it. Frontend pages come from React Router and Next.js.
- **TypeScript**: without `roots`, every directory with a `tsconfig.json` is a root. A root without one is loaded with default compiler options and no path aliases (codemap warns), so list directories that have their own tsconfig. Modules are directories; `module_depth` cuts module paths to that many segments.
- **HTTP calls from the frontend**: `fetch` and `axios` are built in. `http_clients` names wrapper functions, matched on the end of the callee (`api.get` matches `this.api.get`). The HTTP method comes from the name (`get`, `post`, …), or from a constant first argument (`request("POST", url)`). A URL that starts with a variable (`${base}/orders`) drops the variable. `base_url_prefixes` strips fixed prefixes so paths match the server's routes. Calls that match no route show under "unmatched routes".
- **External services**: calls into well-known SDKs are built in (Stripe, AWS, Postmark, Twilio, SendGrid, Slack, OpenAI, Anthropic, GitHub, Sentry, Redis, MongoDB, Kafka, NATS, RabbitMQ, Elasticsearch, Google Cloud and others). `[external.imports]` maps more import-path prefixes to an `ext:` ID.

After changing it, run `codemap modules` (or `codemap show` on something you expect to see) to check the map picked it up.
