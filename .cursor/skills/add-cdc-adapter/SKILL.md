---
name: add-cdc-adapter
description: Scaffold a new CDC (Change Data Capture) destination adapter for the Mako sync-cdc pipeline. Use when adding a new database target for CDC materialization (e.g., MySQL, Snowflake).
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
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ applied: number }>;
  applyBatch(params: {
    records: Array<Record<string, unknown>>;
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ written: number }>;

  // Optional
  prepareStaging?(layout: CdcEntityLayout, flowId: string): Promise<void>;
  loadStagingFromParquet?(
    parquetPath: string,
    layout: CdcEntityLayout,
    flowId: string,
  ): Promise<{ loaded: number }>;
  mergeFromStaging?(
    layout: CdcEntityLayout,
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">,
    flowId: string,
    entitySchema?: ConnectorEntitySchema,
  ): Promise<{ written: number }>;
  cleanupStaging?(layout: CdcEntityLayout, flowId: string): Promise<void>;
}
```

## Steps

### 1. Create the adapter file

Create `api/src/sync-cdc/adapters/<name>.ts`:

```typescript
import { loggers } from "../../logging";
import type { CdcDestinationAdapter, CdcEntityLayout } from "./registry";
import type { CdcStoredEvent } from "../events";
import type { IFlow } from "../../database/workspace-schema";
import type { ConnectorEntitySchema } from "../../connectors/base/BaseConnector";
import { databaseConnectionService } from "../../services/database-connection.service";
import {
  buildUpsertRow,
  buildSoftDeleteRow,
  buildBatchRow,
  partitionEventsByOperation,
  resolveDeleteMode,
  resolveFallbackDataSourceId,
} from "./shared";
import { selectLatestChangePerRecord } from "../normalization";
import { CDC_HARD_DELETE_CHUNK_SIZE } from "../constants";

const log = loggers.sync("cdc.adapter.mydb");

export class MyDbDestinationAdapter implements CdcDestinationAdapter {
  readonly destinationType = "mydb";

  constructor(
    private readonly config: {
      destinationDatabaseId: string;
      destinationDatabaseName?: string;
      tableDestination: {
        connectionId: string;
        schema: string;
        tableName: string;
      };
    },
  ) {}

  async ensureLiveTable(layout: CdcEntityLayout): Promise<void> {
    // Create the target table if it doesn't exist.
    // Include _mako_deleted_at, is_deleted, deleted_at for soft deletes.
    // Respect layout.partitioning and layout.clustering if supported.
  }

  async applyEvents(params: {
    events: CdcStoredEvent[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ applied: number }> {
    if (params.events.length === 0) return { applied: 0 };

    const latest = selectLatestChangePerRecord(params.events);
    const fallbackDsId = resolveFallbackDataSourceId(params.flow);
    const { upserts, deletes } = partitionEventsByOperation(latest);
    const deleteMode = resolveDeleteMode(params.flow, params.layout);

    const rows = upserts.map(e => buildUpsertRow(e, fallbackDsId));
    if (deleteMode === "soft") {
      rows.push(...deletes.map(e => buildSoftDeleteRow(e, fallbackDsId)));
    }

    // Write rows to destination ...

    if (deleteMode === "hard" && deletes.length > 0) {
      // Hard-delete by record IDs, chunk by CDC_HARD_DELETE_CHUNK_SIZE
    }

    return { applied: latest.length };
  }

  async applyBatch(params: {
    records: Array<Record<string, unknown>>;
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ written: number }> {
    if (params.records.length === 0) return { written: 0 };

    const fallbackDsId = resolveFallbackDataSourceId(params.flow);
    const rows = params.records.map(r => buildBatchRow(r, fallbackDsId));

    // Bulk-write rows to destination ...

    return { written: rows.length };
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
  normalizedType === "clickhouse" ||
  normalizedType === "postgresql" ||
  normalizedType === "mongodb" ||
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

| Method | What it does | Key considerations |
| --- | --- | --- |
| `ensureLiveTable` | DDL — create table if missing | Include `_mako_deleted_at`, `is_deleted`, `deleted_at` columns for soft deletes. Respect `layout.partitioning` and `layout.clustering`. Must be idempotent. |
| `applyEvents` | Materialize CDC events | Use `shared.ts` helpers: `buildUpsertRow`, `buildSoftDeleteRow`, `partitionEventsByOperation`, `resolveDeleteMode`. Handle hard vs soft deletes. |
| `applyBatch` | Bulk backfill | Use `shared.ts` `buildBatchRow`. Upsert by key columns. |
| `prepareStaging` | Pre-create staging table | Optional. For databases needing explicit staging setup before Parquet load. |
| `loadStagingFromParquet` | Load Parquet file into staging | Optional. For high-volume backfills (BigQuery, ClickHouse). |
| `mergeFromStaging` | Merge staging → live table | Optional. Paired with `loadStagingFromParquet`. |
| `cleanupStaging` | Drop staging table | Optional. Cleanup after merge. |

## Key Rules

- Get database connections via `databaseConnectionService` (never raw clients).
- Use structured loggers (`loggers.sync("cdc.adapter.<name>")`), not `console.log`.
- Use shared helpers from `adapters/shared.ts` for row building, delete mode resolution, and staging table naming.
- Use constants from `constants.ts` for batch sizes and chunk limits.
- `applyEvents` and `applyBatch` must handle empty inputs gracefully (return `{ applied: 0 }` / `{ written: 0 }`).
- The optional staging/Parquet methods are only needed for databases that benefit from bulk-load paths (like BigQuery, ClickHouse).

## Reference Files

- Interface & registry: `api/src/sync-cdc/adapters/registry.ts`
- Shared helpers: `api/src/sync-cdc/adapters/shared.ts`
- Constants: `api/src/sync-cdc/constants.ts`
- BigQuery example: `api/src/sync-cdc/adapters/bigquery.ts`
- ClickHouse example: `api/src/sync-cdc/adapters/clickhouse.ts`
- PostgreSQL example: `api/src/sync-cdc/adapters/postgresql.ts`
- MongoDB example: `api/src/sync-cdc/adapters/mongodb.ts`
- CDC consumer (caller): `api/src/sync-cdc/consumer.ts`
- CDC events type: `api/src/sync-cdc/events.ts`
- Entity layout builder: `buildCdcEntityLayout` in `registry.ts`
- Backfill subsystem: `api/src/sync-cdc/backfill/`
- Inngest materialization: `api/src/inngest/functions/webhook-flow.ts`
