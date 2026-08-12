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
    environment: "node",
    include: [
      "src/databases/**/*.test.ts",
      "src/services/destination-writer.service.test.ts",
      "src/sync-cdc/adapters/**/*.test.ts",
      "src/sync-cdc/backlog.test.ts",
      "src/sync-cdc/consumer.test.ts",
      "src/sync/legacy-flow-migration.test.ts",
      "src/sync/sync-orchestrator.test.ts",
      "src/utils/bigquery-emulator.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Gated: only collect (and thus import testcontainers) on demand.
      ...(runIntegration ? [] : ["**/*.integration.test.ts"]),
    ],
    // Spinning up a Postgres container / bigquery-emulator is slow on first pull.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
