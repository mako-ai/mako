---
title: Connectors
description: Sync data from external sources into your warehouse with pluggable connectors.
---

Connectors are how Mako pulls data from external services into your data warehouse. Each connector implements a standard interface for chunked, resumable data fetching.

## Available Connectors

| Connector | Data Source | Entities |
|---|---|---|
| **Stripe** | Payment data | Customers, subscriptions, invoices, charges, payments |
| **Close** | CRM data | Leads, contacts, activities, opportunities |
| **PostHog** | Product analytics | Events, persons, groups |
| **BigQuery** | Data warehouse | Tables and views |
| **REST** | Any REST API | Custom entities via configuration |
| **GraphQL** | Any GraphQL API | Custom queries |

## How Sync Works

Mako uses a **chunked sync** architecture:

1. **Fetch chunk** — The connector fetches a batch of records and returns a cursor
2. **Save state** — The sync orchestrator persists the cursor after each chunk
3. **Resume** — If a sync fails mid-way, it resumes from the last successful chunk
4. **Upsert** — All writes are idempotent (upsert-based) so re-running is safe

This means syncs are:
- **Resumable** — network failures don't restart from scratch
- **Incremental** — only fetch new/changed data on subsequent runs
- **Idempotent** — safe to re-run without creating duplicates

## Running Syncs

### From the UI
Navigate to **Flows** in the sidebar. Create a new flow, select a source connector and destination, configure entities, and run.

### From the CLI
```bash
# Interactive — prompts for source, destination
pnpm run sync

# Direct
pnpm run sync -- -s <source_id> -d <destination_id>

# Specific entities only
pnpm run sync -- -s <source_id> -d <destination_id> -e customers,invoices
```

### Scheduled (Inngest)
Flows can be scheduled via cron in the flow configuration. Inngest handles the orchestration with automatic retry on failure.

### Webhook-triggered
Some flows can be triggered by webhooks for real-time sync.

## Building a Custom Connector

Extend `BaseConnector` and implement three methods:

```typescript
import { BaseConnector } from "./base/BaseConnector";

class MyServiceConnector extends BaseConnector {
  // Define what this connector can sync
  getMetadata() {
    return {
      name: "My Service",
      version: "1.0.0",
      description: "Syncs data from My Service",
      supportedEntities: ["users", "orders"],
    };
  }

  // Validate the connection works
  async testConnection() {
    const ok = await this.client.ping();
    return { success: ok, message: ok ? "Connected" : "Failed" };
  }

  // Fetch one chunk of data, return cursor for next chunk
  async fetchEntityChunk(options) {
    const { entity, state } = options;
    const page = state?.page || 1;

    const response = await this.client.getUsers({ page });
    await options.onBatch(response.data);

    return {
      totalProcessed: (state?.totalProcessed || 0) + response.data.length,
      hasMore: response.hasMore,
      page: page + 1,
    };
  }
}
```

Register it in `api/src/connectors/registry.ts` — the registry auto-discovers connector directories, but you can also register manually.

### Best Practices

- **Idempotency**: Use upsert operations in the destination
- **Rate limiting**: Respect API limits with built-in delays
- **Typing**: Define interfaces for API responses
- **Icons**: Add an `icon.svg` to your connector directory for the UI
