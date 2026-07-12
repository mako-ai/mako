import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/apps-v2/*routes.integration.test.ts",
      "src/apps-v2/chat-turn-finalizer.test.ts",
      "src/apps-v2/chat-turn.service.test.ts",
      "src/apps-v2/conversation-worktrees.test.ts",
      "src/apps-v2/manual-worktree-merge-recovery.test.ts",
      "src/apps-v2/github-delivery.service.test.ts",
      "src/apps-v2/github-push.service.test.ts",
      "src/apps-v2/service-factory.test.ts",
      "src/inngest/functions/apps-v2-maintenance.test.ts",
      "src/inngest/index.test.ts",
      "src/integrations/github/github-api.tree.test.ts",
      "src/agent-lib/tools/apps-v2-tools.test.ts",
      "src/routes/apps-v2-turn-handoff.test.ts",
      "src/routes/chat-continuation-ownership.test.ts",
      "src/routes/chat-write-scope.test.ts",
      "src/routes/github-webhook-apps-v2.test.ts",
    ],
  },
});
