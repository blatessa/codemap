# Configuring extraction (.codemap/config.toml)

Edit it when the map is missing something the code clearly has. Everything is optional, and `config.toml` is the only settings file in `.codemap/`. Top-level keys must come before the first `[table]`.

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

After editing, run any command (`codemap show …`). It prints a warning for each key it doesn't know (a typo maps nothing) and for each `jobs`, `subscribers` or `publishers` call that matched no call in the code. Fix those, then `show` something you expect to see.

## Keys

- **Globs** (`exclude`, `migrations`, `screens`): `**` matches any number of directories, `*` stays within one, matched against the whole path from the repo root (`*.config.ts` only matches top-level files; `**/*.config.ts` matches anywhere). `vendor`, `node_modules`, `testdata`, `third_party` and directories starting with `.` or `_` are always skipped.
- **Call patterns** (`jobs`, `subscribers`, `publishers`): `call` is the callee's go/types name, with the full import path or just the package name: `example.com/app/queue.CreateQueue`, `queue.CreateQueue`, `(*events.Bus).Publish`. Generic functions are written without type parameters. Argument indexes start at 0 and don't count the receiver. The name or topic must be a constant string and the handler must resolve to a function. A call through an interface matches a pattern naming the implementation.
- **SQL**: database/sql, pgx, sqlx and sqlc methods (`Query`, `QueryRow`, `Exec`, `Get`, `Select`, `Raw`, …) are built in; `db_methods` adds more. Only constant SQL counts.
- **ORMs**: xorm, gorm, bun and go-pg are built in. Chains like `db.Where(…).Find(&issues)` read; `Insert`/`Update`/`Delete`/`Create`/`Save` write. The table comes from `TableName()`, a bun or go-pg tag, a `Table(…)`/`Model(…)` argument, or the ORM's naming convention (a table a migration defines wins). The repo's own wrappers and session-building helpers are followed. Not seen: ent and sqlboiler (generated code) and models only known at run time; tell the user if the project relies on those.
- **Routes**: net/http `ServeMux`, chi, gorilla/mux, echo, gin, fiber, httprouter and routegroup, with constant paths, plus the project's own router types that wrap one of these and use the usual method names (`Get`/`Post`…, `Group`/`Route`, `Mount`, `Use`, route builders). Other routers aren't seen and there's no setting for them; tell the user rather than working around it. Frontend pages come from React Router and Next.js.
- **TypeScript**: without `roots`, every directory with a `tsconfig.json` is a root. Modules are directories; `module_depth` cuts their paths to that many segments. `screens` names the files whose components are screens; unset, they're the router's pages or the components nothing else renders.
- **Frontend HTTP calls**: `fetch` and `axios` are built in. `http_clients` names wrappers, matched on the end of the callee (`api.get` matches `this.api.get`); the method comes from the name or a constant first argument. A URL starting with a variable drops it; `base_url_prefixes` strips fixed prefixes so paths match the server's routes.
- **External services**: well-known SDKs are built in (Stripe, AWS, Postmark, Twilio, SendGrid, Slack, OpenAI, Anthropic, GitHub, Sentry, Redis, MongoDB, Kafka, NATS, RabbitMQ, Elasticsearch, Google Cloud and more). Outbound HTTP to a constant host becomes that host. `[external.imports]` maps more import-path prefixes to an `ext:` ID.
