---
name: add-cdc-adapter
description: Scaffold a new CDC (Change Data Capture) destination adapter for the Mako sync-cdc pipeline. Use when adding a new database target for CDC materialization (e.g., ClickHouse, MySQL, Snowflake).
---

# Add a CDC Destination Adapter

## Overview

CDC destination adapters write change-data-capture events and backfill batches into target databases. They implement the `CdcDestinationAdapter` interface and are resolved by the manual registry in `api/src/sync-cdc/adapters/registry.ts`.

## Interface

```typescript
// From api/src/sync-cdc/adapters/registry.ts

interface CdcEntityLayout {
  entity: string;
  tableName: string;
  keyColumns: string[];
  deleteMode?: "hard" | "soft";
  partitioning?: {
    type?: "time" | "ingestion";
    field: string;
    granularity?: "day" | "hour" | "month" | "year";
    requirePartitionFilter?: boolean;
  };
  clustering?: { fields: string[] };
}

interface CdcDestinationAdapter {
  destinationType: string;

  // Required
  ensureLiveTable(layout: CdcEntityLayout): Promise<void>;
  applyEvents(params: {
    events: CdcStoredEvent[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ applied: number }>;
  applyBatch(params: {
    records: Array<Record<string, unknown>>;
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ written: number }>;

  // Optional (bulk/Parquet backfill)
  getLiveTableColumnTypes?(
    layout: CdcEntityLayout,
  ): Promise<Map<string, string> | undefined>;
  loadStagingFromParquet?(
    parquetPath: string,
    layout: CdcEntityLayout,
    flowId: string,
  ): Promise<{ loaded: number }>;
  mergeFromStaging?(
    layout: CdcEntityLayout,
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">,
    flowId: string,
  ): Promise<{ written: number }>;
  cleanupStaging?(layout: CdcEntityLayout, flowId: string): Promise<void>;
}
```

## Steps

### 1. Create the adapter file

Create `api/src/sync-cdc/adapters/<name>.ts`:

```typescript
import { loggers } from "../../logging";
import { CdcDestinationAdapter, CdcEntityLayout } from "./registry";
import { CdcStoredEvent } from "../events";
import { IFlow } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";

const log = loggers.sync();

export class MyDbDestinationAdapter implements CdcDestinationAdapter {
  readonly destinationType = "mydb";

  private destinationDatabaseId: string;
  private destinationDatabaseName?: string;
  private tableDestination: {
    connectionId: string;
    schema: string;
    tableName: string;
  };

  constructor(params: {
    destinationDatabaseId: string;
    destinationDatabaseName?: string;
    tableDestination: {
      connectionId: string;
      schema: string;
      tableName: string;
    };
  }) {
    this.destinationDatabaseId = params.destinationDatabaseId;
    this.destinationDatabaseName = params.destinationDatabaseName;
    this.tableDestination = params.tableDestination;
  }

  async ensureLiveTable(layout: CdcEntityLayout): Promise<void> {
    // Create the target table if it doesn't exist.
    // Include columns for all key columns + a _deleted_at column for soft deletes.
    // Use layout.partitioning and layout.clustering if the database supports them.
  }

  async applyEvents(params: {
    events: CdcStoredEvent[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ applied: number }> {
    // Materialize CDC events into the live table.
    // Group by operation type (insert/update/delete).
    // For deletes: soft-delete (set _deleted_at) or hard-delete based on flow.deleteMode.
    // Return { applied: number of events processed }.
  }

  async applyBatch(params: {
    records: Array<Record<string, unknown>>;
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ written: number }> {
    // Bulk-write backfill records to the live table.
    // Upsert by layout.keyColumns.
    // Return { written: number of rows written }.
  }
}
```

### 2. Register in the resolver

Edit `api/src/sync-cdc/adapters/registry.ts`:

```typescript
import { MyDbDestinationAdapter } from "./mydb";

// In resolveCdcDestinationAdapter(), add before the throw:
if (normalizedType === "mydb") {
  return new MyDbDestinationAdapter({
    destinationDatabaseId: params.destinationDatabaseId,
    destinationDatabaseName: params.destinationDatabaseName,
    tableDestination: params.tableDestination,
  });
}

// In hasCdcDestinationAdapter(), update the check:
return (
  normalizedType === "bigquery" ||
  normalizedType === "postgresql" ||
  normalizedType === "mydb"
);
```

### 3. Enable in the frontend (optional)

The Flow form UI at `app/src/components/WebhookFlowForm.tsx` may restrict CDC engine selection to specific destination types. If your adapter should be selectable in the UI, update the filter there.

### 4. Test

1. Start dev server: `pnpm dev`
2. Create a Flow with `syncEngine: "cdc"` pointing to your new destination type
3. Trigger a webhook to generate CDC events
4. Verify events materialize into the target table via `cdcConsumerService.materializeEntity`
5. Test backfill via the bulk sync path

## Method Implementation Guide

| Method                    | What it does                                  | Key considerations                                                                                                                                 |
| ------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensureLiveTable`         | DDL — create table if missing                 | Include `_deleted_at` column for soft deletes. Respect `layout.partitioning` and `layout.clustering` if your DB supports them. Must be idempotent. |
| `applyEvents`             | Materialize CDC events (insert/update/delete) | Group operations for efficiency. Handle `deleteMode: "hard"` vs `"soft"`. Use `layout.keyColumns` for upsert/merge logic.                          |
| `applyBatch`              | Bulk backfill (non-CDC path)                  | Upsert by key columns. Used during initial sync and periodic backfills.                                                                            |
| `getLiveTableColumnTypes` | Return existing column types                  | Optional. Used by Parquet bulk-flush to match types.                                                                                               |
| `loadStagingFromParquet`  | Load Parquet file into a staging table        | Optional. For high-volume backfills.                                                                                                               |
| `mergeFromStaging`        | Merge staging → live table                    | Optional. Paired with `loadStagingFromParquet`.                                                                                                    |
| `cleanupStaging`          | Drop staging table                            | Optional. Cleanup after merge.                                                                                                                     |

## Key Rules

- Get database connections via `databaseConnectionService` (never raw clients).
- Use structured loggers (`loggers.sync()`), not `console.log`.
- The adapter receives `tableDestination.connectionId` — resolve it to a connection via the connection service.
- `applyEvents` and `applyBatch` must handle empty inputs gracefully (return `{ applied: 0 }` / `{ written: 0 }`).
- The optional staging/Parquet methods are only needed for databases that benefit from bulk-load paths (like BigQuery).

## Reference Files

- Interface & registry: `api/src/sync-cdc/adapters/registry.ts`
- BigQuery example: `api/src/sync-cdc/adapters/bigquery.ts`
- PostgreSQL example: `api/src/sync-cdc/adapters/postgresql.ts`
- CDC consumer (caller): `api/src/sync-cdc/consumer.ts`
- CDC events type: `api/src/sync-cdc/events.ts`
- Entity layout builder: `buildCdcEntityLayout` in `registry.ts`
- Inngest materialization: `api/src/inngest/functions/webhook-flow.ts`
