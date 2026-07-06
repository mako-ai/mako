# Mako Postgres Migration (Drizzle) — Handoff & Runbook

> **Status:** in progress. Mongo (Mongoose) is still the **system of record**.
> The strategy is a **big-bang cutover per domain**: freeze writes → run the
> convergent backfill (`db:backfill --prune`) → pass the drift gate
> (`db:verify`) → flip the domain's persistence flag. There is **no
> general dual-write layer** (it was removed — see §7); only two narrow
> transitional mirrors exist for the domains whose reads are already flipped.
> CDC/sync is migrated last.
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

The migration is executed as a sequence of **per-domain big-bang flips** inside
short freeze windows. We deliberately do NOT maintain a long-lived dual-write
phase: keeping every Mongoose write path (`save`, `updateOne`,
`findOneAndUpdate`, `deleteOne`, transactions…) mirrored to a second store is
where migrations rot — hooks silently miss paths, and hooks that fire inside
Mongo transactions before commit can leak rolled-back writes into Postgres.
Instead the backfill is convergent (upsert + prune) and cheap to re-run, so the
cutover window is: freeze, converge, verify, flip.

---

## 2. Current status

| Domain | PG schema | Repository | Backfill | Transitional mirror (Mongo→PG) | Reads cut over |
|---|---|---|---|---|---|
| **auth – users** | ✅ | ✅ | ✅ | ✅ post-save, only while `AUTH_PERSISTENCE=postgres` | partial: session validation only |
| **auth – sessions** | ✅ | ✅ | ✅ | n/a (PG-authoritative when flag on) | ✅ (`AUTH_PERSISTENCE=postgres`) |
| auth – oauth/email-verif | ✅ | partial | ✅ | ❌ (backfill only) | ❌ |
| auth – desktop codes | ✅ | ❌ | ❌ | ❌ | ❌ |
| **workspaces + members** | ✅ | ✅ (members only) | ✅ | ❌ (backfill only — no PG read path needs them live) | ❌ (reads still Mongo) |
| workspace invites / api keys | ✅ | partial | ✅ | ❌ | ❌ |
| **connections (`database_connections`)** | ✅ | ✅ | ✅ | ✅ post-save + delete-route mirror, only while `CONNECTIONS_PERSISTENCE=postgres` | ✅ for query execution (`CONNECTIONS_PERSISTENCE=postgres`) |
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

Treat a domain as clean only when it has **schema + convergent backfill + a live
read seam/flag + (until its writes are native) a mirror covering every Mongo
write AND delete path**. A table plus a successful backfill is not enough.

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
  dual-write.ts          TWO transitional mirrors only (users, connections) — no blanket dual-write
  backfill.ts            convergent ETL Mongo→PG: upsert + optional --prune (db:backfill)
  verify.ts              Mongo↔PG drift gate: random sample + count drift (db:verify)
  connection-store.ts    read seam for connections (Mongo|Postgres) used by query execution
  repositories.test.ts / persistence.routes.test.ts   integration + OpenAPI e2e (test:pg)

api/src/auth/
  session-store.ts       read/write seam for sessions (Mongo|Postgres)
  session.ts             SessionManager delegates to the session store

api/src/routes/
  pg-persistence.routes.ts   @hono/zod-openapi read API mounted at /api/pg

