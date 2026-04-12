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
