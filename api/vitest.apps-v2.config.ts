import { defineConfig } from "vitest/config";

/**
 * Vitest config scoped to the Apps v2 suite (git substrate, durable
 * worktrees, sandbox provider). Run with `pnpm --filter api run test:apps-v2`.
 *
 * Kept separate from the dbt vitest config (vitest.config.ts) and the
 * destinations config for the same reason those are split: each suite owns
 * its include globs so the runners never trip over each other.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/apps-v2/**/*.test.ts",
      // Workspace repos grew out of apps-v2's repo binding and shares its
      // fixtures/infra (mongodb-memory-server), so it runs in this suite.
      "src/services/workspace-repos.service.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    // mongodb-memory-server downloads a mongod binary on first run.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
