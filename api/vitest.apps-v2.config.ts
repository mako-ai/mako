import { defineConfig } from "vitest/config";

/**
 * Apps v2's worktree suite, in its OWN vitest run.
 *
 * Not folded into vitest.config.ts, and not by preference: these specs drive
 * real git and a real (local) sandbox, and running them alongside the dbt
 * suite made dbt's subprocess-cancellation specs fail on timing. A suite that
 * is heavy enough to starve its neighbours belongs in its own process.
 *
 * The E2B integration spec next to it is deliberately excluded — it needs
 * credentials and a network, so it must never join an offline run.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/apps-v2/worktree.service.test.ts"],
    exclude: ["**/node_modules/**"],
    // Real git, real sandbox: slower than a unit test by design.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
