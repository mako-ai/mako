# AGENTS.md

## Cursor Cloud specific instructions

### Services overview

| Service | Port | Start command |
|---------|------|---------------|
| API (Hono + Node.js) | 8080 | `pnpm api:dev` |
| App (Vite + React) | 5173 | `pnpm app:dev` |
| Both + Inngest | — | `pnpm dev` |
| MongoDB | 27017 | See below |

Standard dev commands (`pnpm dev`, `pnpm lint:all`, `pnpm test`, `pnpm build`) are documented in `CLAUDE.md` and `README.md`.

### MongoDB setup

MongoDB **must** run as a replica set (the workspace service uses transactions). Start it with:

```bash
sudo dockerd &>/tmp/dockerd.log &
sleep 3
sudo docker start mongodb 2>/dev/null || \
  sudo docker run -d --name mongodb -p 27017:27017 mongo:7 --replSet rs0
sleep 2
sudo docker exec mongodb mongosh --quiet --eval "try { rs.status() } catch(e) { rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]}) }"
```

### Environment file

Copy `.env.example` to `.env` and set at minimum: `DATABASE_URL`, `ENCRYPTION_KEY` (64 hex chars via `openssl rand -hex 32`), `SESSION_SECRET`, `WEB_API_PORT=8080`, `BASE_URL=http://localhost:8080`, `CLIENT_URL=http://localhost:5173`.

### Email verification in dev

Without SendGrid configured, email verification codes can be read directly from MongoDB:

```bash
sudo docker exec mongodb mongosh --quiet --eval \
  "db = db.getSiblingDB('mako'); db.emailverifications.findOne({email: '<EMAIL>'}, {code: 1, _id: 0})"
```

### Build scripts (pnpm v10)

The `pnpm-workspace.yaml` has `onlyBuiltDependencies` allowing esbuild, sqlite3, sharp, protobufjs, es5-ext, @mui/x-telemetry, and workerd to run their postinstall scripts. Without these, Vite and tsx will fail because esbuild binaries won't be available.

### Gotchas

- The `pnpm dev` command also starts `inngest-cli` via `pnpm dlx`; if Inngest isn't needed, use `pnpm api:dev` + `pnpm app:dev` separately.
- The Vite dev server proxies `/api` to `http://localhost:8080` — start the API first or in parallel.
- Lint produces warnings (no-non-null-assertion) but zero errors; this is expected.
