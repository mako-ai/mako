import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/sync-cdc/period-guard.review.test.ts"],
  },
});
