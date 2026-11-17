/**
 * Webhook batches for workspace (boxed) connectors, behind
 * CONNECTOR_WEBHOOK_BATCHES (connectors/workspace/webhook-batch.ts).
 *
 * The dispatcher runs every minute and sends one event per flow with pending
 * box-lane webhooks. The batch function takes that flow's events in batches,
 * one batch per step, until the queue is empty, a batch fails or the run has
 * taken its share, then asks for materialization of what it ingested.
 *
 * Isolation between connections:
 * - one run per flow at a time (singleton, skip): a flow's events apply in
 *   order, and a stuck run never piles up behind itself;
 * - concurrency 1 per connection and 3 per workspace: a slow or hostile
 *   connector holds at most one slot, in its own workspace;
 * - a failed or timed-out batch ends the run, so a hostile connector costs
 *   one batch timeout (60 s) per dispatch, never more.
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import {
  connectorWebhookBatchesEnabled,
  webhookBatchLimits,
} from "../../connectors/workspace/webhook-config";
import {
  flowsWithPendingBoxWebhooks,
  processBoxWebhookBatch,
  type BatchResult,
} from "../../connectors/workspace/webhook-batch";

const logger = loggers.inngest("connector-webhook-batch");

export const CONNECTOR_WEBHOOK_BATCH_EVENT = "connector/webhook.batch";

export const connectorWebhookBatchDispatchFunction = inngest.createFunction(
  {
    id: "connector-webhook-batch-dispatch",
    name: "Connector Webhook Batch Dispatch",
    concurrency: { limit: 1 },
    triggers: { cron: "* * * * *" },
  },
  async ({ step }) => {
    if (!connectorWebhookBatchesEnabled()) return { dispatched: 0 };
    const flows = (await step.run("find-flows", () =>
      flowsWithPendingBoxWebhooks(),
    )) as Array<{ flowId: string; workspaceId: string; connectionId: string }>;
    for (let i = 0; i < flows.length; i += 50) {
      await step.sendEvent(
        `dispatch-${i}`,
        flows.slice(i, i + 50).map(flow => ({
          name: CONNECTOR_WEBHOOK_BATCH_EVENT,
          data: flow,
        })),
      );
    }
    return { dispatched: flows.length };
  },
);

export const connectorWebhookBatchFunction = inngest.createFunction(
  {
    id: "connector-webhook-batch",
    name: "Connector Webhook Batch",
    retries: 0,
    timeouts: { finish: "15m" },
    singleton: { key: "event.data.flowId", mode: "skip" },
    concurrency: [
      { key: "event.data.connectionId", limit: 1 },
      { key: "event.data.workspaceId", limit: 3 },
    ],
    triggers: { event: CONNECTOR_WEBHOOK_BATCH_EVENT },
  },
  async ({ event, step }) => {
    const { flowId, workspaceId } = event.data as {
      flowId: string;
      workspaceId: string;
    };
    const entities = new Set<string>();
    const totals = { batches: 0, claimed: 0, ingested: 0, failed: 0 };
    let stopReason: string | undefined;
    const { maxBatchesPerRun } = webhookBatchLimits();
    for (let i = 0; i < maxBatchesPerRun; i++) {
      const result = (await step.run(`batch-${i}`, () =>
        processBoxWebhookBatch({ flowId }),
      )) as BatchResult;
      totals.batches++;
      totals.claimed += result.claimed;
      totals.ingested += result.ingested;
      totals.failed += result.failed;
      for (const entity of result.entities ?? []) entities.add(entity);
      if (result.next !== "more") {
        stopReason = result.reason;
        break;
      }
    }
    if (entities.size > 0) {
      await step.sendEvent(
        "materialize",
        [...entities].map(entity => ({
          name: "cdc/materialize" as const,
          data: { workspaceId, flowId, entity, force: false },
        })),
      );
    }
    if (totals.claimed > 0 || stopReason) {
      logger.info("Connector webhook batches ran", {
        flowId,
        ...totals,
        entities: entities.size,
        stopReason,
      });
    }
    return { ...totals, entities: [...entities], stopReason };
  },
);
