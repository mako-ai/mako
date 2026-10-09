/**
 * Starting a workflow from outside Mako: each workflow has one URL, and a
 * POST to it starts a run with the request's JSON as input.
 *
 * The URL carries its own secret, derived from the installation's
 * SESSION_SECRET, so nothing is stored and a sender that cannot set headers
 * (most webhook senders) can still call it. Rotating SESSION_SECRET changes
 * every URL.
 */
import { createHmac, timingSafeEqual } from "crypto";

function secretOf(workspaceId: string, name: string): string | null {
  const key = process.env.SESSION_SECRET;
  if (!key) return null;
  return createHmac("sha256", key)
    .update(`workflow-webhook:${workspaceId}:${name}`)
    .digest("hex")
    .slice(0, 32);
}

/** The URL that starts `name`, or null when the installation cannot sign one. */
export function webhookUrl(workspaceId: string, name: string): string | null {
  const secret = secretOf(workspaceId, name);
  if (!secret) return null;
  const base = (
    process.env.API_BASE_URL ||
    process.env.BASE_URL ||
    process.env.PUBLIC_URL ||
    "http://localhost:8080"
  ).replace(/\/+$/, "");
  return `${base}/api/workflows/hooks/${workspaceId}/${name}/${secret}`;
}

export function isWebhookSecret(
  workspaceId: string,
  name: string,
  given: string,
): boolean {
  const expected = Buffer.from(secretOf(workspaceId, name) ?? "");
  const actual = Buffer.from(given);
  return (
    expected.length > 0 &&
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}
