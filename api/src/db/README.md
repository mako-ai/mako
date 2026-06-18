# Mako Postgres Migration (Drizzle) — Handoff & Runbook

> **Status:** in progress. Mongo (Mongoose) is still the **system of record**.
> Postgres runs **alongside** it and is kept current by backfill + dual-write.
> Reads are being cut over **per-domain** behind feature flags. CDC is last.
>
> This is the canonical doc for anyone (human or agent) continuing the work or
> deploying it. Keep it up to date as domains are cut over.

---

## 1. Why we're migrating to Postgres

The app's own metadata lived in MongoDB via Mongoose (`api/src/database/schema.ts`
and `workspace-schema.ts`, ~37 models). Moving it to Postgres (Drizzle ORM) buys:

- **Referential integrity.** Mongo had string-as-ObjectId refs, polymorphic refs,
  and arrays of ObjectIds with no enforcement. Postgres gives real foreign keys
  and constraints where it matters (tenancy + within-domain relationships).
- **Typed, composable queries.** Drizzle gives end-to-end TypeScript types from
  schema → query → result, with real `JOIN`s and transactions instead of
  hand-rolled `$lookup`/multi-query stitching.
- **First-class Zod/OpenAPI integration.** The REST surface already uses
  `@hono/zod-openapi`; Drizzle schemas line up cleanly with that.
- **JSONB where we still want flexibility** (chat messages, dashboard configs,
  connector/connection blobs) while gaining SQL querying/indexing over them.
- **pgvector** for console/skill embeddings — one engine for relational data and
  vector search (e.g. Neon supports pgvector natively).
- **Operational fit.** Neon serverless Postgres (branching, autoscaling) is the
  target host.

The migration is **gradual and reversible** — no big-bang cutover — so we never
risk a hard break.

---

## 2. Current status

| Domain | PG schema | Repository | Backfill | Dual-write (Mongo→PG) | Reads cut over |
|---|---|---|---|---|---|
| **auth – users** | ✅ | ✅ | ✅ | ✅ (post-save hook) | partial: session validation only |
| **auth – sessions** | ✅ | ✅ | ✅ | n/a (PG-authoritative when flag on) | ✅ (`AUTH_PERSISTENCE=postgres`) |
| auth – oauth/email-verif | ✅ | partial | ✅ | ❌ (backfill only) | ❌ |
| auth – desktop codes | ✅ | ❌ | ❌ | ❌ | ❌ |
| **workspaces + members** | ✅ | ✅ (members only) | ✅ | ✅ (post-save hooks) | ❌ (reads still Mongo) |
| workspace invites / api keys | ✅ | partial | ✅ | ❌ | ❌ |
| **connections (`database_connections`)** | ✅ | ✅ | ✅ | ✅ (post-save hook) | ✅ for query execution (`CONNECTIONS_PERSISTENCE=postgres`) |
| connectors | ✅ | ❌ | ✅ | ❌ | ❌ |
| **consoles (folders + saved_consoles)** | ✅ | ✅ | ✅ | ❌ | ❌ (only `/api/pg` demo) |
| **chats (+ attachments, llm_usage)** | ✅ | ✅ | ✅ | ❌ | ❌ (only `/api/pg` demo) |
| **query_executions** | ✅ | ✅ | ✅ | ❌ | ❌ (only `/api/pg` demo) |
| entity_versions (console/dashboard history) | ❌ | ❌ | ❌ | ❌ | ❌ |
| dashboards, apps, skills, dbt, notifications, flows, **CDC**, etc. | ❌ | ❌ | ❌ | ❌ | ❌ |

"Reads cut over" = the live app reads this domain from Postgres when the flag is
on. Everything not cut over still reads Mongo, so the app is fully functional at
every step.

### 2.1 What is cleanly migratable today

Treat a domain as clean only when it has **schema + backfill + dual-write + a live
read seam/flag**. A table plus a successful backfill is not enough.

The clean first migration unit is:

1. `users` as a dependency of sessions (not full auth yet).
2. `sessions` via `AUTH_PERSISTENCE=postgres`.
3. `workspaces` and `workspace_members` as dependencies for access checks (not
   full workspace CRUD yet).
