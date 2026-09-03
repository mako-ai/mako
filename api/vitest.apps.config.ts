import { defineConfig } from "vitest/config";

/**
 * Apps's worktree and adversarial suites, in their OWN vitest run.
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
    include: [
      "src/apps/worktree.service.test.ts",
      "src/apps/workspace-repo.test.ts",
      "src/apps/workspace-prompt.test.ts",
      "src/migrations/2026-09-02-110000_workspace_self_directive_to_git.test.ts",
      "src/services/skills.service.test.ts",
      "src/notebooks/notebook-git.service.test.ts",
      "src/apps/bindings.service.test.ts",
      "src/apps/env.service.test.ts",
      "src/apps/cloud-repo.service.test.ts",
      "src/apps/adversarial.test.ts",
      "src/apps/git-endpoint.test.ts",
      "src/apps/workspace-consoles.service.test.ts",
      "src/apps/workspace-skills.service.test.ts",
      "src/apps/box-state.service.test.ts",
      "src/apps/live-binding-guard.test.ts",
      "src/apps/binding-refresh.test.ts",
      // Real git + mongo: the pre-push flow-file check reads the workspace
      // repo at main and plans against live rows.
      "src/agent-lib/tools/flow-file-tools.test.ts",
      // GET/list from git at main; leftover local git without a binding
      // must not populate the list (issue #956).
      "src/services/flow-sync.repo.test.ts",
      // The live connector probe: its service (bounded, read-only, secrets
      // scrubbed; real Mongo for tenancy) and its tool wiring/gating.
      "src/connectors/probe.service.test.ts",
      "src/agent-lib/tools/connector-tools.test.ts",
      "src/apps/preview.service.test.ts",
      "src/apps/deployment.service.test.ts",
      "src/inngest/functions/apps-binding-refresh.test.ts",
      // These two were written as vitest suites but listed in no vitest
      // config, so neither runner could execute them: tsx dies on them
      // with "Vitest failed to access its internal state", and vitest
      // never collected them. Invisible to both, until the coverage guard.
      // Workspace connectors: real git, real Mongo, and a real child process
      // per protocol command via the local sandbox provider.
      "src/connectors/workspace/workspace-connectors.test.ts",
      "src/connectors/workspace/sync-box.test.ts",
      "src/apps/repository.service.test.ts",
      "src/services/workspace-repos.service.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    // Real git, real sandbox: slower than a unit test by design.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
