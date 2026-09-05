---
title: Data Sync & Flows
description: Move data between sources and destinations on a schedule.
---

:::caution[Experimental]
Data sync and flows are experimental features under active development. The API and behavior may change.
:::

Flows orchestrate data movement from [Connectors](/connectors/) into your databases. They handle scheduling, chunking, error recovery, and progress tracking.

## How Flows Work

```
Connector → Fetch chunk → Upsert to destination → Save cursor → Next chunk
```

Each flow run:

1. Reads the last saved cursor for the entity
2. Fetches the next chunk of records from the connector
3. Upserts records into the destination database
4. Saves the new cursor position
5. Repeats until no more records

## Sync Modes

Each flow entity runs with one of five sync/write mode combinations:

| Mode | Fetches | Writes |
|------|---------|--------|
| **Incremental \| Append + Deduped** | New or updated records since the last cursor | Upsert by primary key — one deduplicated row per record |
| **Incremental \| Append** | New or updated records since the last cursor | Every version added as a new row (history) |
| **Full Refresh \| Deduped** | Everything, each run | Upsert by primary key (reconciles drift) |
| **Full Refresh \| Append** | Everything, each run | All rows appended — accumulates a snapshot per run |
| **Full Refresh \| Overwrite** | Everything, each run | Destination cleared once at the start of the run, then written — ends up an exact snapshot |

Connectors declare **incremental capabilities** per entity (`full-support`, `created-anchor`, `client-filter`, or `none`), and the flow form only offers honest combinations — an entity whose API can't see updates to old records (e.g. Wise transfers) won't pretend to support true incremental sync, and the connector's warning is surfaced in the UI. Webhook-applied CDC events respect the flow's write mode: append flows append, deduped flows merge.

## Change Data Capture (CDC) & Streaming

In addition to scheduled batch syncing, Mako supports experimental Change Data Capture (CDC) for near real-time updates.

- **Streaming Sync** — continuous event consumption via webhooks or log streams
- **Backfills** — historical data backfills run robustly within 1Gi Cloud Run memory limits, safely handling bulk flushes by cycling DuckDB instances
- **BigQuery Staging** — streams events into region-aligned BigQuery staging tables (safely preserved during recovery)

### Schema Evolution (BigQuery)

When a connector's expected column types drift from the live BigQuery table (for example, a column created as `STRING` in a legacy run that should now be `TIMESTAMP`), Mako auto-corrects the drift before merging CDC events. This prevents merge failures from type mismatches.

For each drifted column, Mako runs a safe four-step swap:

1. `ADD COLUMN` a temporary column with the expected type
2. `UPDATE` the temp column with `SAFE_CAST` of the existing values
3. `RENAME` the original column to a `_bak_*` backup and the temp into its place (atomic)
4. `DROP` the backup column

Drift detection and correction is best-effort: if any step fails for a column, the merge falls back to a `SAFE_CAST` guard using the existing live type so the sync still completes.

The console surfaces drift in the **Backfill Panel** with an auto-correction notice per affected entity. Under the hood this calls the `sync-cdc/schema-health` endpoint (see [API Reference](/api-reference/#flows)) which compares each live column's `data_type` from `INFORMATION_SCHEMA.COLUMNS` against the connector schema.

### Destination Row Counts

The **Backfill Panel** shows destination row totals next to CDC progress. Counts are fetched lazily when the panel opens and when you click the refresh icon beside **Destination rows**; they do not poll continuously.

For BigQuery and PostgreSQL destinations, Mako batches all entity counts into a single metadata query and caches the result briefly. Missing destination tables are shown as `0` rows.


## Job Queue

Flows run on [Inngest](https://www.inngest.com/), a job queue that handles:

- Scheduled execution (cron-based)
- Automatic retries on failure
- Concurrency limits per workspace
- Progress tracking and logging

The Inngest dev server runs locally at `http://localhost:8288` during development.

## Flows as Code (git-based)

Flows can also be defined declaratively in a workspace's own git repo, as
`flows/<slug>.yml` files. This is the mechanism an AI agent (Claude Code,
Cursor, etc.) uses to add, edit, or remove flows without touching the UI.

- **The file is authoritative.** A push to `main` that changes `flows/<slug>.yml`
  reconfigures the corresponding stream; a push that removes the file tears the
  stream down and disposes its checkpoints — re-adding the file backfills from
  scratch. Pushes to other branches have no effect.
- **The filename slug is the flow's identity**, minted once and never changed.
  Renaming a file is a delete-plus-create (new stream, new webhook URL if
  applicable); the in-file `name:` field is the free-to-change display name.
- **Credentials never live in the file.** Connectors and connections are
  referenced by ObjectId only. Webhook secrets and endpoints are minted in
  Mongo on first create and are never read from or written to the file.
- **The connector itself must already exist** — created via the Mako UI
  (Sources → Add). No MCP tool or CLI creates a connector; a flow file can
  only reference one that already has an id.
- Validate before pushing with the `check_flow_files` MCP tool, which reports
  parse/id-resolution problems, schema issues, and the reconciliation plan
  (`wouldCreate` / `wouldReconfigure` / `wouldTeardown`) against currently
  running streams.

See the `flows-as-code` system skill (loaded automatically by MCP-connected
agents) for the full file format and step-by-step workflow.

## Error Handling

- Deduped and overwrite syncs are idempotent — re-running won't create duplicates. Append-mode flows intentionally keep every fetched version as a new row.
- Cursor is saved after each successful chunk, so failures resume from the last checkpoint
- Failed syncs are retried automatically by Inngest with exponential backoff
