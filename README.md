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

The map draws programs and parts and how they connect. Selecting something shows it on the
same map: an entry point, its path through the system; a part, its connections; a table or
service, who reads, writes or calls it. Functions appear only on a selected path, and in
the panel beside the map. Supporting code (helpers, forwarding functions, a screen's own
components) is left out of paths and counted.

## Use

```sh
cd your-repo
codemap serve          # opens the map in your browser
```

- Click a module to see what's inside, a function to see its path through the code.
- `Ctrl/⌘ K` searches and runs commands; right-click for more.
- On a branch, the map opens on what changed since `main`.
- **Proposals** sketch a change on the map; select anything and press `C` to comment.

From the terminal (handy for agents too): `codemap show "POST /orders"`,
`codemap callers Repo.Find`, `codemap modules`, `codemap diff main...`. Run `codemap` for
the full list.

Settings, blocks and proposals live in `.codemap/` in your repo, as plain TOML and
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

Then ask things like "make this codebase look good in codemap" or "work through the refunds
proposal".

## Development

The viewer is in `viewer/` (React + Vite) and is built into
`internal/web/dist`, which is committed so `go install` works without Node.

```sh
go test -short ./...                         # fast; drop -short to include git revision builds
(cd viewer && npm ci && npm run build)       # rebuild the embedded viewer
(cd viewer && npx vitest run && npx playwright test)
```

Releases: push a `v*` tag and the `release` workflow builds the binaries with GoReleaser.

## License

MIT. See `LICENSE`.
