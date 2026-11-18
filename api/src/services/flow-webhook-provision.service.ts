/**
 * Provider-side webhook provisioning for a flow: create (or update in place)
 * the connector's subscription pointing at the flow's public endpoint, and
 * record the endpoint, signing secret and provider id on `flow.webhookConfig`.
 *
 * The endpoint is the server's (generateWebhookEndpoint), never a request's
 * host. The caller persists the flow: `persistProvisionedWebhook` writes the
 * subscription id and secret to the row first, so a failed commit never
 * orphans a live subscription; then the file, then the row (RFC #904).
 */
import { Types } from "mongoose";
import type { ProvisionWebhookResult } from "../connectors/base/BaseConnector";
import {
  Flow,
  SourceConnection,
  type IFlow,
} from "../database/workspace-schema";
import { resolveConfiguredEntities } from "../sync-cdc/entity-selection";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { generateWebhookEndpoint } from "../utils/webhook.utils";
import { FlowRequestError } from "./flow-request-error";
import { isLoopbackOrPrivateHostname } from "./flow-webhook-url";

/** A provision request body: the loose JSON the Triggers step POSTs. */
type ProvisionWebhookBody = Record<string, any>;

export async function provisionFlowWebhook(params: {
  workspaceId: string;
  flow: IFlow;
  body: ProvisionWebhookBody;
}) {
  const { workspaceId, flow, body } = params;
  if (!flow.dataSourceId) {
    throw new FlowRequestError(
      400,
      "Webhook provisioning requires a connector data source",
    );
  }

  const connectorSource = await SourceConnection.findOne({
    _id: new Types.ObjectId(String(flow.dataSourceId)),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!connectorSource) {
    throw new FlowRequestError(404, "Connector not found");
  }

  const decryptedConnectorSource =
    await sourceConnectionManager.getSourceConnection(
      connectorSource._id.toString(),
    );
  if (!decryptedConnectorSource) {
    throw new FlowRequestError(
      404,
      "Connector configuration could not be loaded",
    );
  }

  const connector = await syncConnectorRegistry.getConnectorFor(
    decryptedConnectorSource,
  );
  if (!connector || !connector.supportsWebhooks()) {
    throw new FlowRequestError(
      400,
      "Selected connector does not support webhooks",
    );
  }
  if (!connector.supportsWebhookProvisioning()) {
    throw new FlowRequestError(
      400,
      "Selected connector does not support automatic webhook provisioning",
    );
  }

  const endpoint = generateWebhookEndpoint(workspaceId, flow._id.toString());
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new FlowRequestError(
      400,
      `Generated webhook endpoint is invalid: ${endpoint}`,
    );
  }

  if (isLoopbackOrPrivateHostname(parsedEndpoint.hostname)) {
    throw new FlowRequestError(
      400,
      `Generated webhook endpoint is not publicly reachable: ${endpoint}. Set WEBHOOK_PUBLIC_BASE_URL (a public tunnel in development) or BASE_URL to a public HTTPS origin.`,
    );
  }
  const requestedEvents = Array.isArray(body.events)
    ? body.events
        .filter((event: unknown): event is string => typeof event === "string")
        .map((event: string) => event.trim())
        .filter(Boolean)
    : undefined;

  const { entities: enabledEntities } = resolveConfiguredEntities(flow);

  // Re-provisioning an already-provisioned flow updates its existing
  // subscription in place (same URL, same signing secret) instead of
  // creating a second endpoint that would POST with a secret the flow no
  // longer holds. `recreate: true` forces a fresh endpoint, e.g. when the
  // stored secret is known to be wrong. `adopt: true` (flow_webhook_provision)
  // also looks the URL up when the flow holds no secret yet, so a
  // subscription already there is adopted rather than duplicated.
  const existingSecret = flow.webhookConfig?.secret;
  let created: ProvisionWebhookResult | null = null;
  if (
    (existingSecret || body.adopt === true) &&
    body.recreate !== true &&
    connector.supportsWebhookSubscriptionUpdate()
  ) {
    created = await connector.updateWebhookSubscription({
      endpointUrl: endpoint,
      verifySsl: body.verifySsl !== false,
      events: requestedEvents,
      enabledEntities,
      providerWebhookId: flow.webhookConfig?.providerWebhookId,
    });
  }
  if (!created) {
    created = await connector.createWebhookSubscription({
      endpointUrl: endpoint,
      verifySsl: body.verifySsl !== false,
      events: requestedEvents,
      enabledEntities,
    });
  }

  if (!flow.webhookConfig) {
    flow.webhookConfig = {
      endpoint,
      secret: "",
      totalReceived: 0,
      enabled: true,
    };
  }
  const webhookConfig = flow.webhookConfig;
  if (!webhookConfig) {
    throw new Error("Failed to initialize webhook configuration");
  }
  webhookConfig.endpoint = endpoint;
  if (webhookConfig.enabled === undefined) {
    webhookConfig.enabled = true;
  }
  if (created.signingSecret) {
    webhookConfig.secret = created.signingSecret;
  }
  webhookConfig.providerWebhookId = created.providerWebhookId;

  return {
    endpoint,
    created,
    webhookConfig,
    connectorType: connectorSource.type,
  };
}

