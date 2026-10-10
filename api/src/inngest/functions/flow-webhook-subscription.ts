import { inngest } from "../client";
import { Flow } from "../../database/workspace-schema";
import {
  removeFlowWebhookSubscription,
  syncFlowWebhookSubscription,
  type FlowWebhookTeardownTarget,
} from "../../services/flow-webhook-subscription.service";

/**
 * Retarget a flow's provider-side webhook subscription after its entity
 * selection changed through a `flows/<slug>.yml` push. Dispatched as an event
 * by flow-sync, which must not load the connector registry itself.
 */
export const flowWebhookResubscribeFunction = inngest.createFunction(
  {
    id: "flow-webhook-resubscribe",
    name: "Retarget Flow Webhook Subscription",
    triggers: { event: "flow.webhook.resubscribe" },
  },
  async ({ event, step, logger }) => {
    const { flowId } = event.data as { flowId: string };
    return step.run("sync-webhook-subscription", async () => {
      const flow = await Flow.findById(flowId);
      if (!flow) {
        return { status: "skipped" as const, reason: "flow not found" };
      }
      const outcome = await syncFlowWebhookSubscription(flow);
      if (outcome.status === "failed" || outcome.status === "not_found") {
        logger.warn("Flow webhook subscription not retargeted", {
          flowId,
          outcome,
        });
      }
      return outcome;
    });
  },
);

/**
 * Remove a deleted flow's provider-side webhook subscription(s). Dispatched by
 * `teardownFlow` with what the row held, since the row is gone by now.
 */
export const flowWebhookUnsubscribeFunction = inngest.createFunction(
  {
    id: "flow-webhook-unsubscribe",
    name: "Remove Flow Webhook Subscription",
    triggers: { event: "flow.webhook.unsubscribe" },
  },
  async ({ event, step, logger }) => {
    const target = event.data as FlowWebhookTeardownTarget;
    return step.run("remove-webhook-subscription", async () => {
      const outcome = await removeFlowWebhookSubscription(target);
      if (outcome.status === "failed") {
        logger.warn("Deleted flow's webhook subscription not removed", {
          flowId: target.flowId,
          outcome,
        });
      }
      return outcome;
    });
  },
);
