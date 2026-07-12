import { processAppsV2GitHubDelivery } from "../../apps-v2/github-delivery.service";
import { loggers } from "../../logging";
import { inngest } from "../client";

const log = loggers.inngest();

export const appsV2GitHubDeliveryFunction = inngest.createFunction(
  {
    id: "apps-v2-github-delivery",
    name: "Process Apps v2 GitHub Delivery",
    retries: 5,
    concurrency: {
      limit: 1,
      key: "event.data.deliveryId",
    },
    idempotency: "event.data.deliveryId",
  },
  { event: "apps-v2/github.push" },
  async ({ event, step }) => {
    return step.run("process-github-push-delivery", async () => {
      const result = await processAppsV2GitHubDelivery(event.data.deliveryId);
      log.info("Processed Apps v2 GitHub delivery", {
        deliveryId: event.data.deliveryId,
        processed: result.processed,
        conflicts: result.conflicts,
      });
      return result;
    });
  },
);
