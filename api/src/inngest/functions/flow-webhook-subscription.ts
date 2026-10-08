import { inngest } from "../client";
import { Flow } from "../../database/workspace-schema";
import { syncFlowWebhookSubscription } from "../../services/flow-webhook-subscription.service";

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