4. `database_connections` for query execution via
   `CONNECTIONS_PERSISTENCE=postgres`.

Everything else with a PG table is currently **schema/backfill validation only**,
not production cutover work. In particular, the console/chats/query rows that
were backfilled into Neon prove the current schema can ingest a snapshot, but
they will drift because their live write paths still use Mongo only.

### 2.2 Dependency graph

```text
users
  ├─ sessions
  ├─ oauth_accounts
  ├─ desktop_auth_codes
  └─ workspace_members

workspaces
  ├─ workspace_members
  ├─ workspace_invites
  ├─ workspace_api_keys
  ├─ database_connections
  │   ├─ saved_consoles
  │   ├─ query_executions
  │   └─ connectors.target_databases
  ├─ console_folders
  │   └─ saved_consoles
  ├─ chats
  │   └─ chat_attachments
  ├─ llm_usage
  └─ query_executions

saved_consoles
  ├─ query_executions
  └─ entity_versions (Mongo only today; hard blocker for console history)
```

Console cutover depends on more than `saved_consoles`: it also needs
`console_folders`, `database_connections`, `entity_versions`, realtime
`draftRevision` semantics, optimistic `version` guards, query execution stats,
and scheduled-query state.

---

## 3. Architecture / file map

```
api/src/db/
  client.ts              Postgres pool + Drizzle instance (getDb/getPool/pingPostgres/closePostgres)
  crypto.ts              AES-256-CBC (same scheme/key as the Mongoose getters)
  ids.ts                 ObjectId↔uuid (reversible) + UUIDv5 for legacy nanoids/sentinels
  ids.test.ts            unit tests for the id mapping
  schema/                Drizzle tables (auth, workspaces, connections, consoles, chats, queries)
  repositories/          typed CRUD per domain (used by stores + /api/pg + backfill)
  migrate.ts             migration runner (creates uuid-ossp + vector, then applies SQL)
  migrations/            drizzle-kit generated SQL + journal  (DO NOT hand-edit applied files)
  dual-write.ts          Mongo→PG mirror helpers + dualWriteEnabled() gate
  backfill.ts            one-time/repeatable ETL Mongo→PG (db:backfill)
  verify.ts              Mongo↔PG drift report / cutover gate (db:verify)
  connection-store.ts    read seam for connections (Mongo|Postgres) used by query execution
  repositories.test.ts / persistence.routes.test.ts   integration + OpenAPI e2e (test:pg)

api/src/auth/
  session-store.ts       read/write seam for sessions (Mongo|Postgres)
  session.ts             SessionManager delegates to the session store

api/src/routes/
  pg-persistence.routes.ts   @hono/zod-openapi read API mounted at /api/pg

api/drizzle.config.ts    drizzle-kit config (schema, out dir, dbCredentials)
```

Mongoose post-save hooks that dual-write live in `database/schema.ts` (User) and
`database/workspace-schema.ts` (Workspace, WorkspaceMember, DatabaseConnection).

---

## 4. Environment variables & feature flags

| Var | Default | Purpose |
|---|---|---|
| `POSTGRES_URL` | `postgres://postgres@127.0.0.1:5432/mako_dev` | PG connection string (set to Neon in prod). `PG_DATABASE_URL` is an alias. |
| `POSTGRES_MAX_POOL_SIZE` | `10` | pg pool size |
| `POSTGRES_SSL` | auto | TLS auto-enabled for non-local hosts; set `false` to force off |
| `NEON_API_KEY` | — | Neon API token used by CI/local scripts to create branches and connection strings |
| `NEON_ORG_ID` | — | Neon organization id; backed up in Google Secret Manager for recovery |
| `NEON_PROJECT_ID` | — | Neon project id used by branch automation |
| `NEON_DATABASE_NAME` | `neondb` | Database name for generated connection URIs |
| `NEON_ROLE_NAME` | `neondb_owner` | Role name for generated connection URIs |
| `NEON_POOLED` | `true` | Generate pooled Neon connection URIs |
| `POSTGRES_DUAL_WRITE` | unset | `true` → mirror all dual-written domains to PG |
| `AUTH_PERSISTENCE` | `mongo` | `postgres` → sessions read/write from PG (implies users dual-write) + startup ping |
| `CONNECTIONS_PERSISTENCE` | `mongo` | `postgres` → query execution resolves connections from PG |
| `BACKFILL_MONGO_URL` | falls back to `DEV_DATABASE_URL`/`DATABASE_URL` | source Mongo for `db:backfill` / `db:verify` |
| `ENCRYPTION_KEY` | (required) | shared AES key; must match between Mongo and PG so credentials decrypt |