api/drizzle.config.ts    drizzle-kit config (schema, out dir, dbCredentials)
```

Transitional mirror hooks live in `database/schema.ts` (User post-save, active
only under `AUTH_PERSISTENCE=postgres`) and `database/workspace-schema.ts`
(DatabaseConnection post-save, active only under
`CONNECTIONS_PERSISTENCE=postgres`; the delete route mirrors deletes
explicitly). They exist because those domains' READS are flipped while their
WRITES still land in Mongo, and they are deleted the moment each domain's
writes move natively to Postgres.

`api/src/inngest/functions/pg-ttl-cleanup.ts` replaces the Mongo TTL indexes
(sessions, email verifications, desktop auth codes, 90-day query executions)
with a half-hourly cron; it no-ops unless a Postgres persistence flag is set.

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
| `AUTH_PERSISTENCE` | `mongo` | `postgres` → sessions read/write from PG (enables the user mirror) + startup ping |
| `CONNECTIONS_PERSISTENCE` | `mongo` | `postgres` → query execution resolves connections from PG (enables the connection mirror) + startup ping |
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
(default = all, in dependency order) and `--prune`. `db:verify` accepts
`--sample=N`.

Backfill semantics (convergent — this is the big-bang cutover tool):

- Every row is **upserted** (`onConflictDoUpdate` on the primary key, or the
  natural key for `workspace_members`): re-running the backfill overwrites
  stale Postgres rows with the current Mongo values, so drift accumulated
  since the previous run is repaired, not skipped.
- With `--prune`, rows whose Mongo source document no longer exists are
  **deleted** from Postgres (FK `cascade`/`set null` rules handle dependents),
  making the run a full reconciliation. Use `--prune` for the authoritative
  freeze-window run; note that pruning a parent domain (e.g. `workspaces`)
  cascades to children, so prefer full-domain runs when pruning.
- `db:verify` fails (non-zero exit) on any sampled mismatch/missing row **or on
  a total row-count divergence** (sessions exempt from the count gate — they
  are ephemeral and by design live only in the flag-selected store). Samples
  are drawn randomly (`$sample`), not first-N.

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
pnpm --filter api run db:backfill -- --prune
pnpm --filter api run db:verify -- --sample=100   # must exit 0

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

## 7. Per-domain big-bang cutover playbook

Repeat this loop for each domain. Never skip the verify step.

1. **Seam** — route ALL of the domain's reads **and writes** through a
   store/repository so call sites stop importing the Mongoose model directly
   (pattern: `*-store.ts`). The seam must cover every mutation path —
   `updateOne`, `findOneAndUpdate`, deletes, transactional writes — not just
   `save()`.
2. **Freeze** — short maintenance window (or accept losing the tail for
   low-value domains like query history).
3. **Converge** — `db:backfill --domains=<domain> --prune`.
4. **Verify** — `db:verify` must exit 0 (random-sample parity AND count
   parity). This is the go/no-go gate.
5. **Flip** — set the domain flag to `postgres` and deploy. From this moment
   the domain's reads AND writes are Postgres-only; Mongo stops receiving
   writes for it.
6. **Decommission** — after a soak period, drop the Mongoose model usages and
   the Mongo collection.

**Rollback caveat (the price of big-bang):** after the flip, Mongo goes stale
immediately. Rolling back = reverse-syncing whatever was written to Postgres
during the soak, or accepting that window's loss. That is why step 4 is a hard
gate and why flips are per-domain rather than all-at-once.

**Why the general dual-write layer was removed:** the original
`POSTGRES_DUAL_WRITE` implementation hooked only `post('save')` — it silently
missed every `updateOne`/`findOneAndUpdate`/`deleteOne`/`bulkWrite` path (most
workspace mutations, member role changes, all deletes) and fired inside Mongo
transactions **before commit**, so an aborted transaction could leave phantom
rows in Postgres. A mirror that is only mostly right is worse than none: it
makes `db:verify` lie. The two remaining mirrors (users under
`AUTH_PERSISTENCE=postgres`, connections under
`CONNECTIONS_PERSISTENCE=postgres`) exist only because those domains' reads
are already flipped while their writes are still Mongo-native, their write
surfaces are narrow enough to cover completely (auth user writes all go
through `save()`/`create()`; connections have one delete route, mirrored
explicitly), and they are deleted when the domains' writes go native.

---

## 8. Roadmap

- **Phase 1 (done):** schema + migrations + id mapping + repositories +
  convergent backfill (upsert/prune) + hardened verify gate; session store
  read/write seam; connection resolution read seam for query execution; the two
  transitional mirrors; TTL-replacement cron; `/api/pg` read API; Neon branch
  automation (create/reset/delete per PR).
- **Phase 2 (safe foundation cutover):** enable and harden only the domains that
  are already dependency-complete: `AUTH_PERSISTENCE=postgres` for sessions and
  `CONNECTIONS_PERSISTENCE=postgres` for query execution. Route remaining
  non-CDC `DatabaseConnection.findById` reads through `connection-store`.
- **Phase 3 (complete auth + tenancy):** write-seams for users/OAuth/email
  verifications/desktop codes and workspaces/members/invites/API keys, then
  freeze → converge → verify → flip those domains; decouple API-key auth from
  embedded `Workspace.apiKeys`; port the Mongo transactions in
  `workspace.service.ts` to Drizzle transactions. Deleting the user mirror is
  the exit criterion for auth.
- **Phase 4 (consoles + versions):** add SQL `entity_versions`, preserve
  `version` + `draftRevision` write guards, backfill `description_embedding`,
  then flip consoles (reads AND writes) in one window.
- **Phase 5 (chats + usage + query history):** write-seams, then flip. Query
  history can flip without a freeze (append-only audit data; losing seconds of
  tail is acceptable).
- **Phase 6:** model + migrate the long tail (dashboards, apps, skills, dbt,
  notifications, realtime presence, model catalog).
- **Phase 7 (last):** sync/CDC (`cdc_*`, webhook events, flow executions) — the
  bulk of the write volume; needs a partition/retention design first.

---

## 9. TODO (actionable, what remains)

- [x] Convergent backfill (upsert on PK/natural key) + `--prune` reconciliation.
- [x] Hardened `db:verify`: random sampling, count-drift gate, tenant-mapping
      + extended field-parity checks.
- [x] Field-parity fixes: `query_executions.executed_at`/`database_name`/
      `bytes_scanned`/`error_type`; `llm_usage.model_id`/`cache_read_tokens`/
      `cache_write_tokens`/numeric `cost_usd` (migration `0001`).
- [x] TTL replacement cron (`pg-ttl-cleanup`): sessions, email verifications,
      desktop auth codes, 90-day query executions.
- [x] Startup fail-fast pings PG when **any** persistence flag is set (was
      auth-only).
- [x] Connection delete mirrored to PG (was a stale-credential hole under
      `CONNECTIONS_PERSISTENCE=postgres`).
- [ ] **Next:** route all remaining non-CDC `DatabaseConnection.find*` reads
      through `connection-store` (dbt, dashboards, apps, flows — **excluding**
      sync/CDC), then verify `CONNECTIONS_PERSISTENCE=postgres` covers every
      normal app query path.
- [ ] Add a focused CI/staging drift gate for the clean foundation domains:
      `auth,workspaces,connections`.
- [ ] Complete API key migration before broader workspace cutover: repository +
      write seam for create/revoke/last-used, and API-key auth reads from
      `workspace_api_keys` instead of embedded Mongo `Workspace.apiKeys`.
- [ ] Write seams for consoles, chats, queries; then flip the live routes
      (`routes/consoles.ts`, `routes/chats.ts`, `agent-thread.service.ts`,
      `query-execution.service.ts`) per the §7 playbook.
- [ ] Add PG `entity_versions` before any console version/history cutover.
- [ ] Backfill + repository + read seam for `desktop_auth_codes`.
- [ ] Repositories for `Connector`, oauth/email-verification/invites/api-keys
      (CRUD).
- [ ] Embeddings: backfill `saved_consoles.description_embedding` (skipped today)
      and move console semantic search to pgvector `<=>`.
- [ ] Drizzle transactions for the multi-table writes currently using Mongo
      transactions (workspace create + member + session in `workspace.service.ts`).
- [ ] Fuller auth cutover: read users from PG in `AuthService.login`/OAuth (today
      the password check still reads the Mongo user; sessions + user mirror are
      PG). Exit criterion: delete `mirrorUser`.
- [ ] Consolidate the `databaseConnectionService.getMainConnection()` native-Mongo
      bypass sites (migrations, embeddings, some sync) as their domains migrate.
- [ ] CI: add `drizzle-kit check` drift gate and run `db:verify` in a staging job
      before flipping prod flags.
- [ ] Long tail + CDC schema/migration (phases 6–7); CDC needs a
      partition/retention design first (`cdc_change_events`, `webhookevents`,
      `flow_executions` dominate write volume).
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
- `AUTH_PERSISTENCE`, `CONNECTIONS_PERSISTENCE` (default Mongo-backed)

> The `NEON_*` secrets must be visible to the per-PR `pr-<number>` GitHub
> environments — set them as **repository-level** secrets (per-PR environments
> are created dynamically and cannot each hold a copy).

`ENCRYPTION_KEY` already exists and **must be identical** to the one Mongo uses
(connection credentials are encrypted with it).

### 10.3 Wire into the GitHub Actions workflow

The real deploy path is `.github/workflows/deploy-app.yml` (not `deploy.sh`):

- PR previews run `node scripts/neon.mjs create-pr`, creating/reusing a
  `pr-<number>` Neon branch with a read-write compute and a generated pooled
  `POSTGRES_URL`. A manual `workflow_dispatch` with `rebuild_db=true` runs
  `reset-pr` instead, restoring the branch from the Neon default branch (schema
  AND data) — the Postgres analog of the Mongo ephemeral-DB rebuild.
- PR previews run `pnpm --filter api run db:migrate` against that branch before
  Cloud Run deploy.
- Production deploys on `master` resolve the Neon default branch connection with
  `node scripts/neon.mjs default-connection` and run Drizzle migrations before
  Cloud Run deploy.
- Cloud Run receives `POSTGRES_URL`, `AUTH_PERSISTENCE`, and
  `CONNECTIONS_PERSISTENCE`.
- `.github/workflows/cleanup-preview.yml` deletes `pr-<number>` when the PR is
  closed/merged and reports the real delete outcome in the cleanup comment;
  branches also carry a 30-day `expires_at` as a safety net for failed
  cleanups.

> Backfill is **not** part of the deploy step — it's a one-time/periodic data
> operation you run deliberately (§10.4), not on every push.

### 10.4 Big-bang rollout sequence (freeze → converge → verify → flip)

Do this when first introducing Postgres to an environment. Only flip domains
that are cutover-ready (§2.1); a successful full backfill is useful for schema
validation, but not production migration progress for domains without complete
seams.

1. **Deploy code with all flags OFF.** Nothing changes at runtime. Confirm
   `GET /api/pg/health` returns `{ ok: true }` (proves connectivity).
2. **Run migrations:** `POSTGRES_URL=… pnpm --filter api run db:migrate`
   (CI already does this on every deploy).
3. **Freeze writes** for the domains being flipped (maintenance window — for
   auth+connections this is minutes, not hours).
4. **Converge:**
   `BACKFILL_MONGO_URL=<source> POSTGRES_URL=<target> pnpm --filter api run db:backfill -- --prune`.
   Re-runnable; each run upserts changes and prunes deletes.
5. **Verify parity:** `pnpm --filter api run db:verify -- --sample=200` →
   **must exit 0** (sampled parity AND count parity). This is the go/no-go gate.
6. **Flip:** set `AUTH_PERSISTENCE=postgres` and
   `CONNECTIONS_PERSISTENCE=postgres`, redeploy, unfreeze, watch. The
   transitional mirrors keep PG current for these two domains' Mongo-native
   writes.
7. **Rollback window:** while the mirrors are in place, Mongo remains current
   for these two domains (sessions excepted — users re-login), so flipping the
   flags back is still safe. Once a domain's writes go native (mirror deleted),
   rollback requires a reverse sync — that's the accepted big-bang trade-off.

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
- ✅ App boots without `POSTGRES_URL` unless a persistence flag is `postgres`
  (then it pings PG at startup and fails fast — so a misconfig is caught
  immediately, not silently).
- ✅ The transitional mirrors are **best-effort** (logs, never throws) — a PG
  hiccup can't break a Mongo write; `db:backfill --prune` converges any drift.
- ✅ `db:migrate` is idempotent; `db:backfill` is convergent (safe to re-run,
  repairs drift).
- ✅ Cutover is per-domain; reversible while the domain's mirror is in place.
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
