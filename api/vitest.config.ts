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
    // MongoMemoryServer.create() retries a port clash or a slow start (src/test-support/mongo-memory.ts).
    setupFiles: ["./src/test-support/mongo-memory.ts"],
    environment: "node",
    include: [
      "src/dbt/**/*.test.ts",
      "src/auth/mcp-oauth.service.test.ts",
      // MCP sign-in pages: consent pre-ticks requested scopes; CLI parity.
      "src/auth/auth-page.test.ts",
      "src/auth/auth-routes.test.ts",
      "src/utils/client-ip.test.ts",
      "src/routes/mcp-oauth-base-url.test.ts",
      // ChatGPT through the edge: discovery → login → consent → iss → refresh.
      "src/routes/mcp-oauth-chatgpt-flow.test.ts",
      "src/middleware/csp.test.ts",
      "src/integrations/github/**/*.test.ts",
      "src/routes/dbt.routes.integration.test.ts",
      "src/routes/connector-reveal-secret.test.ts",
      "src/routes/source-connection-ids.test.ts",
      "src/routes/source-connection-secrets.test.ts",
      "src/routes/source-connection-roles.test.ts",
      "src/routes/source-connection-orphan-type.test.ts",
      "src/routes/connector-probe.test.ts",
      // Key links: a connection created without its key, set in the app.
      "src/routes/source-connection-key-link.test.ts",
      "src/routes/connector-catalog-tenancy.test.ts",
      "src/agent-lib/tools/dbt-*.test.ts",
      // Connections: credential types, the proxy, writers on source connections.
      "src/connections/callable.test.ts",
      // A write an agent's run records: the request whole, credential redacted.
      "src/connections/describe-request.test.ts",
      "src/connections/google-service-account.test.ts",
      // Custom API Test, and its connector built from the profile.
      "src/connections/callable-profiles/custom-api-test.test.ts",
      // Google credential type validation, at save and at every use path.
      "src/connections/google-credential-use-paths.test.ts",
      "src/connectors/rate-gate.test.ts",
      // ClickHouse Cloud wake: wait budget, interactive cap, DNS fails fast.
      "src/databases/drivers/clickhouse/wake.test.ts",
      // Streamed reads run the query once: no OFFSET pages over an unordered result.
      "src/databases/drivers/clickhouse/stream.test.ts",
      // Cloud SQL cursor, MySQL stream, capped single read: never OFFSET pages.
      "src/databases/stream-once.test.ts",
      // MySQL pool: idle connections reaped, a lost one retried once on reads.
      "src/databases/drivers/mysql/pool.test.ts",
      "src/routes/source-connection-writers.test.ts",
      // A database connection's writers list, changed in the app.
      "src/routes/database-writers-session.test.ts",
      // Who started a run: an agent's runs only read through connections.
      "src/routes/workflows-run-starter.test.ts",
      // Postgres / Neon migration foundation (Phase 0+): bijective ID codec,
      // dual-run router, shadow-compare, backfill, parity verifier, TTL reaper,
      // and domain repository contract suites.
      "src/database/pg/**/*.test.ts",
      "src/migration/**/*.test.ts",
      "src/repositories/**/*.test.ts",
      "src/services/agent-chat/exact-history.test.ts",
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
