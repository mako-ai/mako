# GitHub App — all environments

Mako uses **one GitHub App in every environment**: **Mako AI** (`mako-ai`,
App ID `4106865`, public). Workspace bindings persist a GitHub installation
id, and those ids belong to one App. PR databases are copied from production,
so using a different App in previews makes every token mint return 404 and all
git-backed workspace content disappear.

The canonical `MAKO_GITHUB_APP_*` variables and secrets live at GitHub
**repository scope** so production, PR previews, and manually dispatched
preview deployments all inherit the same identity. Do not add environment-level
overrides or create a separate dev App. The deploy workflow fails early if the
resolved App ID is not `4106865`.

To rename in GitHub: App settings → General → change the name to **Mako AI**.
Leave id, PEM, client secret, and webhook secret alone. After a display-name
rename, update `GITHUB_APP_SLUG` only if GitHub also changes the slug.

If you ever need to (re)create an app (not the rename path):

```bash
# Owner picked during the GitHub create step; creds written to a gitignored JSON.
BASE_URL=https://app.mako.ai CLIENT_URL=https://app.mako.ai \
GITHUB_APP_NAME="Mako AI" GITHUB_APP_ORG=<org-or-omit-for-personal> \
GITHUB_APP_PUBLIC=1 GITHUB_APP_OUTPUT_JSON=.secrets/prod-github-app.json \
node scripts/register-github-app.mjs
# then set the repository-level vars/secrets from that JSON:
#   gh variable set MAKO_GITHUB_APP_{ID,SLUG,CLIENT_ID} --repo mako-ai/mako ...
#   gh secret   set MAKO_GITHUB_APP_{CLIENT_SECRET,WEBHOOK_SECRET,PRIVATE_KEY} --repo mako-ai/mako ...
```

The manifest already enables _Request user authorization (OAuth) during
installation_, sets the Callback URL to `/api/github/setup`, and marks the app
public — no manual GitHub-UI steps needed for a manifest-created app.

## 1. Repository secrets and variables (all deployed environments)

```bash
# From repo root (private key at .secrets/github-app.pem)
gh secret set MAKO_GITHUB_APP_PRIVATE_KEY --body "$(cat .secrets/github-app.pem | awk '{printf "%s\\n", $0}')"
gh secret set MAKO_GITHUB_APP_WEBHOOK_SECRET --body "your-webhook-secret"
# OAuth client used to verify the installing user controls the installation
# (required — without it /api/github/setup refuses to bind, anti-IDOR).
gh secret set MAKO_GITHUB_APP_CLIENT_SECRET --body "your-app-client-secret"
gh variable set MAKO_GITHUB_APP_ID --body 4106865
gh variable set MAKO_GITHUB_APP_SLUG --body mako-ai
gh variable set MAKO_GITHUB_APP_CLIENT_ID --body Iv1.xxxxxxxxxxxxxxxx
```

`deploy-app.yml` passes these to Cloud Run for **PR previews** and
**production**. Keep the `production` GitHub environment free of
`MAKO_GITHUB_APP_*` overrides so both jobs resolve the repository-level values.

## 2. GitHub App settings (github.com → Settings → Developer settings → GitHub Apps)

| Field                                                      | Production value                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Homepage URL                                               | `https://app.mako.ai`                                                             |
| Callback URL (App OAuth)                                   | `https://app.mako.ai/api/github/setup`                                            |
| **Request user authorization (OAuth) during installation** | ✅ **enabled** (required — delivers the `code` `/setup` uses to verify ownership) |
| Setup URL                                                  | `https://app.mako.ai/api/github/setup`                                            |
| Webhook URL                                                | `https://app.mako.ai/api/github/webhook`                                          |
| Webhook secret                                             | same as `GITHUB_APP_WEBHOOK_SECRET`                                               |
| Logo                                                       | upload `.secrets/github-app-icon.png` (Mako icon)                                 |

> When _Request user authorization during installation_ is on, GitHub makes the Setup URL unavailable and redirects through the **Callback URL** with both `code` and `installation_id` — so the App's Callback URL must point at `/api/github/setup`. Grab the **Client ID** and a generated **Client secret** from the App's General page for `MAKO_GITHUB_APP_CLIENT_ID` / `MAKO_GITHUB_APP_CLIENT_SECRET`.

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
CLIENT_URL=[REDACTED]
GITHUB_APP_ID=4106865
GITHUB_APP_SLUG=mako-ai
GITHUB_APP_PRIVATE_KEY="-----BEGIN..."
GITHUB_APP_WEBHOOK_SECRET=...
GITHUB_APP_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
GITHUB_APP_CLIENT_SECRET=...

pnpm configure:github-app   # writes GITHUB_APP_* from .secrets/github-app.pem
```

Use the same Mako AI App credentials locally. `pnpm register:github-app` creates
a new App and therefore must not be used for routine local setup. For the
existing App, copy the values from the approved secret store and keep _Request
user authorization (OAuth) during installation_ enabled.

For local install callback, either point GitHub App setup URL at a tunnel, or seed `github_installations` manually after installing on github.com.

## 5. App icon

Static assets in `app/public/`:

- `mako-icon.png`, `favicon.png`, `apple-touch-icon.png`
- `android-chrome-192x192.png`, `android-chrome-512x512.png`
- `manifest.json` references these

Used in browser tab, PWA manifest, auth layout, and workspace selector.