**All flags default to Mongo.** Postgres is only used where a flag is explicitly
set, so deploying this code with no flags set changes nothing at runtime (aside
from a lazy PG pool that is never opened).

---

## 5. Commands

Run from repo root (scripts live in the `api` package):

```bash
pnpm --filter api run db:generate   # regenerate SQL after editing src/db/schema/*
pnpm --filter api run db:migrate    # apply migrations (creates uuid-ossp + vector)
pnpm --filter api run db:backfill   # ETL Mongo → PG (idempotent)  [needs BACKFILL_MONGO_URL]
pnpm --filter api run db:verify     # Mongo↔PG drift report; non-zero exit on drift
pnpm --filter api run db:studio     # drizzle-kit studio (browse PG)
pnpm --filter api run test:pg       # ids + repositories + OpenAPI e2e tests (needs a running PG)
```

`db:backfill` accepts `--domains=auth,workspaces,connections,consoles,chats,queries`
(default = all, in dependency order). `db:verify` accepts `--sample=N`.

Backfill semantics:

- `db:backfill` is idempotent in the **insert-only** sense. Rows are inserted
  with `onConflictDoNothing`, so rerunning it will not duplicate data.
- It does **not** refresh existing PG rows. If Mongo changed after the first
  backfill, rerunning the current script only catches newly missing rows; it
  will not update edited rows or propagate deletes.
- Therefore, backfill is not a substitute for dual-write. For mutable domains
  (consoles, chats, connectors, usage, query history, invites, API keys), add
  dual-write or an upsert/reconciliation mode before treating a backfill as a
  real cutover step.

---

## 6. Local dev quickstart

```bash
# 1. Install + start a local Postgres (cloud VM has no local PG by default)
sudo apt-get install -y postgresql postgresql-contrib postgresql-16-pgvector
export PGBIN=/usr/lib/postgresql/16/bin
"$PGBIN/initdb" -D "$HOME/pgdata" -U postgres --auth=trust
"$PGBIN/pg_ctl" -D "$HOME/pgdata" -o "-p 5432 -c unix_socket_directories=/tmp" start
"$PGBIN/createdb" -h 127.0.0.1 -U postgres mako_dev

# 2. Apply migrations
export POSTGRES_URL="postgres://postgres@127.0.0.1:5432/mako_dev"
pnpm --filter api run db:migrate

# 3. (Optional) backfill cutover-ready data from the dev Mongo, then verify
export BACKFILL_MONGO_URL="$DEV_DATABASE_URL"
pnpm --filter api run db:backfill -- --domains=auth,workspaces,connections
pnpm --filter api run db:verify --sample=100   # expect 0 mismatch / 0 missing

# 4. Run the app against PG-backed auth + connections
export DATABASE_URL="$DEV_DATABASE_URL"        # Mongo (still the record of truth)
export AUTH_PERSISTENCE=postgres
export CONNECTIONS_PERSISTENCE=postgres
pnpm dev
```

Health: `GET http://localhost:8080/health` and `GET http://localhost:8080/api/pg/health`.

### Neon local branch workflow

If `NEON_API_KEY`, `NEON_ORG_ID`, and `NEON_PROJECT_ID` are present in `.env`,
you can work against a personal Neon branch instead of a local Postgres:

```bash
# Creates/reuses local-<git email/user/whoami>, writes .env.neon.local, runs migrations
pnpm neon:local

# Resets that local branch from the Neon default/prod branch, then reruns migrations
pnpm neon:local:reset

# Use the generated connection for the app shell
set -a && . ./.env.neon.local && set +a
pnpm dev
```

The generated `.env.neon.local` is ignored by git. Override the branch name with
`NEON_BRANCH_NAME=<name>` when needed.

