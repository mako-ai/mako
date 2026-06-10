# AGENTS.md

Guidance for cloud agents working in this repository.

## Cursor Cloud specific instructions

### MongoDB (no Docker Compose in repo)

`pnpm docker:up` runs `docker compose up -d`, but there is **no `docker-compose.yml`** in this repo. Docker may also be unavailable in the cloud VM.

Start MongoDB manually instead:

```bash
sudo mkdir -p /data/db && sudo chown $(whoami) /data/db
mongod --dbpath /data/db --bind_ip 127.0.0.1 --port 27017 --fork --logpath /tmp/mongod.log
```

MongoDB 7.x can be installed from the official apt repo (Ubuntu jammy target works on noble).

### Environment file

Copy `.env.example` to `.env` and set at minimum:

- `DATABASE_URL=mongodb://localhost:27017/mako`
- `ENCRYPTION_KEY` and `SESSION_SECRET` (generate with `openssl rand -hex 32`)

### Migrations on fresh databases

Some migrations call `listIndexes()` on collections that do not exist yet on a brand-new database, which causes `ns does not exist` errors. If `pnpm migrate` fails with that error, create the missing empty collection and re-run:

```bash
mongosh mako --eval 'db.createCollection("entity_versions")'
mongosh mako --eval 'db.createCollection("webhookevents")'
pnpm migrate
```

### pnpm native build scripts

After `pnpm install`, approve native builds so Vite/esbuild work:

```bash
pnpm config set onlyBuiltDependencies '["esbuild","sharp","@mui/x-telemetry","core-js","cpu-features","es5-ext","protobufjs","sqlite3","ssh2","workerd"]'
pnpm rebuild esbuild sharp
```

### Dev stack

| Service | Port | Start |
| --- | --- | --- |
| MongoDB | 27017 | manual `mongod` (see above) |
| API | 8080 | `pnpm api:dev` or `pnpm dev` |
| App (Vite) | 5173 | `pnpm app:dev` or `pnpm dev` |
| Inngest dev | 8288 | included in `pnpm dev` |

`pnpm dev` starts API + App + Inngest concurrently. Use a tmux session for long-running dev servers.

After MongoDB is up: `pnpm migrate` then `pnpm dev`.

### Email verification in dev

Without SendGrid, verification codes are not emailed. Read the code from MongoDB:

```bash
mongosh mako --quiet --eval 'db.emailverifications.findOne({email:"you@example.com"}).code'
```

### Lint / test gates

See `.cursor/rules/85-pre-commit.mdc`. Before committing:

- `pnpm run lint:all`
- `pnpm --filter app run typecheck` (if you touched `app/`)
- `pnpm --filter app run test:unit` for frontend unit tests

### Optional features

- `AI_GATEWAY_API_KEY` — required for AI chat/agent features
- `DEMO_DATABASE_URL` — Chinook demo PostgreSQL for onboarding SQL demos
- OAuth keys — Google/GitHub login
