---
title: Deployment
description: Deploy Mako to production with Docker, Google Cloud Run, or Cloudflare.
---

## Docker

Mako ships with a production-ready Dockerfile.

```bash
# Build the image
docker build -t mako .

# Run it
docker run -p 8080:8080 \
  -e DATABASE_URL=mongodb://your-mongodb-url/mako \
  -e ENCRYPTION_KEY=your-32-byte-hex-key \
  -e SESSION_SECRET=your-session-secret \
  -e AI_GATEWAY_API_KEY=your-gateway-key \
  mako
```

The image bundles both the API and the pre-built React frontend. The API serves the frontend from `/public`.

### Docker Compose (Development)

```bash
# Start MongoDB + app
pnpm run docker:up

# Stop
pnpm run docker:down

# Clean (removes volumes)
pnpm run docker:clean
```

## Google Cloud Run

Mako includes a deploy script for Cloud Run:

```bash
# Runs lint, build, local verification, then deploys
./deploy.sh
```

The script:

1. Installs dependencies
2. Runs ESLint
3. Builds both app and API
4. Starts the API locally to verify it boots
5. Builds Docker image and pushes to Google Artifact Registry
6. Deploys to Cloud Run

### Environment Variables

Set these in Cloud Run's environment configuration (or via `cloud-run-env.yaml`):

| Variable                       | Required    | Purpose                                  |
| ------------------------------ | ----------- | ---------------------------------------- |
| `DATABASE_URL`                 | Yes         | MongoDB connection string                |
| `ENCRYPTION_KEY`               | Yes         | Credential encryption                    |
| `SESSION_SECRET`               | Yes         | Session security                         |
| `BASE_URL`                     | Yes         | Public URL (e.g., `https://app.mako.ai`) |
| `CLIENT_URL`                   | Yes         | Same as BASE_URL for Cloud Run           |
| `AI_GATEWAY_API_KEY`           | Required    | AI features (Vercel AI Gateway)          |
| `OPENAI_API_KEY`               | Optional    | Text embeddings only                     |
| `GOOGLE_CLIENT_ID` + `SECRET`  | Optional    | Google OAuth                             |
| `GH_CLIENT_ID` + `SECRET`      | Optional    | GitHub OAuth                             |
| `SENDGRID_API_KEY`             | Optional    | Email invitations                        |
| `EMAIL_LOGO_URL`               | Optional    | Logo for run-notification emails (default: `https://app.mako.ai/email/mako-logo.png`). Override for self-hosted/staging. |
| `BILLING_ENABLED`              | Optional    | Set `true` to enable Stripe billing (default: `false`) |
| `STRIPE_SECRET_KEY`            | Optional    | Stripe secret key (required if billing enabled) |
| `STRIPE_WEBHOOK_SECRET`        | Optional    | Stripe webhook signing secret |
| `STRIPE_PRO_PRICE_ID`          | Optional    | Stripe Price ID for the Pro monthly subscription |
| `STRIPE_METER_EVENT_NAME`      | Optional    | Stripe meter event name for usage reporting (default: `llm_usage_usd`) |

### Dashboard Artifact Storage

Dashboard materialization stores parquet artifacts on the backend. Mako supports
three artifact storage backends:

- `filesystem` - default; stores parquet files on local disk
- `gcs` - stores parquet files in Google Cloud Storage
- `s3` - stores parquet files in an S3-compatible bucket

Select the backend with:

```env
DASHBOARD_ARTIFACT_STORE=filesystem
```

Optional shared settings:

```env
# Prefix for artifact object keys / directories
DASHBOARD_ARTIFACT_PREFIX=dashboards

# Filesystem backend only
DASHBOARD_ARTIFACT_DIR=/data/dashboard-artifacts
```

#### Google Cloud Storage

To use GCS for dashboard parquet artifacts:

```env
DASHBOARD_ARTIFACT_STORE=gcs
GCS_DASHBOARD_BUCKET=your-gcs-bucket
DASHBOARD_ARTIFACT_PREFIX=dashboard-artifacts/prod
```

The runtime service also needs permission to upload objects, check for existing
artifacts, delete stale artifacts, and generate signed read URLs.

### Provisioning GCS for Cloud Run

1. Identify the Cloud Run runtime service account:

   ```bash
   gcloud run services describe revops-fullstack \
     --project=revops-462013 \
     --region=europe-west1 \
     --format="value(spec.template.spec.serviceAccountName)"
   ```

2. Create a bucket in the same project and region:

   ```bash
   gcloud storage buckets create gs://revops-462013-dashboard-artifacts \
     --project=revops-462013 \
     --location=europe-west1 \
     --uniform-bucket-level-access
   ```

3. Grant object read/write access to the runtime service account:

   ```bash
   gcloud storage buckets add-iam-policy-binding gs://revops-462013-dashboard-artifacts \
     --project=revops-462013 \
     --member="serviceAccount:813928377715-compute@developer.gserviceaccount.com" \
     --role="roles/storage.objectAdmin"
   ```

4. Grant signed URL capability to the same runtime service account:

   ```bash
   gcloud iam service-accounts add-iam-policy-binding \
     813928377715-compute@developer.gserviceaccount.com \
     --project=revops-462013 \
     --member="serviceAccount:813928377715-compute@developer.gserviceaccount.com" \
     --role="roles/iam.serviceAccountTokenCreator"
   ```

5. Update the Cloud Run service with the storage env vars:

   ```bash
   gcloud run services update revops-fullstack \
     --project=revops-462013 \
     --region=europe-west1 \
     --update-env-vars=DASHBOARD_ARTIFACT_STORE=gcs,GCS_DASHBOARD_BUCKET=revops-462013-dashboard-artifacts,DASHBOARD_ARTIFACT_PREFIX=dashboard-artifacts/prod
   ```

### Deployment Notes

- If `DASHBOARD_ARTIFACT_STORE` is not set, Mako falls back to `filesystem`.
- Your deploy workflow must also pass the artifact storage env vars to Cloud
  Run, or later deploys can revert the backend to local disk.
- Preview environments should use a unique prefix such as
  `dashboard-artifacts/pr-123` so all previews can safely share the same
  bucket.

## Billing (Optional)

Mako includes an optional Stripe-based subscription billing system. It is **disabled by default** — self-hosted and open-source deployments have unlimited access to all models and features.

To enable billing for a hosted/SaaS deployment, set `BILLING_ENABLED=true` and configure the Stripe env vars above.

### Plans

| Plan | Free Quota | Hard Limit | Model Access | Max Databases | Max Members |
|------|-----------|------------|-------------|--------------|------------|
| **Free** | $5 / month | $5 | Free-tier models only (≤$3/M) | 3 | 3 |
| **Pro** | $80 / month | None (overage billed) | All models | 50 | 25 |

### Billing API Endpoints

All endpoints are mounted at `/api/workspaces/:workspaceId/billing`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/workspaces/:wid/billing/status` | Get current plan, usage, and subscription status |
| `POST` | `/api/workspaces/:wid/billing/checkout` | Create a Stripe Checkout session (upgrade to Pro) |
| `POST` | `/api/workspaces/:wid/billing/portal` | Create a Stripe Customer Portal session (manage subscription) |

Stripe webhooks are handled at `/api/stripe-webhook` with signature verification.

### Promotion Codes

Stripe promotion codes/coupons can be applied at checkout. The Stripe Checkout UI includes a promo code input field.

## Cloudflare Workers

The `cloudflare/` directory contains Cloudflare Workers configuration for edge routing and proxy functionality.
