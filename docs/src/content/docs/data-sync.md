---
title: Data Sync & Flows
description: Move data between databases with configurable, resumable sync flows.
---

Flows are Mako's way of moving data between sources and destinations. They combine extraction queries, schema mapping, and scheduling into a configurable pipeline.

## Flow Types

### Connector Flows
Pull data from external services (Stripe, Close CRM, PostHog) into your warehouse using [connectors](/connectors/).

### Database-to-Database Flows
Move data between any two connected databases. Write a SQL extraction query on the source, configure column mappings, and sync to the destination.

### Webhook Flows
Triggered by external webhooks for real-time or near-real-time sync.

## Configuring a Database Flow

1. **Source** — Select a database connection and write an extraction query
2. **Destination** — Select where the data goes (e.g., BigQuery dataset + table)
3. **Type Coercions** — Map source column types to destination types
4. **Schedule** — Set a cron expression for automatic runs

The [Flow Agent](/ai-agent/) can help configure all of this. Open the chat in the flow editor and describe what you want to sync.

### Template Placeholders

Extraction queries support template placeholders for incremental sync:

```sql
SELECT * FROM orders
WHERE updated_at > '{{last_sync_timestamp}}'
ORDER BY updated_at ASC
```

The sync engine replaces `{{last_sync_timestamp}}` with the timestamp from the last successful run.

## Scheduling

Flows support cron scheduling via Inngest:

```
# Every hour
0 * * * *

# Every day at 2 AM
0 2 * * *

# Every Monday at 9 AM
0 9 * * 1
```

Enable scheduling in the flow configuration. Inngest handles retry on failure with exponential backoff.

## Monitoring

The flow logs show execution history, row counts, errors, and timing for each run. Access via the **Flows** tab in the sidebar.
