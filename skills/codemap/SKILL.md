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
codemap show "POST /orders"          # call tree below an entry point or function, with SQL and API details, then the tests that reach it
codemap show orders.Service.Place --depth 3
codemap callers Repo.UpdateStatus    # what reaches this, up to the entry points
codemap module internal/orders       # contents, what it depends on, what uses it
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

## Other .codemap files

These belong to the user. They edit them in the viewer, and the files are plain text if you're asked to change them:

| File | Contents |
|---|---|
| `areas.toml` | Named groups of modules, one `[[area]]` each |
| `blocks.toml` | A module split into blocks by pattern, one `[[block]]` each |
| `views.toml` | Saved views, one `[[view]]` each |
| `hidden.toml` | Things the user took off the map, one `[[hide]]` each: an `id`, or a `match` glob on labels with an optional `module` |
| `layout.json` | Box positions |
| `external.toml` | External systems and their details (`[[node]]`): owner, links, setup. Also calls into the code that the code can't show, such as a webhook from Stripe (`[[edge]]`). |
| `config.toml` | Extractor settings: job, subscriber and publisher call patterns, HTTP client wrappers, migration globs, the editor command |

Don't rewrite them unprompted.
