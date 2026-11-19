# codemap

An interactive architecture map of a codebase, built from the code itself. See what your
(or your agents') code actually does: entry points, call paths, modules, database tables,
queues and external services. Compare branches, and sketch changes as proposals.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/blatessa/codemap/main/install.sh | sh
```

That puts `codemap` in `~/.local/bin` (Linux and macOS, amd64 and arm64). Set
`CODEMAP_INSTALL_DIR` to put it elsewhere, or `CODEMAP_VERSION=v0.1.0` for a specific release.

Or, with Go 1.27 or later:

```sh
go install github.com/blatessa/codemap/cmd/codemap@latest
```

codemap reads code with the tools you already have: **Go** to map Go code, **Node.js** to
map TypeScript, and **git** to compare revisions. Whatever's missing is skipped with a
note.

## The model

codemap shows how a system's parts work together, not every function in it.

- **Things.** Code at three levels: *programs* (a server, a web app, a CLI, a worker),
  their *parts* (packages and folders), and *functions*. Outside the code: *data* (tables),
  *services* (Stripe, other APIs) and *channels* (topics, queues).
- **Connections**, by how things talk: calls, HTTP, publishes and subscribes, schedules,
  reads and writes, shows (a screen). Between parts, they're the sum of their functions'.
- **Entry points**, where work starts from outside: a route, a screen, a command, a job, a
  subscriber.

The map draws programs, their parts, and the tables, topics and services they use, and how
they connect. It never draws functions. Selecting something lights it up on the same map,
and the panel beside the map shows the detail:

- an entry point: the parts its path goes through, and in the panel its call tree, ending in
  what it reads, writes, publishes and calls, with the tests along the way;
- a part: what it uses and what uses it, and the functions used from outside it;
- a table, topic or service: what reads, writes, publishes or calls it.

Supporting code (helpers, forwarding functions, a screen's own components) is left out of
call trees and counted. The call trees in the viewer and in `codemap show` come from the same
Go code.

## Use

```sh
cd your-repo
codemap serve          # opens the map in your browser
```

- Click a part or a table to see its connections; search for a route, page, job or function
  to see its path through the code.
- `Ctrl/⌘ K` searches and runs commands; right-click for more.
- On a branch, the map opens on what changed since `main`.
- **Proposals** sketch a change on the map; click a part's `+` to add to it, then click what it calls; click a line number in the code to comment on it. Agents read it all with `codemap proposal show`.

From the terminal (handy for agents too): `codemap show "POST /orders"`,
`codemap show internal/orders`, `codemap modules`, `codemap diff main...`. Run `codemap` for
the full list.

Settings and proposals live in `.codemap/` in your repo, as plain TOML and
Markdown you can commit.

## Agent skill

`skills/codemap/SKILL.md` teaches a coding agent to query the map, review what it changed,
and work through proposals. The repo is a Claude Code plugin and its own
marketplace, so in Claude Code:

```
/plugin install codemap --marketplace blatessa/codemap
```

On versions before 2.1.275, run `/plugin marketplace add blatessa/codemap`, then
`/plugin install codemap@codemap`. The `codemap` binary must be on your PATH.

Then ask things like "what does POST /orders touch?" or "work through the refunds
proposal".

## Development

The viewer is in `viewer/` (React + Vite) and is built into
`internal/web/dist`, which is committed so `go install` works without Node. The
viewer's call trees, selections and test lists come from the Go code in
`internal/graph`, compiled to WebAssembly (`cmd/codemap-wasm`); Vite and Vitest
build it, so they need Go on the PATH.

```sh
go test -short ./...                         # fast; drop -short to include git revision builds
(cd viewer && npm ci && npm run build)       # rebuild the embedded viewer
(cd viewer && npx vitest run && npx playwright test)
```

`npm run dev` and the browser tests run the real `codemap serve` on a git copy of
`testdata/shop` (a `main` branch and a branch with one change), with Vite
forwarding `/api` to it. Set `CODEMAP_ROOT` to point it at another repo.

Releases: push a `v*` tag and the `release` workflow builds the binaries with GoReleaser.

## License

MIT. See `LICENSE`.
