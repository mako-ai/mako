import { defineConfig } from "vitest/config";

/**
 * Vitest config scoped to the dbt / Transforms test suite.
 *
 * The rest of `api/` uses hand-rolled `tsx` + `node:assert` suites wired into
 * the `test` script (and CI); this config deliberately only owns the dbt
 * vitest specs so the two runners don't trip over each other. Run with
 * `pnpm --filter api run test:dbt`.
 *
 * The real-dbt contract spec self-skips unless `RUN_DBT_ENGINE_CONTRACT=1`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/dbt/**/*.test.ts",
      "src/integrations/github/**/*.test.ts",
      "src/routes/dbt.routes.integration.test.ts",
      "src/routes/connector-reveal-secret.test.ts",
      "src/agent-lib/tools/dbt-*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      // tsx + node:assert suite (run via the `test` script, not vitest).
      "src/dbt/warm-dir-cache.test.ts",
    ],
    // mongodb-memory-server downloads a mongod binary on first run.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