/**
 * Write a fresh subscription's id, endpoint and secret to the row now, before
 * the flow file is committed: the provider already holds the subscription,
 * and a failed commit must not leave the only copy of its secret in memory.
 */
export async function persistProvisionedWebhook(
  flow: IFlow,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const config = flow.webhookConfig;
  if (!config) return;
  await Flow.updateOne(
    { _id: flow._id, workspaceId: flow.workspaceId },
    {
      $set: {
        "webhookConfig.endpoint": config.endpoint,
        "webhookConfig.providerWebhookId": config.providerWebhookId,
        ...(config.secret ? { "webhookConfig.secret": config.secret } : {}),
        ...extra,
      },
    },
  );
}

/** A provisioning claim older than this is taken to have died. */
export const PROVISION_CLAIM_MS = 10 * 60 * 1000;

/** The update that releases a claim, for `persistProvisionedWebhook`. */
export const RELEASE_PROVISION_CLAIM = {
  "webhookConfig.provisioningAt": null,
};

/**
 * Claim the right to create a flow's subscription, atomically: only a flow
 * with no provisioning in flight (or one stale for PROVISION_CLAIM_MS) is
 * taken, so concurrent calls and retries create one subscription at most.
 * `unprovisionedOnly` (flow_webhook_provision) also requires no subscription
 * id and no secret; the "Create in …" button may re-provision.
 * Returns the claimed flow, or null when the claim was refused.
 */
export async function claimWebhookProvision(params: {
  flowId: Types.ObjectId | string;
  workspaceId: string;
  unprovisionedOnly: boolean;
}) {
  const stale = new Date(Date.now() - PROVISION_CLAIM_MS);
  return Flow.findOneAndUpdate(
    {
      _id: new Types.ObjectId(String(params.flowId)),
      workspaceId: new Types.ObjectId(params.workspaceId),
      ...(params.unprovisionedOnly
        ? {
            "webhookConfig.providerWebhookId": { $in: [null, ""] },
            "webhookConfig.secret": { $in: [null, ""] },
          }
        : {}),
      $or: [
        { "webhookConfig.provisioningAt": null },
        { "webhookConfig.provisioningAt": { $lt: stale } },
      ],
    },
    { $set: { "webhookConfig.provisioningAt": new Date() } },
    { returnDocument: "after" },
  );
}

/** Give a claim back after a failed provisioning. */
export async function releaseWebhookProvision(
  flowId: Types.ObjectId | string,
): Promise<void> {
  await Flow.updateOne(
    { _id: new Types.ObjectId(String(flowId)) },
    { $set: RELEASE_PROVISION_CLAIM },
  );
}
