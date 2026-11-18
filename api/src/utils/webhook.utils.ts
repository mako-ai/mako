/**
 * A flow's inbound webhook URL, from server configuration only.
 *
 * Never from a request: a Host or X-Forwarded-Host header is the caller's to
 * set, and a provider subscription pointed at the URL would stream signed
 * events to whatever host it names. WEBHOOK_PUBLIC_BASE_URL (a dev tunnel,
 * a dedicated hook host) wins, then the deployment's own base URL.
 */
export function generateWebhookEndpoint(
  workspaceId: string,
  flowId: string,
): string {
  const resolvedBaseUrl =
    process.env.WEBHOOK_PUBLIC_BASE_URL ||
    process.env.API_BASE_URL ||
    process.env.BASE_URL ||
    process.env.PUBLIC_URL ||
    "http://localhost:8080";
  const normalizedBaseUrl = resolvedBaseUrl.replace(/\/+$/, "");
  return `${normalizedBaseUrl}/api/webhooks/${workspaceId}/${flowId}`;
}
