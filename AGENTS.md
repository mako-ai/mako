# AGENTS.md

Guidance for AI agents working in the Mako monorepo.

## Cursor Cloud specific instructions

### Dependency install (runs before verification)

Cloud agents run the `install` script from [`.cursor/environment.json`](.cursor/environment.json) on every VM startup (after `git pull`). It must finish before lint/build verification:

```bash
pnpm install
pnpm --filter @mako/schemas run build
pnpm --filter @mako/agent-tools run build
```

`pnpm install` alone is **not sufficient** for `pnpm --filter api run build` — the API depends on compiled `@mako/agent-tools` (`dist/`), and the api build script only recompiles `@mako/schemas`.

After the install script completes, these should work immediately (no MongoDB required):

```bash
pnpm --filter api run lint
pnpm --filter api run build
```

### Services (core product)

| Service | Port | Notes |
| --- | --- | --- |
| MongoDB | 27017 | **Required.** App metadata DB (`DATABASE_URL`). Must run as a **replica set** — workspace creation uses transactions and fails on standalone MongoDB. |
| API (Hono) | 8080 | `pnpm api:dev` or included in `pnpm dev` |
| App (Vite/React) | 5173 | Proxies `/api` → `http://localhost:8080`. `pnpm app:dev` or `pnpm dev` |
| Inngest dev | 8288 | Started by `pnpm dev`; optional for login/console, required for sync/flows |

`docker-compose.yml` is referenced in scripts but **not present** in this repo. Start MongoDB manually (see below).

### MongoDB (manual start)

This VM has no systemd. Start MongoDB as a single-node replica set:

```bash
sudo mkdir -p /data/db && sudo chown mongodb:mongodb /data/db
sudo -u mongodb mongod --dbpath /data/db --bind_ip 127.0.0.1 --port 27017 \
  --replSet rs0 --fork --logpath /tmp/mongod.log
mongosh --quiet --eval 'try { rs.status() } catch(e) { rs.initiate({_id:"rs0", members:[{_id:0, host:"127.0.0.1:27017"}]}) }'
```

### Environment file

Copy `.env.example` → `.env` and set at minimum:

- `DATABASE_URL=mongodb://localhost:27017/mako`
- `ENCRYPTION_KEY` — `openssl rand -hex 32`
- `SESSION_SECRET` — random string
- `WEB_API_PORT=8080`, `BASE_URL`, `CLIENT_URL`, `PUBLIC_URL`, `NODE_ENV=development`

Optional: `AI_GATEWAY_API_KEY` (AI chat), `DEMO_DATABASE_URL` (Chinook demo onboarding), OAuth/SendGrid keys.

### First-time database setup

```bash
pnpm migrate
```

On a **fresh** database, two migrations may fail because they call `listIndexes()` / `indexes()` on collections that do not exist yet (`entity_versions`, `webhookevents`). Create empty collections and re-run:

```bash
mongosh --quiet mako --eval 'db.createCollection("entity_versions"); db.createCollection("webhookevents")'
pnpm migrate
```

### Dev commands

See `CLAUDE.md` and `README.md` for the full command list. Common ones:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | API + App + Inngest (use tmux for long-running) |
| `pnpm migrate` / `pnpm migrate status` | Database migrations |
| `pnpm --filter app run test:unit` | Frontend unit tests (Vitest) |
| `pnpm lint:all` | Lint app + api + connector check |

Email verification codes are logged to API stdout when `SENDGRID_API_KEY` is unset; or read from `db.emailverifications` in MongoDB.

### Lint / typecheck before PR

Per `.cursor/rules/85-pre-commit.mdc`: run full package lint (and app typecheck) for every touched package — the husky hook only lints staged files.
