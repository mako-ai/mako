# CDC Destination Adapters

Phase-1 ships a production BigQuery adapter and keeps other destinations as documented extension points.

## Adapter contract

Every adapter implements `CdcDestinationAdapter` from `../contracts/destination-adapter.ts`:

- `ensureLiveTable(layout)`
- `applyChanges(layout, batch, ordering, fencingToken)`
- `upsertRecords(layout, records, fencingToken)`
- `applyTombstones(layout, recordIds, fencingToken)`
- optional `getLagAndBacklog(layout)`

The materializer is the only live-writer and passes a fencing token from the `(flowId, entity)` lock lease.

## Adding a Postgres adapter (example)

```ts
import type {
  CdcApplyChange,
  CdcApplyOrderingKey,
  CdcApplyResult,
  CdcDestinationAdapter,
  CdcEntityLayout,
} from "../contracts/destination-adapter";

export class PostgresDestinationAdapter implements CdcDestinationAdapter {
  async ensureLiveTable(layout: CdcEntityLayout): Promise<void> {
    // CREATE TABLE IF NOT EXISTS ...
    // CREATE INDEX ON key columns
  }

  async applyChanges(
    layout: CdcEntityLayout,
    batch: CdcApplyChange[],
    ordering: CdcApplyOrderingKey,
    fencingToken: number,
  ): Promise<CdcApplyResult> {
    // 1) sort by (sourceTs, ingestSeq)
    // 2) keep latest version per recordId
    // 3) upsert + tombstones in a single transaction
    // 4) persist fencing token in apply metadata for split-brain protection
    return { appliedCount: batch.length, failedCount: 0 };
  }

  async upsertRecords(
    layout: CdcEntityLayout,
    records: Record<string, unknown>[],
    fencingToken: number,
  ): Promise<number> {
    return records.length;
  }

  async applyTombstones(
    layout: CdcEntityLayout,
    recordIds: string[],
    fencingToken: number,
  ): Promise<number> {
    return recordIds.length;
  }
}
```

## Connector side expectations

Connectors should emit normalized events in the CDC contract:

- `entity`
- `recordId`
- `operation`
- `payload`
- `sourceTs`
- `source` (`webhook` or `backfill`)

Backfill and webhook must produce the same logical shape so materialization ordering stays deterministic.
