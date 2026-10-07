/**
 * Keep a provider-side webhook subscription in step with its flow.
 *
 * Provisioning subscribes an endpoint to the events of the entities enabled
 * at that moment. Without this, enabling another entity later (in the UI or
 * by pushing `flows/<slug>.yml`) leaves the provider still sending the old
 * event list: the new entity only ever gets created-anchor polls, and its
 * updates are silently lost.
 *
 * Best-effort by design: a provider outage or a revoked key must not fail a
 * flow save or a repo push. Every outcome is returned and logged.
 */
import { Types } from "mongoose";

import { Flow, type IFlow } from "../database/workspace-schema";
import { loggers } from "../logging";
import { resolveConfiguredEntities } from "../sync-cdc/entity-selection";

export { flowEntitySignature } from "../sync-cdc/entity-selection";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { sourceConnectionManager } from "../sync/database-data-source-manager";

const logger = loggers.api("flow-webhook-subscription");

export type FlowWebhookSubscriptionSyncResult =
  | { status: "updated"; providerWebhookId: string }
  | { status: "skipped"; reason: string }
  | { status: "not_found" }
  | { status: "failed"; error: string };

type FlowLike = Pick<
  IFlow,
  "_id" | "type" | "dataSourceId" | "webhookConfig" | "entityFilter"
> & { entityLayouts?: IFlow["entityLayouts"] };

export async function syncFlowWebhookSubscription(
  flow: FlowLike,
): Promise<FlowWebhookSubscriptionSyncResult> {
  const webhook = flow.webhookConfig;
  if (flow.type !== "webhook") {
    return { status: "skipped", reason: "not a webhook flow" };
  }
  if (!webhook?.enabled || !webhook.endpoint) {
    return { status: "skipped", reason: "webhook trigger off" };
  }
  // No secret means the flow was never provisioned (or the secret was
  // cleared): there is no subscription whose deliveries we could verify.
  if (!webhook.secret) {
    return { status: "skipped", reason: "webhook not provisioned" };
  }
  if (!flow.dataSourceId) {
    return { status: "skipped", reason: "no connector data source" };
  }

  try {
    const source = await sourceConnectionManager.getSourceConnection(
      String(flow.dataSourceId),
    );
    if (!source) {
      return { status: "skipped", reason: "connector not found" };
    }
    const connector = await syncConnectorRegistry.getConnectorFor(source);
    if (!connector?.supportsWebhookSubscriptionUpdate()) {
      return { status: "skipped", reason: "connector cannot update webhooks" };
    }

    const { entities } = resolveConfiguredEntities(flow);
    const updated = await connector.updateWebhookSubscription({
      endpointUrl: webhook.endpoint,
      enabledEntities: entities,
      providerWebhookId: webhook.providerWebhookId,
    });
    if (!updated) {
      logger.warn("No provider webhook subscription found for flow", {
        flowId: String(flow._id),
        endpoint: webhook.endpoint,
      });
      return { status: "not_found" };
    }

    if (updated.providerWebhookId !== webhook.providerWebhookId) {
      await Flow.updateOne(
        { _id: new Types.ObjectId(String(flow._id)) },
        {
          $set: {
            "webhookConfig.providerWebhookId": updated.providerWebhookId,
          },
        },
      );
    }
    logger.info("Provider webhook subscription synced to flow entities", {
      flowId: String(flow._id),
      providerWebhookId: updated.providerWebhookId,
      entities,
    });
    return { status: "updated", providerWebhookId: updated.providerWebhookId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Could not sync provider webhook subscription", {
      flowId: String(flow._id),
      error: message,
    });
    return { status: "failed", error: message };
  }
}
