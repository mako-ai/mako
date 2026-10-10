/**
 * Keep a provider-side webhook subscription in step with its flow.
 *
 * Provisioning subscribes an endpoint to the events of the entities enabled
 * at that moment. Without this, enabling another entity later (in the UI or
 * by pushing `flows/<slug>.yml`) leaves the provider still sending the old
 * event list: the new entity only ever gets created-anchor polls, and its
 * updates are silently lost.
 *
 * The subscription id it settles on is definition, so it is recorded the way
 * every definition change is: committed to `flows/<slug>.yml`
 * (`webhook.provider_webhook_id`), then mirrored into the Mongo index.
 *
 * Best-effort by design: a provider outage or a revoked key must not fail a
 * flow save or a repo push. Every outcome is returned and logged.
 */
import { Types } from "mongoose";

import { Flow, type IFlow } from "../database/workspace-schema";
import { loggers } from "../logging";
import { resolveConfiguredEntities } from "../sync-cdc/entity-selection";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { commitFlowFile } from "./flow-config.service";

export { flowEntitySignature } from "../sync-cdc/entity-selection";

const logger = loggers.api("flow-webhook-subscription");

export type FlowWebhookSubscriptionSyncResult =
  | { status: "updated"; providerWebhookId: string }
  | { status: "skipped"; reason: string }
  | { status: "not_found" }
  | { status: "failed"; error: string };

export interface FlowWebhookSubscriptionDeps {
  commitFlowFile: typeof commitFlowFile;
}

const defaultDeps: FlowWebhookSubscriptionDeps = { commitFlowFile };

export async function syncFlowWebhookSubscription(
  flow: IFlow,
  deps: FlowWebhookSubscriptionDeps = defaultDeps,
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
      await recordProviderWebhookId(flow, updated.providerWebhookId, deps);
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

/** What a deleted webhook flow leaves behind to unsubscribe. */
export interface FlowWebhookTeardownTarget {
  flowId: string;
  dataSourceId: string;
  endpoint: string;
  providerWebhookId?: string;
}

export type FlowWebhookSubscriptionRemoveResult =
  | { status: "removed"; count: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

/**
 * Remove the provider-side subscription(s) of a flow that was deleted, so the
 * provider stops POSTing to a URL that now answers 404. Runs after the row is
 * gone, from what `teardownFlow` captured. Best-effort, like the sync above.
 */
export async function removeFlowWebhookSubscription(
  target: FlowWebhookTeardownTarget,
): Promise<FlowWebhookSubscriptionRemoveResult> {
  try {
    const source = await sourceConnectionManager.getSourceConnection(
      target.dataSourceId,
    );
    if (!source) {
      return { status: "skipped", reason: "connector not found" };
    }
    const connector = await syncConnectorRegistry.getConnectorFor(source);
    if (!connector?.supportsWebhookSubscriptionDelete()) {
      return { status: "skipped", reason: "connector cannot delete webhooks" };
    }
    const count = await connector.deleteWebhookSubscription({
      endpointUrl: target.endpoint,
      providerWebhookId: target.providerWebhookId,
    });
    logger.info("Provider webhook subscription removed with its flow", {
      flowId: target.flowId,
      count,
    });
    return { status: "removed", count };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Could not remove provider webhook subscription", {
      flowId: target.flowId,
      error: message,
    });
    return { status: "failed", error: message };
  }
}

/**
 * Commit the id to the flow file first; only a committed definition reaches
 * the Mongo index. A failed commit leaves both untouched — the provider is
 * already updated, and the next sync finds the endpoint by URL again.
 */
async function recordProviderWebhookId(
  flow: IFlow,
  providerWebhookId: string,
  deps: FlowWebhookSubscriptionDeps,
): Promise<void> {
  const previous = flow.webhookConfig?.providerWebhookId;
  if (flow.webhookConfig) {
    flow.webhookConfig.providerWebhookId = providerWebhookId;
  }
  const committed = await deps.commitFlowFile(
    flow,
    undefined,
    `flow: "${flow.name ?? flow.slug}" (${flow.slug}): webhook subscription ${providerWebhookId}`,
  );
  if (!committed.ok) {
    if (flow.webhookConfig) {
      flow.webhookConfig.providerWebhookId = previous;
    }
    logger.warn("Provider webhook id not committed to the flow file", {
      flowId: String(flow._id),
      providerWebhookId,
      error: committed.error,
    });
    return;
  }
  await Flow.updateOne(
    { _id: new Types.ObjectId(String(flow._id)) },
    {
      $set: {
        "webhookConfig.providerWebhookId": providerWebhookId,
        ...(committed.sourceBlobSha
          ? { sourceBlobSha: committed.sourceBlobSha }
          : {}),
      },
    },
  );
}
