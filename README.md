# codemap

An interactive architecture map of a codebase, built from the code itself, for understanding
a system and sketching changes.

Work in progress. `PLAN.md` is the plan, and `docs/prototype.html` is a clickable prototype
of the viewer (open it in a browser).

## Layout so far

- `internal/graph`: graph types, IDs, merging and queries
- `internal/project`: reading and writing the `.codemap/` files
- `testdata/shop`: fixture repo (a Go server plus a TypeScript web app)
- `testdata/shop.expected.json`: the hand-written graph the extractors aim for

## Checks

```sh
go test ./...                                         # codemap
(cd testdata/shop && go test ./...)                   # fixture server
(cd testdata/shop/web && npm ci && npx tsc && npx vitest run)   # fixture web app
```
