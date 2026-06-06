# AGENTS.md

Guidance for cloud agents and automated development environments working in the Mako monorepo.

## Cursor Cloud specific instructions

### Product scope (default dev setup)

The primary product is **App + API** (AI-native SQL client). Full local dev also starts **Inngest dev** via `pnpm dev`. `website` and `docs` are optional standalone packages.

| Service | Port | Start |
| --- | --- | --- |
| MongoDB | 27017 | See MongoDB section below |
| API (Hono) | 8080 | `pnpm api:dev` or `pnpm dev` |
| App (Vite) | 5173 | `pnpm app:dev` or `pnpm dev` |
| Inngest dev UI | 8288 | Included in `pnpm dev` |

Standard commands are documented in [CLAUDE.md](CLAUDE.md) and [README.md](README.md).

### MongoDB (required, replica set)

`docker-compose.yml` is **not** in this repo. Start MongoDB with Docker directly:

```bash
sudo docker run -d -p 27017:27017 --name mongodb mongo:7 --replSet rs0
sudo docker exec mongodb mongosh --quiet --eval 'rs.initiate({_id:"rs0", members:[{_id:0, host:"localhost:27017"}]})'
```

**Replica set is required.** Workspace creation and other flows use MongoDB transactions; a standalone `mongod` without `--replSet` fails with: `Transaction numbers are only allowed on a replica set member or mongos`.

After a fresh MongoDB container, run `pnpm migrate` (see migration caveat below).

### Docker daemon

Docker CE is installed on the VM image but **dockerd is not managed by systemd** in this environment. Start it once per VM session before using Docker:

```bash
sudo dockerd > /tmp/dockerd.log 2>&1 &
```

Use `sudo docker …` if the current user is not in the `docker` group.

### Environment file

Copy `.env.example` to `.env` and set at minimum:

- `DATABASE_URL=mongodb://localhost:27017/myapp`
- `ENCRYPTION_KEY` — `openssl rand -hex 32`
- `SESSION_SECRET` — `openssl rand -hex 32`
- `AI_GATEWAY_API_KEY` — required for AI chat; placeholder allows boot but AI calls fail

OAuth (`GOOGLE_*`, `GH_*`) and SendGrid are optional for local dev. Without SendGrid, verification emails are logged server-side; fetch codes from `emailverifications` in MongoDB or use `/api/dev/email-preview` routes.

### pnpm native build scripts

On a clean `pnpm install`, approve dependency build scripts once:

```bash
pnpm approve-builds --all
```

`bcrypt` is intentionally in `ignoredBuiltDependencies` in `pnpm-workspace.yaml`.

### Migrations

`pnpm migrate` applies pending migrations. On a fresh database, migration `2026-04-05-075746_add_entity_versions_collection` may fail with `ns does not exist: myapp.entity_versions` (18/29 still apply). Core auth and workspace flows work despite this failure.

### Running dev servers

Use a tmux session so API, App, and Inngest stay up:

```bash
pnpm dev
```

Health checks:

- API: `curl http://localhost:8080/health`
- App: `curl -o /dev/null -w '%{http_code}' http://localhost:5173/`
- Inngest: `curl http://localhost:8288/health`

### Lint and tests

| Package | Command |
| --- | --- |
| API lint | `pnpm --filter api run lint` |
| App lint + typecheck | `pnpm --filter app run lint && pnpm --filter app run typecheck` |
| App unit tests | `pnpm --filter app run test:unit` |
| All lint | `pnpm run lint:all` |

Pre-commit hooks (`husky` + `lint-staged`) only lint **staged** files; run full package lint before PRs (see `.cursor/rules/85-pre-commit.mdc`).

### Inngest in development

Cron schedulers are disabled when `NODE_ENV !== "production"`. Trigger jobs manually from the Inngest UI at http://localhost:8288. See [INNGEST_DEV_CONFIG.md](INNGEST_DEV_CONFIG.md).