---

## 7. Per-domain cutover playbook

Repeat this loop for each domain. Never skip the verify step.

1. **Seam** — route the domain's reads/writes through a store/repository so call
   sites stop importing the Mongoose model directly. (Done for sessions +
   connections; the pattern is `*-store.ts`.)
2. **Dual-write** — add a Mongoose `post('save')` hook in `dual-write.ts` so
   writes hit both stores. Gated by `dualWriteEnabled()`.
3. **Backfill** — `db:backfill --domains=<domain>` to copy history.
4. **Verify** — `db:verify` until 0 mismatch / 0 missing for the domain.
5. **Flip reads** — behind a per-domain flag (add one like the existing
   `AUTH_PERSISTENCE` / `CONNECTIONS_PERSISTENCE`). Shadow-read first if risky.
6. **Decommission** — once stable, stop the Mongo write and drop the collection.

Rollback at any point = flip the flag back to `mongo` (instant; dual-write keeps
both stores in sync).

---

## 8. Roadmap

- **Phase 1 (done):** schema + migrations + id mapping + repositories +
  backfill + verify; session store read/write seam; users/workspaces/members/
  connections dual-write; connection resolution read seam for query execution;
  `/api/pg` read API; Neon branch automation.
- **Phase 2 (safe foundation cutover):** enable and harden only the domains that
  are already dependency-complete: `AUTH_PERSISTENCE=postgres` for sessions and
  `CONNECTIONS_PERSISTENCE=postgres` for query execution. Route remaining
  non-CDC `DatabaseConnection.findById` reads through `connection-store`.
- **Phase 3 (complete auth + tenancy):** add repositories/read seams/dual-write
  for OAuth accounts, email verifications, desktop auth codes, workspace invites,
  and normalized workspace API keys. Decouple API-key auth from embedded
  `Workspace.apiKeys`.
- **Phase 4 (consoles + versions):** add SQL `entity_versions`, backfill it, add
  dual-write for `ConsoleFolder`, `SavedConsole`, and `EntityVersion`, preserve
  `version` + `draftRevision` write guards, and only then cut over console reads
  and writes. Backfill `description_embedding` before semantic search cutover.
- **Phase 5 (chats + usage + query history):** add dual-write/read seams for
  chats, chat attachments, LLM usage, and query executions. Fix field parity for
  usage/query analytics and wire Postgres retention crons.
- **Phase 6:** model + migrate the long tail (dashboards, apps, skills, dbt,
  notifications, realtime presence, model catalog).
- **Phase 7 (last):** sync/CDC (`cdc_*`, webhook events, flow executions).

---

## 9. TODO (actionable, what remains)

- [ ] **Next:** route all remaining non-CDC `DatabaseConnection.find*` reads
      through `connection-store`, then verify `CONNECTIONS_PERSISTENCE=postgres`
      covers every normal app query path.
- [ ] Add a focused CI/staging drift gate for the clean foundation domains:
      `auth,workspaces,connections`.
- [ ] Harden `AUTH_PERSISTENCE=postgres` with a session expiry cron using
      `sessionsRepository.deleteExpired()`.
- [ ] Complete API key migration before broader workspace cutover: repository,
      dual-write for create/revoke/last-used updates, and API-key auth reads from
      `workspace_api_keys` instead of embedded Mongo `Workspace.apiKeys`.
- [ ] Start console cutover only after the foundation/API-key work: design SQL
      `entity_versions` first, then console dual-write and route parity.
- [ ] Dual-write hooks for: `Connector`, `SavedConsole`, `ConsoleFolder`, `Chat`,
      `ChatAttachment`, `LlmUsage`, `QueryExecution`, `OAuthAccount`,
      `WorkspaceInvite`, `Workspace.apiKeys`. (Only User/Workspace/Member/
      DatabaseConnection dual-write today.)
- [ ] Backfill + repository + read seam for `desktop_auth_codes`.
- [ ] Repositories for `Connector`, oauth/email-verification/invites/api-keys
      (CRUD).
- [ ] Read seams + flags for consoles, chats, queries; then cut over the live
      routes (`routes/consoles.ts`, `routes/chats.ts`, `agent-thread.service.ts`,
      `query-execution.service.ts`).
