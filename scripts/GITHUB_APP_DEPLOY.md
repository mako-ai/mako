# GitHub App — PR preview + production

Mako Transforms uses one **Mako-owned GitHub App** (`GITHUB_APP_*`). Workspaces install it on their org/user account.

## 1. Repo secrets and variables

```bash
# From mono-dbt-polish root (private key at .secrets/github-app.pem)
gh secret set MAKO_GITHUB_APP_PRIVATE_KEY --body "$(cat .secrets/github-app.pem | awk '{printf "%s\\n", $0}')"
gh secret set MAKO_GITHUB_APP_WEBHOOK_SECRET --body "your-webhook-secret"
gh variable set MAKO_GITHUB_APP_ID --body 4093709
gh variable set MAKO_GITHUB_APP_SLUG --body mako-transforms-jonas-dev
```

`deploy-app.yml` passes these to Cloud Run for **PR previews** and **production**.

## 2. GitHub App settings (github.com → Settings → Developer settings → GitHub Apps)

| Field | Production value |
| --- | --- |
| Homepage URL | `https://app.mako.ai` |
| Callback URL (OAuth — login, separate) | unchanged |
| Setup URL | `https://app.mako.ai/api/github/setup` |
| Webhook URL | `https://app.mako.ai/api/github/webhook` |
| Webhook secret | same as `GITHUB_APP_WEBHOOK_SECRET` |
| Logo | upload `.secrets/github-app-icon.png` (Mako icon) |

**Visibility:** set to **Any account** for multi-tenant SaaS.

GitHub allows only **one** webhook + setup URL per app. PR previews use the same app; install `state` includes `clientUrl` so `/api/github/setup` redirects back to the PR origin (`pr-N.mako.ai`).

## 3. PR preview flow

1. User opens `https://pr-N.mako.ai` → Connect GitHub.
2. API returns install URL with `state={"workspaceId","clientUrl":"https://pr-N.mako.ai"}`.
3. After install, GitHub hits `https://app.mako.ai/api/github/setup` (prod API).
4. API records installation and redirects to `https://pr-N.mako.ai/?transformGithub=connected`.

Requires user session on prod API during setup (cookie on `app.mako.ai`). If cookie missing, user is sent to login on the PR origin.

## 4. Local dev

```bash
# .env
BASE_URL=http://localhost:8090
CLIENT_URL=http://localhost:5173
GITHUB_APP_ID=...
GITHUB_APP_SLUG=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN..."
GITHUB_APP_WEBHOOK_SECRET=...

pnpm configure:github-app   # writes GITHUB_APP_* from .secrets/github-app.pem
```

For local install callback, either point GitHub App setup URL at a tunnel, or seed `github_installations` manually after installing on github.com.

## 5. App icon

Static assets in `app/public/`:

- `mako-icon.png`, `favicon.png`, `apple-touch-icon.png`
- `android-chrome-192x192.png`, `android-chrome-512x512.png`
- `manifest.json` references these

Used in browser tab, PWA manifest, auth layout, and workspace selector.
