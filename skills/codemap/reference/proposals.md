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
on = "new:orders.Service.Refund"
text = "Owns the rules. The handler doesn't pre-check anything."

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
- A `[[note]]` is something the sketch can't say, pinned to a node (`on`), to lines of code (`file`, `from`, optional `to`, and the `quote` as read), or to nothing. `text` is Markdown. The viewer shows notes under the code and on the node's panel; `codemap proposal show` prints them with their code and says when it has changed since.
- Review with `codemap proposal show <slug>` (add `--json` for the raw proposal and its problems).
- Leave `base` and `updated` alone; codemap sets them.
