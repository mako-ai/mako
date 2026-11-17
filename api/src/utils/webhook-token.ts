import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared-secret authentication for inbound webhooks whose connector has no
 * native signature verification.
 *
 * The receiver used to accept ANY JSON body for such flows, so anyone who
 * learned a (workspaceId, flowId) pair — ObjectIds visible in URLs, not
 * secrets — could inject records into a tenant's synced tables. Those flows
 * now fail closed: the sender must present the flow's `webhookConfig.secret`
 * as one of
 *
 *   - `X-Mako-Webhook-Token: <secret>`
 *   - `Authorization: Bearer <secret>`
 *   - `?token=<secret>` (for senders that cannot set headers)
 */
export const WEBHOOK_TOKEN_HEADER = "x-mako-webhook-token";

/**
 * Headers that carry the shared secret and must never be persisted. Claap
 * sends the flow's secret itself in `x-claap-webhook-secret`.
 */
const SECRET_HEADERS = new Set([
  WEBHOOK_TOKEN_HEADER,
  "authorization",
  "x-claap-webhook-secret",
]);

export function presentedWebhookToken(
  headers: Record<string, string | undefined>,
  query: Record<string, string | undefined>,
): string | undefined {
  const lower: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    lower[name.toLowerCase()] = value;
  }
  const direct = lower[WEBHOOK_TOKEN_HEADER]?.trim();
  if (direct) return direct;
  const bearer = lower.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  const fromQuery = query.token?.trim();
  return fromQuery || undefined;
}

/** Constant-time comparison (digests, so lengths never leak or throw). */
export function webhookTokenMatches(
  presented: string | undefined,
  expected: string | undefined | null,
): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * The request headers minus the ones that carry a shared secret: the fixed
 * list, plus `extra` (a connector's declared secret header).
 */
export function redactWebhookSecretHeaders(
  headers: Record<string, string>,
  extra: Iterable<string> = [],
): Record<string, string> {
  const secret = new Set(SECRET_HEADERS);
  for (const name of extra) secret.add(name.toLowerCase());
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = secret.has(name.toLowerCase()) ? "[redacted]" : value;
  }
  return out;
}
