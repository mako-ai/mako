import { v4 as uuidv4 } from "uuid";
import { loggers } from "../logging";

const logger = loggers.inngest("webhook");

/**
 * Generate a unique webhook endpoint path
 */
export function generateWebhookEndpoint(
  workspaceId: string,
  flowId: string,
  baseUrl?: string,
): string {
  const resolvedBaseUrl =
    baseUrl ||
    process.env.API_BASE_URL ||
    process.env.BASE_URL ||
    process.env.PUBLIC_URL ||
    "http://localhost:8080";
  const normalizedBaseUrl = resolvedBaseUrl.replace(/\/+$/, "");
  return `${normalizedBaseUrl}/api/webhooks/${workspaceId}/${flowId}`;
}

/**
 * @deprecated Use connector.verifyWebhook() instead
 * Verify webhook signature for different providers
 */
export function verifyWebhookSignature(
  _provider: string,
  _payload: string | Buffer,
  _signature: string,
  _secret: string,
): boolean {
  // This function is deprecated - webhook verification should be done
  // through the connector's verifyWebhook() method
  logger.warn(
    "verifyWebhookSignature is deprecated. Use connector.verifyWebhook() instead.",
  );
  return true;
}

/**
 * @deprecated Use connector.extractWebhookData() and connector.getWebhookEventMapping() instead
 * Parse webhook payload to extract entity ID and type
 */
export function parseWebhookPayload(
  provider: string,
  payload: any,
): {
  entityId: string;
  entityType: string;
  operation: "create" | "update" | "delete";
} {
  // This function is deprecated - webhook data extraction should be done
  // through the connector's extractWebhookData() and getWebhookEventMapping() methods
  logger.warn(
    "parseWebhookPayload is deprecated. Use connector methods instead.",
  );

  return {
    entityId: payload.id || payload.data?.id || uuidv4(),
    entityType: payload.type || payload.entity || "unknown",
    operation: "update",
  };
}
