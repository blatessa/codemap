---
name: codemap
description: Use codemap to understand a project's architecture (entry points, call paths, modules, tables, external services) and to write architecture proposals the user reviews in the codemap viewer, and to organise the map (areas, blocks) so it reads well. Use when the project has a .codemap/ directory, when the user mentions codemap or a proposal, asks to organise or tidy the map, or before structural changes where knowing what calls what would help.
---

# codemap

codemap builds a map of a codebase from its code: modules, functions, the calls between them, HTTP routes, frontend pages, database tables (read vs. write), queue topics and external services. The user browses it in a viewer (`codemap serve`). You can query the same map from the terminal.

The map is context, not a spec. It comes from static analysis, so it can miss calls (reflection, dynamic dispatch through library code) and occasionally over-approximate (a test using fakes may appear to reach the real implementation). Check the code when it matters.

## Querying the map

Run these from the repo root. Each one builds the graph from the working tree. The first run on a repo can take a while, and after that it's quick. Add `--json` for machine-readable output.

```sh
codemap show "POST /orders"          # call tree below an entry point or function, with SQL and API details, then the tests that reach it
codemap show orders.Service.Place --depth 3
codemap callers Repo.UpdateStatus    # what reaches this, up to the entry points
codemap module internal/orders       # contents, what it depends on, what uses it
codemap modules                      # every module at once, with its area and dependencies
codemap search refund                # labels, files and doc comments
```

You can name a node by its ID, a route (`"GET /orders/{id}"`), a page path (`/checkout`), a label (`Service.Place`), or a module-qualified label exactly as codemap prints it (`orders.Service.Place`). You can paste any row of output back in.

If a name matches several nodes, codemap lists their IDs and exits with status 2. Rerun the command with one of the IDs.

Output conventions:
- Tables, topics, services and tests carry a tag, such as `orders [table]`.
- Edge details follow the name, such as `writes: UPDATE orders …` or `PaymentIntents.New`.
- `(see above)` marks a node that's already expanded higher up the tree.
- `show` and `callers` default to `--detail features`: short forwarding functions are skipped (A → C instead of A → B → C), and wiring, utility, generated and unreachable code is left out, counted on the parent line as `(+2 support)`. Use `--detail code` to see every call. A node's `role:` line says which kind of support code it is.
- Traces stop at external systems.

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
area = "Commerce"

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

## Organising the map

When the user asks you to make the map readable ("make this codebase look good in codemap", "organise the map"), you shape how it's grouped. You don't change code. The user reads the map at three levels: areas (named regions), the modules inside them, and the functions inside a module, which only show in full when they select it. Aim for a first screen that explains the system in a few seconds.

1. Get the whole picture:
   ```sh
   codemap modules            # every module: size, entry points, area, what it depends on; then problems
   codemap module internal/orders   # a closer look where a module is unclear or very large
   ```
2. Group modules into **areas** in `.codemap/areas.toml`, by what they do for the product, not by folder: "Checkout", "Accounts", "Background jobs", "Web app", "Platform". Some rules of thumb:
   - About 3 to 8 areas. Each one should be explainable in a sentence.
   - Put modules that call each other a lot together. Modules many others use (config, logging, db helpers) go in one "Platform" or "Shared" area.
   - Keep the frontend and its API close: name areas so a page and the routes it calls read as one story.
   - External systems (databases, queues, third-party services) can share an "External" area.
   - Every module should be in at most one area. Leaving a few out is fine.

   ```toml
   [[area]]
   name = "Checkout"
   modules = ["mod:go:shop/internal/orders", "mod:ts:web/src/pages/checkout", "block:handlers-billing"]
   ```
   List module and block IDs exactly as `codemap modules` prints them.
3. **Split** a module that mixes unrelated jobs, or that's much larger than the rest (say 40+ functions), into blocks in `.codemap/blocks.toml`. A node goes into the first block whose rules match it; the rest stay in the module. Blocks can go in areas by their `id`.
   ```toml
   [[block]]
   id = "block:handlers-billing"            # "block:" + a slug of the name
   name = "handlers · billing"
   from = "mod:go:app/internal/handlers"
   match = ["Billing*", "*Invoice*"]        # globs on function labels
   files = ["internal/handlers/billing*"]   # and/or globs on file paths
   ```
4. **Describe** modules in the doc comments that already exist: the viewer shows a module's package doc comment (Go) or file doc comment. If they're missing and the user agrees, adding them is the best way to explain a module.
5. Positions aren't stored: codemap lays the map out from the areas and blocks every time, and an open viewer redraws as soon as you save the files. (An old `.codemap/layout.json` is ignored and can be deleted.)
6. Run `codemap modules` again and fix anything under "Problems" (unknown IDs, a module in two areas, a block without an id). Then tell the user what you grouped and why in a few lines, and suggest they look at it in `codemap serve`.

Areas and blocks are the user's to adjust afterwards. Don't redo their changes later unless they ask.

## Other .codemap files

These belong to the user. They edit them in the viewer, and the files are plain text if you're asked to change them:

| File | Contents |
|---|---|
| `areas.toml` | Named groups of modules, one `[[area]]` each |
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
- **SQL**: `Query`, `QueryRow`, `Exec`, `Get`, `Select`, `Raw` and the other database/sql, pgx, sqlx and sqlc methods are built in; `db_methods` adds to them. Only constant SQL strings count. ORM query builders (xorm, gorm, ent) aren't seen, so tables reached that way are missing from the map; say so if the project uses one.
- **Routes** are found for net/http `ServeMux` (Go 1.22 patterns), chi, gorilla/mux, echo, gin, fiber, httprouter and go-pkgz/routegroup, with constant paths. There's no setting for other routers: a project with its own router has no route entry points on the map. Tell the user rather than trying to work around it. Frontend pages come from React Router and Next.js.
- **TypeScript**: without `roots`, every directory with a `tsconfig.json` is a root. A root without one is loaded with default compiler options and no path aliases (codemap warns), so list directories that have their own tsconfig. Modules are directories; `module_depth` cuts module paths to that many segments.
- **HTTP calls from the frontend**: `fetch` and `axios` are built in. `http_clients` names wrapper functions, matched on the end of the callee (`api.get` matches `this.api.get`). The HTTP method comes from the name (`get`, `post`, …), or from a constant first argument (`request("POST", url)`). A URL that starts with a variable (`${base}/orders`) drops the variable. `base_url_prefixes` strips fixed prefixes so paths match the server's routes. Calls that match no route show under "unmatched routes".
- **External services**: calls into well-known SDKs are built in (Stripe, AWS, Postmark, Twilio, SendGrid, Slack, OpenAI, Anthropic, GitHub, Sentry, Redis, MongoDB, Kafka, NATS, RabbitMQ, Elasticsearch, Google Cloud and others). `[external.imports]` maps more import-path prefixes to an `ext:` ID.

After changing it, run `codemap modules` (or `codemap show` on something you expect to see) to check the map picked it up.
