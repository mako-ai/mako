import { Db } from "mongodb";
import { loggers } from "../logging";

export const description =
  "Retire flow `type`: a flow created as a webhook flow states its webhook trigger explicitly (webhookConfig.enabled), so nothing needs `type` to know it takes deliveries";

const log = loggers.migration();

/**
 * Idempotent and safe after the new code is live: the code reads a webhook
 * flow's trigger from `webhookConfig` (endpoint + enabled) and still falls
 * back on `type: "webhook"` for a document without an endpoint, so an
 * un-migrated row behaves the same. Only rows whose `webhookConfig.enabled`
 * is absent are touched (Mongoose materialised it as `true` on every read);
 * a webhook switched off on purpose (`false`) stays off. `type` itself is left
 * on old documents and never written again.
 */
export async function up(db: Db): Promise<void> {
  const flows = db.collection("flows");
  const result = await flows.updateMany(
    { type: "webhook", "webhookConfig.enabled": { $exists: false } },
    { $set: { "webhookConfig.enabled": true } },
  );
  const withoutEndpoint = await flows.countDocuments({
    type: "webhook",
    $or: [
      { "webhookConfig.endpoint": { $exists: false } },
      { "webhookConfig.endpoint": "" },
      { "webhookConfig.endpoint": null },
    ],
  });
  log.info("Webhook flows state their trigger explicitly", {
    enabledSet: result.modifiedCount,
    // Still served through the `type` fallback in isWebhookFlow.
    webhookFlowsWithoutEndpoint: withoutEndpoint,
  });
}