- [ ] Add PG `entity_versions` before any console version/history cutover.
- [ ] Route remaining `DatabaseConnection.findById` reads through
      `connection-store` (dbt, dashboards, apps, flows — **excluding** sync/CDC).
- [ ] TTL replacement: Inngest cron calling `sessionsRepository.deleteExpired()`
      and `queriesRepository.deleteOlderThan()` (+ email/desktop codes). Mongo
      TTL indexes have no Postgres equivalent.
- [ ] Embeddings: backfill `saved_consoles.description_embedding` (skipped today)
      and move console semantic search to pgvector `<=>`.
- [ ] Drizzle transactions for the multi-table writes currently using Mongo
      transactions (workspace create + member + session in `workspace.service.ts`).
- [ ] Fuller auth cutover: read users from PG in `AuthService.login`/OAuth (today
      the password check still reads the Mongo user; sessions + user mirror are PG).
- [ ] Consolidate the `databaseConnectionService.getMainConnection()` native-Mongo
      bypass sites (migrations, embeddings, some sync) as their domains migrate.
- [ ] CI: add `drizzle-kit check` drift gate and run `db:verify` in a staging job
      before flipping prod flags.
- [ ] Long tail + CDC schema/migration (phases 6–7).
- [ ] Polymorphic refs (notification rules, entity versions) need a
      discriminator column design when those tables are added.

---

## 10. Deployment

### 10.1 Provision Postgres (Neon)

1. Create a Neon project/database.
2. Enable extensions (the migrate runner also does this, but confirm the role can):
   `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`
3. TLS is auto-enabled for non-local hosts; no extra config needed (set
   `POSTGRES_SSL=false` only for a non-TLS local PG).

### 10.2 Secrets / env to add

Back up the Neon credentials in Google Secret Manager from your local `.env`:

```bash
# Optional when your active gcloud project is not the Mako project:
export GCP_SECRET_PROJECT_ID="<google-cloud-project-id>"
pnpm neon:secrets:push
```

Recover them on a new machine with:

```bash
pnpm neon:secrets:pull
```

Add these GitHub **environment** secrets to `production` and the preview/staging
environment used by PR deploys:

- `NEON_API_KEY`
- `NEON_ORG_ID`
- `NEON_PROJECT_ID`

Optional GitHub vars:

- `NEON_DATABASE_NAME` (defaults to `neondb`)
- `NEON_ROLE_NAME` (defaults to `neondb_owner`)
- `NEON_POOLED` (defaults to `true`)
- `POSTGRES_DUAL_WRITE`, `AUTH_PERSISTENCE`, `CONNECTIONS_PERSISTENCE`
  (default off / Mongo-backed reads)

`ENCRYPTION_KEY` already exists and **must be identical** to the one Mongo uses
(connection credentials are encrypted with it).

### 10.3 Wire into the GitHub Actions workflow

The real deploy path is `.github/workflows/deploy-app.yml` (not `deploy.sh`):

- PR previews run `node scripts/neon.mjs create-pr`, creating/reusing a
  `pr-<number>` Neon branch with a read-write compute and a generated pooled
  `POSTGRES_URL`.
- PR previews run `pnpm --filter api run db:migrate` against that branch before
  Cloud Run deploy.
- Production deploys on `master` resolve the Neon default branch connection with
  `node scripts/neon.mjs default-connection` and run Drizzle migrations before
  Cloud Run deploy.
- Cloud Run receives `POSTGRES_URL`, `POSTGRES_DUAL_WRITE`, `AUTH_PERSISTENCE`,
  and `CONNECTIONS_PERSISTENCE`.
- `.github/workflows/cleanup-preview.yml` deletes `pr-<number>` when the PR is
  closed/merged.

> Backfill is **not** part of the deploy step — it's a one-time/periodic data
> operation you run deliberately (§10.4), not on every push.

### 10.4 Safe rollout sequence (zero-downtime, reversible)

Do this when first introducing Postgres to an environment. Only backfill domains
that are cutover-ready; a successful full backfill is useful for schema
validation, but not production migration progress for domains without dual-write
and feature parity.

