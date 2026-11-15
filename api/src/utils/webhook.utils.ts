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
