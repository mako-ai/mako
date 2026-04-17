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


## Job Queue

Flows run on [Inngest](https://www.inngest.com/), a job queue that handles:

- Scheduled execution (cron-based)
- Automatic retries on failure
- Concurrency limits per workspace
- Progress tracking and logging

The Inngest dev server runs locally at `http://localhost:8288` during development.

## CLI

You can trigger syncs from the command line:

```bash
# Run a specific sync
pnpm run sync --connector stripe --entity customers

# Run all syncs for a workspace
pnpm run sync --workspace <workspace-id>
```

## Error Handling

- Syncs are idempotent — re-running won't create duplicates (upsert-based writes)
- Cursor is saved after each successful chunk, so failures resume from the last checkpoint
- Failed syncs are retried automatically by Inngest with exponential backoff