1. **Deploy code with all flags OFF.** Nothing changes at runtime. Confirm
   `GET /api/pg/health` returns `{ ok: true }` (proves connectivity).
2. **Run migrations:** `POSTGRES_URL=… pnpm --filter api run db:migrate`.
3. **Turn on dual-write for the domains that have it:** set
   `POSTGRES_DUAL_WRITE=true` and redeploy. Today this mirrors users,
   workspaces, workspace members, and database connections only.
4. **Backfill the clean foundation domains:**
   `BACKFILL_MONGO_URL=<source> POSTGRES_URL=<target> pnpm --filter api run db:backfill -- --domains=auth,workspaces,connections`.
   Prefer a Mongo **read replica**/snapshot as the source for prod.
5. **Verify parity:** `pnpm --filter api run db:verify --sample=200` → must be
   **0 mismatch / 0 missing** for the domains being flipped. Do not treat
   console/chat/query verification as a cutover gate until those domains have
   dual-write and read/write parity.
6. **Flip reads, one domain at a time:** set `AUTH_PERSISTENCE=postgres`, redeploy,
   watch; then `CONNECTIONS_PERSISTENCE=postgres`, redeploy, watch.
7. **Rollback** = set the flag back to `mongo` and redeploy (instant; both stores
   are in sync via dual-write).

Do **not** cut over consoles, chats, usage, query history, connectors, OAuth,
invites, or API keys from the current implementation. Those domains need the
missing work listed in §8–§9 first.

### 10.5 Deploying from your machine (manual)

`deploy.sh` is a local reference of the prod steps. To exercise the PG path
locally/manually without touching prod:

```bash
# point at a NON-prod Mongo + a Neon BRANCH (never PROD_DATABASE_URL as a target)
export DATABASE_URL="<staging mongo>"
export POSTGRES_URL="<neon branch url>"
export BACKFILL_MONGO_URL="$DATABASE_URL"
pnpm --filter api run db:migrate
pnpm --filter api run db:backfill -- --domains=auth,workspaces,connections
pnpm --filter api run db:verify --sample=200   # gate: must be clean
# then run the app with flags to smoke test
AUTH_PERSISTENCE=postgres CONNECTIONS_PERSISTENCE=postgres POSTGRES_DUAL_WRITE=true pnpm dev
```

### 10.6 "Won't break anything" checklist

- ✅ Flags default to Mongo; unset = no behavior change.
- ✅ App boots without `POSTGRES_URL` unless `AUTH_PERSISTENCE=postgres` (then it
  pings PG at startup and fails fast — so a misconfig is caught immediately, not
  silently).
- ✅ Dual-write is **best-effort** (logs, never throws) — a PG hiccup can't break a
  Mongo write. For cutover domains, repair drift with domain-specific upsert/
  reconciliation plus `db:verify`; the current insert-only backfill only fills
  missing rows.
- ✅ `db:migrate` and `db:backfill` are idempotent.
- ✅ Cutover is per-domain and instantly reversible via flags.
- ⚠️ `ENCRYPTION_KEY` must match across stores or connection credentials won't
  decrypt after cutover.
- ⚠️ Never point `db:backfill`/app `DATABASE_URL` writes at a prod target you
  don't intend to modify; backfill **writes** to `POSTGRES_URL`.

---

## 11. Gotchas / known issues

- **ID mapping:** ObjectIds → reversible padded uuids (`uuidToObjectId` recovers
  the hex, which is why `connection-store` can keep `_id` Mongo-shaped for the
  drivers). Legacy nanoid/`system`/`agent` ids → one-way UUIDv5 hash (stable, so
  references still line up, but not reversible).
- **Real data is heterogeneous:** some user `_id`s are nanoids, some creators are
  `system`/`agent`. That's why "creator/owner" columns have **no** user FK.
- **Embeddings** are skipped by the backfill for now (pgvector dimension/size);
  see TODO.
- **MUI X license** (frontend): unrelated to this migration, but the console
  results grid needs a valid `VITE_MUI_LICENSE_KEY` or it crashes on render.
- **CDC/sync** connection reads are intentionally still on Mongo and must be
  migrated **last**.
```
