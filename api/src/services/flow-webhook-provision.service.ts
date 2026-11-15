/**
 * Provider-side webhook provisioning for a flow: create (or update in place)
 * the connector's subscription pointing at the flow's public endpoint, and
 * record the endpoint, signing secret and provider id on `flow.webhookConfig`.
 *
 * The caller persists the flow (file first, then row — RFC #904).
 */
import { Types } from "mongoose";
import type { ProvisionWebhookResult } from "../connectors/base/BaseConnector";
import { SourceConnection, type IFlow } from "../database/workspace-schema";
import { resolveConfiguredEntities } from "../sync-cdc/entity-selection";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { generateWebhookEndpoint } from "../utils/webhook.utils";
import { FlowRequestError } from "./flow-request-error";
import {
  isLoopbackOrPrivateHostname,
  resolveWebhookBaseUrl,
  type RequestContextLike,
} from "./flow-webhook-url";

/** A provision request body: the loose JSON the Triggers step POSTs. */
type ProvisionWebhookBody = Record<string, any>;

export async function provisionFlowWebhook(params: {
  workspaceId: string;
  flow: IFlow;
  body: ProvisionWebhookBody;
  /** The request, for the public origin the endpoint is minted under. */
  request: RequestContextLike;
}) {
  const { workspaceId, flow, body, request } = params;
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

  const requestedPublicBaseUrl =
    typeof body.publicBaseUrl === "string" && body.publicBaseUrl.trim()
      ? body.publicBaseUrl.trim()
      : undefined;

  const endpoint = generateWebhookEndpoint(
    workspaceId,
    flow._id.toString(),
    resolveWebhookBaseUrl(request, requestedPublicBaseUrl),
  );
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
      `Generated webhook endpoint is not publicly reachable: ${endpoint}. Open the app through your public tunnel URL before provisioning, or set PUBLIC_URL/BASE_URL to a public HTTPS origin.`,
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
  // stored secret is known to be wrong.
  const existingSecret = flow.webhookConfig?.secret;
  let created: ProvisionWebhookResult | null = null;
  if (
    existingSecret &&
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
