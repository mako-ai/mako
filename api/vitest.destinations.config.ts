import { defineConfig } from "vitest/config";

/**
 * Vitest config scoped to the database "destination connector" suites.
 *
 * Covers the sync-pipeline destination surface: driver dialect capabilities,
 * driver write-SQL builders, the CDC SQL builders, and the DestinationWriter
 * orchestration. Kept separate from the dbt config ([vitest.config.ts]) and the
 * tsx + node:assert `test` script so the runners don't trip over each other.
 *
 * Run offline contract/unit suites:   `pnpm --filter api run test:destinations`
 * Include gated real-DB integration:  `RUN_DB_INTEGRATION=1 pnpm --filter api run test:destinations`
 *
 * `*.integration.test.ts` files are only *collected* when `RUN_DB_INTEGRATION`
 * is set. This matters beyond skipping: those files import `testcontainers`
 * (→ a newer `undici` than CI's Node ships), which throws at import/collection
 * time. Excluding them from collection keeps the default offline run from ever
 * loading that dependency.
 */
const runIntegration =
  process.env.RUN_DB_INTEGRATION === "1" ||
  process.env.RUN_DB_INTEGRATION === "true";

export default defineConfig({
  test: {
    // MongoMemoryServer.create() retries a port clash or a slow start (src/test-support/mongo-memory.ts).
    setupFiles: ["./src/test-support/mongo-memory.ts"],
    environment: "node",
    include: [
      "src/databases/**/*.test.ts",
      "src/services/destination-writer.service.test.ts",
      // A failed MAX probe is a failure, never "no data".
      "src/services/destination-writer/query-introspection.test.ts",
      "src/sync-cdc/adapters/**/*.test.ts",
      "src/sync-cdc/backlog.test.ts",
      "src/sync-cdc/consumer.test.ts",
      "src/sync-cdc/webhook-apply-status.db.test.ts",
      // Coalesced materialization lands the same rows as one MERGE per batch.
      "src/sync-cdc/materialize-coalesce.test.ts",
      // One writer per live table: the lease, and the MERGE races it closes.
      "src/sync-cdc/table-write-lease.db.test.ts",
      "src/sync-cdc/flow-reconcile.test.ts",
      // The push reactor's create path, against a real repo and the real model.
      "src/services/flow-sync.repo.test.ts",
      "src/sync/legacy-flow-migration.test.ts",
      "src/sync/sync-orchestrator.test.ts",
      // The incremental poll anchor: poll cursor first, source ts fallback.
      "src/sync/poll-anchor.test.ts",
      // Bulk backfill: every row lands once, through a failed staging load.
      "src/sync/bulk-flush-row-loss.test.ts",
      // A checkpoint never runs ahead of the flushed rows; a new run starts fresh.
      "src/sync/checkpoint-after-flush.test.ts",
      // A failed schema resolution never leads to a schema-less flush.
      "src/sync/schemaless-flush.test.ts",
      "src/utils/bigquery-emulator.test.ts",
      // Per-run Unix users in e2bdev/base under Docker; RUN_DB_INTEGRATION=1.
      "src/connectors/workspace/run-isolation.docker.test.ts",
      "src/connectors/workspace/session-isolation.docker.test.ts",
      "src/connectors/workspace/webhook-batch.docker.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // tsx + node:assert suite (run by scripts/run-tsx-tests.mjs).
      "src/databases/drivers/cloudsql-postgres/driver.pools.test.ts",
      // Gated: only collect (and thus import testcontainers) on demand.
      ...(runIntegration ? [] : ["**/*.integration.test.ts"]),
    ],
    // Spinning up a Postgres container / bigquery-emulator is slow on first pull.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
