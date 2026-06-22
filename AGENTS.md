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

### Misc caveats

- No `docker-compose.yml` is committed, so `pnpm docker:*` scripts don't work
  here — rely on the injected Atlas DB instead.
- The Chinook demo Postgres uses lowercase, unquoted table names (`album`,
  `artist`, …); `SELECT * FROM "Artist"` fails, `SELECT * FROM artist` works.
- AI features need `AI_GATEWAY_API_KEY` (injected). `BILLING_ENABLED` is injected
  as `true`; raw SQL queries are not billing-gated.
