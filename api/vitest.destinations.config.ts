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
 * Integration suites (testcontainers / bigquery-emulator) self-skip unless
 * `RUN_DB_INTEGRATION=1` is set, so the default run stays fast and offline.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/databases/**/*.test.ts",
      "src/services/destination-writer.service.test.ts",
      "src/sync-cdc/adapters/**/*.test.ts",
      "src/utils/bigquery-emulator.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Spinning up a Postgres container / bigquery-emulator is slow on first pull.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
