# Destination connector test harness

Fast, mostly-offline tests for database **sync destinations** (driver dialect
capabilities, driver write-SQL, the CDC SQL builders, and `DestinationWriter`
orchestration), plus the seams needed to run BigQuery against a local emulator.

Run with the dedicated Vitest config:

```bash
# Offline suites (default — fast, no Docker, runs in CI)
pnpm --filter api run test:destinations

# Include the gated real-DB round-trips (requires Docker)
RUN_DB_INTEGRATION=1 pnpm --filter api run test:destinations
```

Config: [`api/vitest.destinations.config.ts`](../../../vitest.destinations.config.ts).
CI: offline suite runs in `api-contract.yml`; the gated suites run nightly in
`destination-integration.yml`.

## What runs

| Layer | File(s) | Notes |
| --- | --- | --- |
| Dialect contract | `drivers/destination-contract.test.ts` | Table-driven over every destination driver |
| CDC SQL builder | `sync-cdc/adapters/bigquery-merge.test.ts` | Inline-snapshot the MERGE |
| CDC repartition SQL | `sync-cdc/adapters/repartition-sql.test.ts` | Copy+swap statements (BigQuery + ClickHouse) |
| CDC `_syncedAt` stamp | `sync-cdc/adapters/synced-at.test.ts` | `withSyncedAt` contract |
| Driver write-SQL | `drivers/{postgresql,bigquery}/write-sql.test.ts` | Stub `executeQuery`, assert SQL |
| Orchestration | `services/destination-writer.service.test.ts` | Via `_injectForTest` seam |
| Emulator seam | `utils/bigquery-emulator.test.ts` | Host detection / endpoint helpers |
| Integration (gated) | `drivers/**/**.integration.test.ts`, `sync-cdc/adapters/clickhouse-repartition.integration.test.ts` | testcontainers / bigquery-emulator |

### ClickHouse in-place repartition (gated)

`sync-cdc/adapters/clickhouse-repartition.integration.test.ts` runs the real
copy+`EXCHANGE TABLES` swap and asserts the partition key changes while rows are
preserved. It uses an external server when `CLICKHOUSE_TEST_HTTP` is set,
otherwise testcontainers:

```bash
# Against an already-running ClickHouse (no Docker):
RUN_DB_INTEGRATION=1 CLICKHOUSE_TEST_HTTP=http://localhost:8123 \
  pnpm --filter api exec vitest run --config vitest.destinations.config.ts \
  src/sync-cdc/adapters/clickhouse-repartition.integration.test.ts

# Via testcontainers (requires Docker):
RUN_DB_INTEGRATION=1 pnpm --filter api run test:destinations
```

## Helpers (this folder)

- `makeFakeConnection(type, connection?)` — minimal `IDatabaseConnection` (no Mongoose).
- `makeCapturingDriver(driver, responder?)` — replaces `executeQuery` with a
  recorder; `responder` fakes engine reads (e.g. BigQuery `INFORMATION_SCHEMA`).
- `normalizeSql(sql)` / `sqlContains(a, b)` — whitespace-insensitive SQL asserts.
- `runDestinationContract(driver, expectations)` — the shared dialect contract.

> This folder is excluded from the production build
> (`tsconfig.build.json`), so it may import `vitest`. Keep the *non-`.test.ts*
> helpers free of `vitest` runtime imports where possible so they stay shareable
> with integration suites.

## Adding a new destination

1. Implement the driver (see the `add-database-driver` skill).
2. Add one row to the `cases` array in
   [`drivers/destination-contract.test.ts`](../drivers/destination-contract.test.ts)
   describing its dialect capabilities (or `{ absent: true }` for defaults).
3. Add a `drivers/<engine>/write-sql.test.ts` using `makeCapturingDriver`.
4. (Optional) Add a gated `*.integration.test.ts` round-trip behind
   `describe.skipIf(!RUN_DB_INTEGRATION)`.

## Local BigQuery emulator recipe

Run [goccy/bigquery-emulator](https://github.com/goccy/bigquery-emulator) and
point a BigQuery connection at it — no real GCP, no real credentials:

```bash
docker run --rm -p 9050:9050 ghcr.io/goccy/bigquery-emulator:latest \
  --project=test-project --port=9050
```

Create a BigQuery connection with:

- `project_id`: `test-project` (must match `--project`)
- `api_base_url`: `http://localhost:9050`
- `service_account_json`: any **parseable** JSON (e.g. `FAKE_BIGQUERY_SERVICE_ACCOUNT`
  from `fake-connection.ts`) — it is never signed or exchanged.

`isLocalBigQueryEmulator(api_base_url)` (in
[`utils/bigquery-emulator.ts`](../../utils/bigquery-emulator.ts)) makes both
client stacks skip auth: the REST client sends a dummy bearer; the SDK gets
`apiEndpoint` + `BIGQUERY_EMULATOR_HOST`.

### Emulator feature gaps

The emulator supports only a subset of BigQuery SQL. Gate (via `skipIf`) or avoid
tests relying on: `MERGE` / `QUALIFY`, much of `INFORMATION_SCHEMA`,
`ALTER TABLE ... RENAME COLUMN`, and `__TABLES__`. The gated integration test
sticks to dataset autocreate + `SELECT 1` for that reason.
