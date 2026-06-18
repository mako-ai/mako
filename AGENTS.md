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

### Database: use the Atlas **dev** DB, not a local Mongo

Secrets are injected as real environment variables (see `CLOUD_AGENT_ALL_SECRET_NAMES`),
so you do NOT need a `.env` file and you do NOT need to run a local `mongod`.
Connection strings for `dev`, `staging`, and `prod` Atlas databases are all
injected.

- The injected `DATABASE_URL` points at **staging**. For development, start the
  app against the **dev** database instead, which is periodically restored from a
  prod snapshot (fast, with real prod-like data):

  ```bash
  export DATABASE_URL="$DEV_DATABASE_URL"
  pnpm dev
  ```

- `api/src/index.ts` loads the root `.env` with `dotenv.config()` **without
  `override`**, so injected/exported env vars always win over `.env`. That means
  the only reliable way to point the app at the dev DB is to export
  `DATABASE_URL` (a committed `.env` cannot override it).
- Never run the app against `PROD_DATABASE_URL`.

### Auto-seeded login (you are logged in out-of-the-box)

The dev DB is regularly restored from prod, which wipes ad-hoc test accounts. The
update script runs `api/src/scripts/seed-dev-admin.ts` on VM startup to
idempotently (re)create a known admin login so you can sign in to the running app
immediately:

- **Email:** `cloud-agent@mako.dev`
- **Password:** `CloudAgentDev!2024` (override via `DEV_ADMIN_PASSWORD`)

The seed marks the user verified, completes onboarding, makes it the **owner** of
a `Cloud Agent Dev` workspace, and attaches the `Chinook Music Store` demo
Postgres DB (`DEMO_DATABASE_URL`) so there is queryable data on first login. It
targets `DEV_DATABASE_URL` (falls back to `DATABASE_URL`), refuses to touch a
production URI, and soft-fails (exits 0) if the DB is unreachable — so it never
breaks VM startup. Re-run manually any time with:

```bash
pnpm --filter api exec tsx src/scripts/seed-dev-admin.ts
```

Email/password registration normally requires email verification before login
(SendGrid sends the code, which you won't receive). The seed sidesteps this by
setting `emailVerified: true` directly; if you create another account manually,
flip `emailVerified` in the DB to log in.

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
  here — rely on the injected Atlas DB instead.
- The Chinook demo Postgres uses lowercase, unquoted table names (`album`,
  `artist`, …); `SELECT * FROM "Artist"` fails, `SELECT * FROM artist` works.
- AI features need `AI_GATEWAY_API_KEY` (injected). `BILLING_ENABLED` is injected
  as `true`; raw SQL queries are not billing-gated.
