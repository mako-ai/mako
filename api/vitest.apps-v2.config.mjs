import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/apps-v2/*routes.integration.test.ts",
      "src/agent-lib/tools/apps-v2-tools.test.ts",
    ],
  },
});
