# GitHub App — PR preview + production

Mako uses **one** product GitHub App:

| App | Used by | Where creds live |
| --- | --- | --- |
| **Mako** (`mako`, https://github.com/apps/mako, private) | Production, PR previews, and local | GitHub Actions `MAKO_GITHUB_APP_*` vars/secrets → Cloud Run `GITHUB_APP_*` |

The public **Mako Transforms** apps (production and DEV) are retired. Org owners still need to rotate prod/preview secrets onto the Mako app and uninstall those two apps — this repo can only change code and docs.

The deploy workflow's `deploy-production` job runs under `environment: production`,
so environment-scoped `MAKO_GITHUB_APP_*` override the repo-level ones. To (re)create or rotate the Mako app:

```bash
# Owner picked during the GitHub create step; creds written to a gitignored JSON.
BASE_URL=https://app.mako.ai CLIENT_URL=https://app.mako.ai \
GITHUB_APP_NAME="Mako" GITHUB_APP_ORG=<org-or-omit-for-personal> \
GITHUB_APP_OUTPUT_JSON=.secrets/prod-github-app.json \
node scripts/register-github-app.mjs
# then set the production-environment vars/secrets from that JSON:
#   gh variable set MAKO_GITHUB_APP_{ID,SLUG,CLIENT_ID} --env production --repo mako-ai/mako ...
#   gh secret   set MAKO_GITHUB_APP_{CLIENT_SECRET,WEBHOOK_SECRET,PRIVATE_KEY} --env production --repo mako-ai/mako ...
```

The manifest already enables *Request user authorization (OAuth) during
installation*, sets the Callback URL to `/api/github/setup`, and marks the app
public — no manual GitHub-UI steps needed for a manifest-created app.

## 1. Repo secrets and variables (dev app — PR previews + local)

```bash
# From mono-dbt-polish root (private key at .secrets/github-app.pem)
gh secret set MAKO_GITHUB_APP_PRIVATE_KEY --body "$(cat .secrets/github-app.pem | awk '{printf "%s\\n", $0}')"
gh secret set MAKO_GITHUB_APP_WEBHOOK_SECRET --body "your-webhook-secret"
# OAuth client used to verify the installing user controls the installation
# (required — without it /api/github/setup refuses to bind, anti-IDOR).
gh secret set MAKO_GITHUB_APP_CLIENT_SECRET --body "your-app-client-secret"
gh variable set MAKO_GITHUB_APP_ID --body <mako-app-id>
gh variable set MAKO_GITHUB_APP_SLUG --body mako
gh variable set MAKO_GITHUB_APP_CLIENT_ID --body Iv1.xxxxxxxxxxxxxxxx
```

`deploy-app.yml` passes these to Cloud Run for **PR previews** and **production**.

## 2. GitHub App settings (github.com → Settings → Developer settings → GitHub Apps)

| Field | Production value |
| --- | --- |
| Homepage URL | `https://app.mako.ai` |
| Callback URL (App OAuth) | `https://app.mako.ai/api/github/setup` |
| **Request user authorization (OAuth) during installation** | ✅ **enabled** (required — delivers the `code` `/setup` uses to verify ownership) |
| Setup URL | `https://app.mako.ai/api/github/setup` |
| Webhook URL | `https://app.mako.ai/api/github/webhook` |
| Webhook secret | same as `GITHUB_APP_WEBHOOK_SECRET` |
| Logo | upload `.secrets/github-app-icon.png` (Mako icon) |

> When *Request user authorization during installation* is on, GitHub makes the Setup URL unavailable and redirects through the **Callback URL** with both `code` and `installation_id` — so the App's Callback URL must point at `/api/github/setup`. Grab the **Client ID** and a generated **Client secret** from the App's General page for `MAKO_GITHUB_APP_CLIENT_ID` / `MAKO_GITHUB_APP_CLIENT_SECRET`.

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
GITHUB_APP_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
GITHUB_APP_CLIENT_SECRET=...

pnpm configure:github-app   # writes GITHUB_APP_* from .secrets/github-app.pem
```

`pnpm register:github-app` (manifest flow) captures `GITHUB_APP_CLIENT_ID` /
`GITHUB_APP_CLIENT_SECRET` automatically and enables OAuth-on-install. For an
existing App, copy them from the App's General page and enable *Request user
authorization (OAuth) during installation* manually.

For local install callback, either point GitHub App setup URL at a tunnel, or seed `github_installations` manually after installing on github.com.

## 5. App icon

Static assets in `app/public/`:

- `mako-icon.png`, `favicon.png`, `apple-touch-icon.png`
- `android-chrome-192x192.png`, `android-chrome-512x512.png`
- `manifest.json` references these

Used in browser tab, PWA manifest, auth layout, and workspace selector.
