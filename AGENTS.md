# AGENTS.md

Canonical project rules live in `.cursor/rules/` and `CLAUDE.md` (commands, env,
tech stack, conventions). Read those first. This file adds context specific to
running Mako inside a Cursor Cloud agent VM.

## Cursor Cloud specific instructions

### Services & how to run them

Standard commands are documented in `README.md` / `CLAUDE.md` — don't duplicate
them. The core dev experience is one command:

- `pnpm dev` — runs the App (Vite, port `5173`), the API (Hono, port `8080`),
  and the Inngest dev server (port `8288`) concurrently. The Vite dev server
  proxies `/api` → `http://localhost:8080`.
- Lint/typecheck/build gates per package are in `.cursor/rules/85-pre-commit.mdc`
  (`pnpm --filter app run typecheck && lint`, `pnpm --filter api run lint`,
  `pnpm --filter api run build`).

The health check is `GET http://localhost:8080/health` (note: `/health`, not
`/api/health`).

### Databases run LOCALLY in this VM (no Atlas/cloud secrets injected)

Only `GITHUB_TOKEN` is injected here (`CLOUD_AGENT_ALL_SECRET_NAMES`); there are
no Atlas DB or AI-gateway secrets. The setup installed MongoDB 8.0 and
PostgreSQL 16 locally (persist in the VM snapshot) and config lives in a
gitignored root `.env` (also persisted in the snapshot — `api/src/index.ts`
loads it via `dotenv.config()`).

Both DB servers must be **started on each VM boot** (no systemd here); the update
script does NOT start them. Start them before `pnpm dev`:

```bash
# MongoDB — single-node replica set (the app uses transactions, which REQUIRE a
# replica set; a standalone mongod fails with "Transaction numbers are only
# allowed on a replica set member"). Config already has replSetName: rs0.
sudo mongod --config /etc/mongod.conf --bind_ip 127.0.0.1 &   # logs: /var/log/mongodb/mongod.log
# First boot only (idempotent thereafter — already initiated in this snapshot):
mongosh --quiet --eval 'try{rs.status()}catch(e){rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})}'

# PostgreSQL (demo data source)
sudo pg_ctlcluster 16 main start
```

`.env` points the app at these: `DATABASE_URL=mongodb://127.0.0.1:27017/mako` and
the demo source `DEMO_DATABASE_URL=postgresql://mako:mako@127.0.0.1:5432/demo`.

### Auto-seeded login (you are logged in out-of-the-box)

`api/src/scripts/seed-dev-admin.ts` idempotently creates a known admin login,
owning a `Cloud Agent Dev` workspace with the demo Postgres attached as the
`Chinook Music Store` connection. Run it once after Mongo is up (data then
persists in the snapshot; re-run any time it's missing):

```bash
pnpm --filter api exec tsx src/scripts/seed-dev-admin.ts
```

- **Email:** `cloud-agent@mako.dev`
- **Password:** `CloudAgentDev!2024` (override via `DEV_ADMIN_PASSWORD`)

It marks the user verified + onboarded, refuses any URI whose DB name is
`production`, and soft-fails (exits 0) if Mongo is unreachable. Email/password
registration normally requires SendGrid email verification (you won't receive the
code); the seed sidesteps this with `emailVerified: true`. If you create another
account manually, flip `emailVerified` in the DB to log in.

### Postgres metadata store (Drizzle) — in-progress Mongo → Postgres migration

A Drizzle ORM persistence layer (`api/src/db/`) is being introduced as the
migration target for Mako's own metadata (auth, workspaces, connections,
consoles, chats, queries). It runs **alongside** Mongo; both stores coexist
during the gradual cutover.

> **Full handoff doc & deploy runbook:** [`api/src/db/README.md`](api/src/db/README.md)
> — motivation, status table, per-domain cutover playbook, TODO, and the safe
> rollout/rollback sequence. Read it before continuing the migration or deploying.

- **Local Postgres** is not preinstalled on the VM. Install + start a cluster:
  ```bash
  sudo apt-get install -y postgresql postgresql-contrib postgresql-16-pgvector
  initdb -D "$HOME/pgdata" -U postgres --auth=trust   # /usr/lib/postgresql/16/bin
  pg_ctl -D "$HOME/pgdata" -o "-p 5432 -c unix_socket_directories=/tmp" start
  createdb -h 127.0.0.1 -U postgres mako_dev
  ```
- **Connection string:** `POSTGRES_URL` (falls back to `PG_DATABASE_URL`, then a
  local default `postgres://postgres@127.0.0.1:5432/mako_dev`). TLS auto-enables
  for non-local hosts. Neon is the target host; use `pnpm neon:local` to create
  a personal `local-<git user>` Neon branch and `pnpm neon:local:reset` to reset
  it from the default/prod Neon branch.
- **Neon secrets:** `NEON_API_KEY`, `NEON_ORG_ID`, and `NEON_PROJECT_ID` are
  backed up with `pnpm neon:secrets:push` and restored with
  `pnpm neon:secrets:pull`. CI creates `pr-<number>` Neon branches for previews,
  migrates them, and deletes them on PR cleanup.
- **Migrations (drizzle-kit):**
  ```bash
  pnpm --filter api run db:generate   # after editing src/db/schema/*
  pnpm --filter api run db:migrate    # apply (creates uuid-ossp + vector exts)
  ```
- **Backfill from Mongo:** `BACKFILL_MONGO_URL=$DEV_DATABASE_URL POSTGRES_URL=...
  pnpm --filter api exec tsx src/db/backfill.ts` (idempotent; dependency-ordered).
- **ID mapping:** ObjectIds map to reversible padded uuids; legacy nanoids /
  sentinels (`system`/`agent`) hash via UUIDv5 (`api/src/db/ids.ts`).
- **Auth/session cutover flag:** `AUTH_PERSISTENCE=postgres` switches the session
  store to Postgres (default `mongo`). Run the backfill first so users/sessions
  exist in PG.
- **PG-backed read API:** mounted at `/api/pg` (`/api/pg/health` is public).
- **PG tests:** `pnpm --filter api run test:pg` (needs a running Postgres).

### Misc caveats

- No `docker-compose.yml` is committed, so `pnpm docker:*` scripts don't work
  here — use the local Mongo/Postgres above instead.
- The demo Postgres (`demo` DB, role `mako`/`mako`) uses lowercase, unquoted
  table names (`artist`, `album`); `SELECT * FROM "Artist"` fails,
  `SELECT * FROM artist` works.
- AI features (AI query generation / chat) need `AI_GATEWAY_API_KEY`. It is now
  injected as a secret (also persisted in the gitignored `.env`), so AI works
  out of the box; on startup the API logs `Refreshed gateway models cache`. Core
  SQL-client flows (login, connections, console queries) work even without it.
  `BILLING_ENABLED=false` in `.env`, so nothing is billing-gated.

### Testing sync destinations

- Offline destination connector suite (driver dialect/write SQL, CDC MERGE
  builder, `DestinationWriter` orchestration): `pnpm --filter api run test:destinations`.
  Runs in `api-contract.yml`.
- Gated real-DB round-trips (testcontainers Postgres + goccy bigquery-emulator)
  self-skip unless `RUN_DB_INTEGRATION=1` (needs Docker); they run nightly via
  `destination-integration.yml`.
- Harness + helpers + local BigQuery emulator recipe:
  [`api/src/databases/test-support/README.md`](api/src/databases/test-support/README.md).
