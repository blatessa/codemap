---
name: codemap
description: Queries a codebase's architecture map (entry points, call paths, modules, database tables, topics, external services) with the codemap CLI, reviews what a change did to the architecture, and writes proposals the user reviews in the codemap viewer. Use when the repo has a .codemap/ directory, when the user mentions codemap or a proposal, when asked what calls something, what a route or job touches, or what a change could affect, and after making structural changes.
---

# codemap

codemap maps a codebase from its code: programs, modules, functions and the calls between them, HTTP routes, frontend pages, jobs, commands, subscribers, database tables (read vs. write), topics and external services. The user browses it in a viewer (`codemap serve`, where modules are called parts); you query the same map from the terminal.

The map comes from static analysis. It can miss calls made through reflection or dynamic dispatch inside libraries, and it can over-approximate. Check the code before relying on it for anything that matters.

If `codemap version` fails, the binary isn't installed: tell the user (`curl -fsSL https://raw.githubusercontent.com/blatessa/codemap/main/install.sh | sh`) rather than working around it.

## Query

Run from the repo root; each command builds the graph from the working tree (the first run is slow, later ones are quick). Add `--json` for structured output and `--rev <commit|branch|tag>` to ask about another revision.

```sh
codemap show "POST /orders"      # an entry point: its call tree, ending in what it reads, writes, publishes and calls; then its tests
codemap show Service.Place       # a function: the same, plus what calls it up to the entry points
codemap show orders              # a table, topic or service: who writes, reads, publishes or calls it, by feature
codemap show internal/orders     # a module: its contents, what it depends on, what uses it
codemap modules                  # every module, with size and dependencies
codemap search refund            # labels, files and doc comments
```

Name things as codemap prints them: an ID, a route (`"GET /orders/{id}"`), a page path (`/checkout`), a label (`Service.Place`) or a qualified label (`orders.Service.Place`). Any row of output can be pasted back in. An ambiguous name lists the candidate IDs and exits with status 2; rerun with one of them.

Reading the trees:
- Trees show a feature's architecture, not every call. Forwarding functions are skipped and support code (wiring, utilities such as a logger or transaction helper) is left out, counted on the parent as `(+2)`; a node's `role:` line names its kind of support code.
- A row ending in `...` has more below that isn't shown (a widely used function, or past the 4-level limit): `show` it on its own to see inside.
- `→ writes orders · calls api.stripe.com` on a row lists effects reached below it that the tree doesn't show, so nothing hides a table, topic, service or API call.
- `Error · 107 implementations` is a call through an interface or function value; it isn't followed.
- Traces stop at external systems, including topics: what subscribes to a topic is its own entry point.
- `Tests:` lists tests that call the code directly or through one helper. A short list doesn't mean the code is untested end to end.

Before changing code, `show` the entry points and functions involved to see what the change could affect.

## Review a change

After making changes, and before reporting them as done:

```sh
codemap diff                # uncommitted changes
codemap diff main...        # this branch, plus uncommitted changes
codemap diff pr:42          # a GitHub pull request
```

Check the output for surprises and tell the user about them:
- [ ] entry points added or removed that you didn't mean to
- [ ] tables newly written or read, or no longer
- [ ] new external services or topics
- [ ] new dependencies between modules that shouldn't know about each other

The user can see the same comparison in the viewer.

## Proposals

A proposal sketches how the architecture could change. The viewer draws it over the real map; it isn't checked against the code and doesn't need to match what gets built. Write one when the user asks for one, or when a change is big enough that they should see its shape first.

```sh
codemap proposal new "Refunds" --body body.md   # --body - reads stdin
codemap proposal list
codemap proposal archive refunds --pr 91        # once it's built or dropped
```

Then edit `.codemap/proposals/<slug>.md`: TOML frontmatter for the sketch, Markdown for the reasoning. See [reference/proposals.md](reference/proposals.md) for the format.

When asked to work through a proposal, read its body: the user's comments from the viewer are appended under `###` headings naming what each is about, and they are the things to address.

## Make the map better

- **Something the code clearly has is missing** (jobs, queue handlers, frontend calls to the API, an external service): configure `.codemap/config.toml`. See [reference/config.md](reference/config.md). Then check the warnings it prints and `codemap show` something you expect to see.
- **A module is hard to understand**: the viewer shows its package or file doc comment. Adding one (with the user's agreement) is the best way to explain it.
- **A module mixes unrelated jobs**: that's a proposal to split it in the code. The map draws the code as it is.
