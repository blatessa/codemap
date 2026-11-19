# Configuring extraction (.codemap/config.toml)

Everything is optional, and `config.toml` is the only settings file in `.codemap/`. Add only what the code shows is missing; an empty config is a fine result.

## Setting up a repo

1. **Run it bare.** `codemap modules`, then `codemap show` on a few entry points you know. Note the warnings.
2. **Look for what the map should have but doesn't**, one kind at a time:
   - **Jobs**: grep for `cron`, `Schedule`, `Every`, `ticker`, `worker`. Find the registering call and write its callee as `(*pkg.Type).Method` or `pkg.Func`.
   - **Events and queues**: grep for `Publish`, `Subscribe`, `Emit`, `Enqueue`, `Consume`. Configure `subscribers` and `publishers` the same way.
   - **Frontend to API**: `codemap show` a page. If it calls no routes, find the HTTP wrapper (`api.get`, `request`) and add `http_clients`; if paths don't match server routes, add `base_url_prefixes`. In a monorepo set `ts.roots`; if the screens are wrong, set `screens`.
   - **Outside services**: `codemap show` an entry point that sends email, takes payments or calls an API. If the service is missing, map its SDK import path under `[external.imports]`.
   - **Database**: if a table is missing, check `migrations` points at the real files and `db_methods` lists custom SQL helpers.
   - **Noise**: generated code and scripts go in `exclude`.
3. **Confirm each addition.** After every edit, run any command: it warns about each unknown key (a typo maps nothing) and each `jobs`, `subscribers` or `publishers` call that matched nothing. Fix the warnings, then `codemap show` something that should now appear.
4. **Report** what you configured, and what the map can't see here (an unsupported router, ent or sqlboiler, dynamic dispatch) rather than working around it.

## Example

Top-level keys must come before the first `[table]`.

```toml
exclude = ["tools/**", "**/*_gen.go"]   # globs on paths from the repo root
migrations = ["db/migrations/*.sql"]     # default: db/migrations/*.sql, migrations/*.sql, **/migrations/*.sql
editor = "code -g {file}:{line}"         # opens files from the viewer; default: $VISUAL or $EDITOR with +line

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
screens = ["web/src/pages/**"]           # files whose components are the app's screens

[external.imports]
"github.com/acme/billing-sdk" = "ext:billing"
```

## Keys

- **Globs** (`exclude`, `migrations`, `screens`): `**` matches any number of directories, `*` stays within one, matched against the whole path from the repo root (`*.config.ts` only matches top-level files; `**/*.config.ts` matches anywhere). `vendor`, `node_modules`, `testdata`, `third_party` and directories starting with `.` or `_` are always skipped.
- **Call patterns** (`jobs`, `subscribers`, `publishers`): `call` is the callee's go/types name, with the full import path or just the package name: `example.com/app/queue.CreateQueue`, `queue.CreateQueue`, `(*events.Bus).Publish`. Generic functions are written without type parameters. Argument indexes start at 0 and don't count the receiver. The name or topic must be a constant string and the handler must resolve to a function. A call through an interface matches a pattern naming the implementation.
- **SQL**: database/sql, pgx, sqlx and sqlc are built in; `db_methods` adds more. Only constant SQL counts.
- **ORMs**: xorm, gorm, bun and go-pg are built in, including the repo's own wrappers around them. Not seen: ent and sqlboiler (generated code) and models only known at run time.
- **Routes**: net/http `ServeMux`, chi, gorilla/mux, echo, gin, fiber, httprouter and routegroup, with constant paths, plus the project's own router types that wrap one of these and use the usual method names. Other routers aren't seen and there's no setting for them. Frontend pages come from React Router and Next.js.
- **TypeScript**: without `roots`, every directory with a `tsconfig.json` is a root. Modules are directories; `module_depth` cuts their paths to that many segments. Without `screens`, screens are the router's pages or the components nothing else renders.
- **Frontend HTTP calls**: `fetch` and `axios` are built in. `http_clients` names wrappers, matched on the end of the callee (`api.get` matches `this.api.get`); the method comes from the name or a constant first argument. A URL starting with a variable drops it; `base_url_prefixes` strips fixed prefixes so paths match the server's routes.
- **External services**: well-known SDKs (Stripe, AWS, Slack, OpenAI, Redis, Kafka and similar) are built in, and outbound HTTP to a constant host becomes that host. `[external.imports]` maps more import-path prefixes to an `ext:` ID.
