# CDC Destination Adapters

Phase-1 ships a production BigQuery adapter and keeps other destinations as documented extension points.

## Adapter contract

Every adapter implements `CdcDestinationAdapter` from `../contracts/adapters.ts`:

- `ensureLiveTable(layout)`
- `materializeEntity(run, fencingToken)`

The materializer is the only live-writer and passes a fencing token from the `(flowId, entity)` lock lease.

## Adding a Postgres adapter (example)

```ts
import type {
  CdcDestinationAdapter,
  CdcEntityLayout,
  CdcMaterializationResult,
  CdcMaterializationRun,
} from "../contracts/adapters";

export class PostgresDestinationAdapter implements CdcDestinationAdapter {
  async ensureLiveTable(layout: CdcEntityLayout): Promise<void> {
    // CREATE TABLE IF NOT EXISTS ...
    // CREATE INDEX ON key columns
  }

  async materializeEntity(
    run: CdcMaterializationRun,
    fencingToken: number,
  ): Promise<CdcMaterializationResult> {
    // Use the destination's preferred strategy (MERGE/upsert/staging+swap)
    // while respecting fencing tokens for single-writer guarantees.
    return { staged: 0, applied: 0, lastMaterializedSeq: 0 };
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
