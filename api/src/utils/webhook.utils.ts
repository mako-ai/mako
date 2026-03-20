import { v4 as uuidv4 } from "uuid";
import { loggers } from "../logging";

const logger = loggers.inngest("webhook");
const LOCAL_WEBHOOK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

type ResolveWebhookBaseUrlOptions = {
  requestUrl?: string;
  forwardedProto?: string | null;
  forwardedHost?: string | null;
  host?: string | null;
};

function normalizeBaseUrl(baseUrl?: string | null): string | null {
  if (!baseUrl) {
    return null;
  }
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

function getUrlHostname(urlString: string): string | null {
  try {
    return new URL(urlString).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalWebhookBaseUrl(baseUrl?: string | null): boolean {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return false;
  }
  const hostname = getUrlHostname(normalized);
  if (!hostname) {
    return false;
  }
  return LOCAL_WEBHOOK_HOSTS.has(hostname);
}

export function resolveWebhookBaseUrl(
  options: ResolveWebhookBaseUrlOptions = {},
): string {
  const envBaseUrl = normalizeBaseUrl(
    process.env.WEBHOOK_BASE_URL ||
      process.env.API_BASE_URL ||
      process.env.BASE_URL ||
      process.env.PUBLIC_URL,
  );

  const forwardedHost = options.forwardedHost?.split(",")[0]?.trim();
  const forwardedProto = options.forwardedProto?.split(",")[0]?.trim();
  const requestHost = options.host?.split(",")[0]?.trim();

  const forwardedOrigin =
    forwardedHost && forwardedHost.length > 0
      ? normalizeBaseUrl(`${forwardedProto || "https"}://${forwardedHost}`)
      : null;

  let requestOrigin: string | null = null;
  if (options.requestUrl) {
    try {
      requestOrigin = normalizeBaseUrl(new URL(options.requestUrl).origin);
    } catch {
      requestOrigin = null;
    }
  }

  const requestDerivedBaseUrl = forwardedOrigin || requestOrigin;

  if (
    requestDerivedBaseUrl &&
    (!envBaseUrl || isLocalWebhookBaseUrl(envBaseUrl))
  ) {
    return requestDerivedBaseUrl;
  }

  if (envBaseUrl) {
    return envBaseUrl;
  }

  if (requestDerivedBaseUrl) {
    return requestDerivedBaseUrl;
  }

  if (requestHost && requestHost.length > 0) {
    return `${forwardedProto || "http"}://${requestHost}`;
  }

  return "http://localhost:3001";
}

/**
 * Generate a unique webhook endpoint path
 */
export function generateWebhookEndpoint(
  workspaceId: string,
  flowId: string,
  baseUrlOverride?: string,
): string {
  const baseUrl = normalizeBaseUrl(baseUrlOverride) || resolveWebhookBaseUrl();
  return `${baseUrl}/api/webhooks/${workspaceId}/${flowId}`;
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
 * Format webhook stats for display
 */
export function formatWebhookStats(flow: any): {
  lastReceived: string;
  totalReceived: number;
  receivedToday: number;
  successRate: number;
} {
  const lastReceived = flow.webhookConfig?.lastReceivedAt
    ? new Date(flow.webhookConfig.lastReceivedAt).toLocaleString()
    : "Never";

  const totalReceived = flow.webhookConfig?.totalReceived || 0;

  // TODO: Calculate receivedToday from webhook events collection
  const receivedToday = 0;

  // TODO: Calculate success rate from webhook events
  const successRate = 100;

  return {
    lastReceived,
    totalReceived,
    receivedToday,
    successRate,
  };
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
