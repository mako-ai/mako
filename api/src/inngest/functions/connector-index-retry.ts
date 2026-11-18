import { inngest } from "../client";
import { loggers } from "../../logging";
import { retryDueConnectorIndexing } from "../../connectors/workspace/reconcile.service";

const log = loggers.connector();

/**
 * Re-index workspace connectors whose last index hit a platform error.
 *
 * A connector in `retrying` (connectors/workspace/transient-failure.ts) waits
 * 1, 2, 4 … 30 min, then 30 min between tries. This tick finds the ones
 * that are due and runs the same reconcile a push runs, so no one has to push
 * a no-op commit to unblock them.
 */
export const connectorIndexRetryFunction = inngest.createFunction(
  {
    id: "connector-index-retry",
    name: "Connectors: retry indexing after a platform error",
    concurrency: { limit: 1 },
    // The next tick is a minute away; a retry would only race it.
    retries: 0,
    triggers: { cron: "* * * * *" },
  },
  async ({ step }) =>
    step.run("retry-due", async () => {
      const result = await retryDueConnectorIndexing();
      if (result.workspaces > 0) {
        log.info("Retried connector indexing", { ...result });
      }
      return result;
    }),
);
