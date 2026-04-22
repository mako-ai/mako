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

## Sync / DuckDB Parquet Tuning

The backfill pipeline flushes buffered rows from a MongoDB temp collection into
Parquet files via DuckDB, then loads them into the destination (BigQuery,
ClickHouse, etc.). Several environment variables control memory and batch sizing:

| Variable | Default | Description |
|---|---|---|
| `SYNC_PARQUET_DUCKDB_MEMORY_LIMIT_MB` | `512` | DuckDB per-instance memory cap. Raise if entities contain very large text (e.g. meeting notes). |
| `SYNC_PARQUET_DUCKDB_THREADS` | `1` | DuckDB thread count. Keep at 1 to minimize peak memory. |
| `SYNC_BULK_FLUSH_BATCH_SIZE` | `10000` | Max rows per Parquet file in the bulk flush loop. |
| `SYNC_BULK_FLUSH_MIN_BATCH_SIZE` | `100` | Floor for adaptive batch shrinking (see below). |
| `SYNC_BULK_MONGO_TO_PARQUET_CHUNK` | `200` | Rows per DuckDB `INSERT` micro-batch from Mongo cursor. |

### Adaptive batch sizing

When a Parquet build fails with a DuckDB memory error (e.g. `failed to pin block`),
the flush loop automatically halves the batch size and retries with the same rows.
It continues halving down to `SYNC_BULK_FLUSH_MIN_BATCH_SIZE`. If the minimum
still fails, the error is surfaced to the Inngest step for retry/alerting.

After 3 consecutive successful flushes at a reduced size, the batch size doubles
back toward `SYNC_BULK_FLUSH_BATCH_SIZE` so throughput recovers for normal data.

This means entities with unusually large payloads (long meeting notes, embedded
documents) will self-heal without operator intervention, while normal entities
continue at full batch throughput.

## Webhook flow concurrency caps

The webhook-driven ingestion pipeline exposes two Inngest function-level
concurrency caps to protect shared infrastructure (most importantly the
BigQuery slot reservation) from being starved when the scheduler fans out many
entities at once. Both are tuned via environment variables and default to
conservative values.

| Variable | Default | Applies to | Description |
|---|---|---|---|
| `WEBHOOK_SQL_PROCESS_CONCURRENCY` | `5` | Non-CDC webhook SQL processors | Max in-flight `webhookSqlProcess` runs per flow. Higher values speed up catch-up after a backlog; lower values reduce pressure on the destination warehouse. |
| `CDC_MATERIALIZE_CONCURRENCY` | `8` | `cdcMaterializeFunction` (global) | Max CDC materializations running in parallel across all flows/entities. Each run fires ~6-10 BigQuery jobs (INFORMATION_SCHEMA, ALTERs, COUNTs, MERGE, DROP, Parquet load), so the global cap exists to prevent slot saturation in the `europe-west6` 100-slot reservation. The per-`(flowId, entity)` singleton is preserved independently. |
| `CDC_MATERIALIZE_CONCURRENCY_PER_FLOW` | `3` | `cdcMaterializeFunction` (per flow) | Max CDC materializations running in parallel **within a single flow**. Prevents one large flow (e.g. a full Close backfill) from monopolizing all global materialize slots while smaller flows queue. Stacks with the global `CDC_MATERIALIZE_CONCURRENCY` cap. |
| `BIGQUERY_MERGE_MAX_WAIT_MS` | `900000` (15min) | `cdcMaterializeFunction` BigQuery MERGE job wait | Max wall time Mako waits for a single MERGE job before giving up and failing the step. Lowered from the previous 50min default so stuck MERGEs surface faster; raise only if you see spurious timeouts on legitimately slow large-partition merges. |

Raise `CDC_MATERIALIZE_CONCURRENCY` only if you have headroom in the BigQuery
slot reservation -- it is the first knob to lower if interactive or hasura-crm
queries start queueing during CDC catch-up. If a single flow is starving others,
lower `CDC_MATERIALIZE_CONCURRENCY_PER_FLOW` instead of the global cap.

## Environment summary

| Environment    | Artifact Store | Artifact Prefix                         | Inngest Routing           | Schedulers             |
| -------------- | -------------- | --------------------------------------- | ------------------------- | ---------------------- |
| Local default  | filesystem     | n/a                                     | local dev server          | disabled by `NODE_ENV` |
| Local with GCS | gcs            | `dashboard-artifacts/local-<your-name>` | local dev server          | disabled by `NODE_ENV` |
| PR preview     | gcs            | `dashboard-artifacts/pr-<number>`       | `INNGEST_ENV=pr-<number>` | disabled               |
| Production     | gcs            | `dashboard-artifacts/prod`              | default environment       | enabled                |
