# Proposal format

A proposal is `.codemap/proposals/<slug>.md`: TOML frontmatter between `+++` lines holding the sketch, then Markdown (why, the shape of the change, open questions).

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

[[note]]
on = "go:shop/internal/orders.(*Repo).Find"
file = "internal/orders/repo.go"
from = 25
to = 26
quote = "SELECT * FROM orders WHERE id = $1"
text = "Find has no user check. Refund must not rely on it."
+++
## Why
…
```

Rules:
- New things use `new:` IDs. Existing things use their real IDs, from `codemap search` or `codemap show … --json`.
- `module` places a new node in an existing module (`mod:go:<import path>`, `mod:ts:<dir>`) or a proposed one.
- Each `[[module]]`, `[[node]]` and `[[edge]]` table is one entry. Keep the top-level keys (`name`, `status`) above the first table.
- `kind` is any of `function`, `route`, `page`, `job`, `subscriber`, `command`, `component`, `table`, `topic`, `service`. Routes take `method`; entry points take `entry = true`.
- Edges default to `type = "calls"`; use `reads`, `writes` or `publishes` for data and topics. `detail` is shown on the edge.
- Nodes accept any extra fields (strings, arrays, inline tables such as `links = [{label = "Docs", url = "https://…"}]`); the viewer shows them.
- To move an existing function to another module, list it with its real ID and the new `module`.
- A `[[note]]` is a comment on lines of code (`file`, `from`, optional `to`, the `quote` as read, optionally the node it was made on as `on`). `text` is Markdown. The viewer shows it under those lines; `codemap proposal show` prints it with its code and says when the code has changed since.
- A new node's `doc` says what it does; `proposal show` and the viewer's panel print it.
- Review with `codemap proposal show <slug>` (add `--json` for the raw proposal and its problems).
- Leave `base` and `updated` alone; codemap sets them.
