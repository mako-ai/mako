# Inngest And Materialization Environment Setup

This repo runs dashboard materialization in three different environments:

- `local`: app on `http://localhost:5173`, API on `http://localhost:8080`, Inngest dev server on `http://localhost:8288`
- `pr`: preview deploys on `https://pr-<number>.mako.ai`
- `production`: `https://app.mako.ai`

## Inngest

### Local development

Run:

```bash
pnpm dev
```

This starts:

- the Vite app
- the API
- `inngest-cli dev`

Local development is isolated from Inngest Cloud. It uses the dev server and does not need `INNGEST_ENV`.

### PR previews

PR previews should register against their own Inngest branch environment:

- `INNGEST_ENV=pr-<number>`
- `INNGEST_EVENT_KEY=<shared project event key>`
- `INNGEST_SIGNING_KEY=<shared branch signing key>`
- `INNGEST_SERVE_ORIGIN=https://pr-<number>.mako.ai`
- `DISABLE_SCHEDULED_SYNC=true`

This gives each preview its own event routing, logs, and function registrations while still using the same Inngest project event key.

Branch environments do not get a unique signing key per PR. Instead, Inngest uses one shared branch signing key across all branch environments, distinct from the production signing key.

Recommended GitHub secrets:

- `INNGEST_SIGNING_KEY`: production signing key (`signkey-prod-...`)
- `INNGEST_BRANCH_SIGNING_KEY`: shared branch signing key (`signkey-branch-...`)

The deploy workflow should set `INNGEST_SIGNING_KEY` from `INNGEST_BRANCH_SIGNING_KEY` for PR previews, then call `PUT /api/inngest` after deploy to register the preview app automatically.

### Production

Production intentionally leaves `INNGEST_ENV` unset so it uses the default environment:

- `INNGEST_EVENT_KEY=<shared project event key>`
- `INNGEST_SIGNING_KEY=<shared project signing key>`
- `INNGEST_SERVE_ORIGIN=https://app.mako.ai`
- `DISABLE_SCHEDULED_SYNC=false`

## Local GCS materialization

Local materialization defaults to the filesystem. To exercise the same GCS path as production, set:

```bash
DASHBOARD_ARTIFACT_STORE=gcs
GCS_DASHBOARD_BUCKET=revops-462013-dashboard-artifacts
DASHBOARD_ARTIFACT_PREFIX=dashboard-artifacts/local-<your-name>
```

### Credential choice

`@google-cloud/storage` can use Application Default Credentials for normal bucket access, but this codebase also generates signed URLs for artifact reads. Signed URL generation requires credentials with a private key.

Because of that, the recommended local setup is:

1. Obtain the approved dev service account JSON key.
2. Set `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/key.json`.
3. Grant that service account:
   - `roles/storage.objectAdmin` on `gs://revops-462013-dashboard-artifacts`
   - `roles/iam.serviceAccountTokenCreator` on itself for signed URL generation

If you only run `gcloud auth application-default login`, uploads may work but signed URL generation will fail.

### Suggested local `.env`

```bash
WEB_API_PORT=8080
BASE_URL=http://localhost:8080
CLIENT_URL=http://localhost:5173

DASHBOARD_ARTIFACT_STORE=gcs
GCS_DASHBOARD_BUCKET=revops-462013-dashboard-artifacts
DASHBOARD_ARTIFACT_PREFIX=dashboard-artifacts/local-<your-name>
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/dev-service-account.json
```

## Environment summary

| Environment | Artifact Store | Artifact Prefix | Inngest Routing | Schedulers |
| --- | --- | --- | --- | --- |
| Local default | filesystem | n/a | local dev server | disabled by `NODE_ENV` |
| Local with GCS | gcs | `dashboard-artifacts/local-<your-name>` | local dev server | disabled by `NODE_ENV` |
| PR preview | gcs | `dashboard-artifacts/pr-<number>` | `INNGEST_ENV=pr-<number>` | disabled |
| Production | gcs | `dashboard-artifacts/prod` | default environment | enabled |
