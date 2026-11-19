/**
 * Which connector indexing failures are the platform's, not the connector's.
 *
 * A push runs each changed connector's `spec` in a sandbox. Before this, any
 * failure set a sticky `blocked`, and only a new push cleared it. On 18 Nov
 * 2026 ws:cloudflare-billing stayed blocked on "[unavailable] … envd inside
 * it could not be reached", a sandbox blip during indexing, until someone
 * pushed a no-op commit. Failures matched here set `retrying` instead, and
 * indexing tries again on its own (see nextIndexRetry). A connector's own
 * errors, such as an invalid spec, a failed build or an import of its own
 * code that fails, still block.
 */

const TRANSIENT_PATTERNS: RegExp[] = [
  // E2B's own status for a box it cannot reach.
  /\[unavailable\]/,
  /envd inside it could not be reached/,
  /The sandbox is running but port is not open/,
  /E2B list did not answer within/,
  // The box went away under the command.
  /Sandbox \S+ for \S+ was replaced or is gone/,
  /box was replaced during the run/,
  /Connector run cleanup failed/,
  /This box cannot isolate connector runs/,
  // The box's memory gate refused a new run (ConnectorBoxLowMemoryError).
  /MB of memory free; a connector run needs/,
  // No box to lease, or a new one never answered.
  /No connector box for this connection after \d+ s/,
  /A new connector box did not answer its first ping/,
  // The SDK runtime in the box, not the connector's code.
  /ERR_MODULE_NOT_FOUND[\s\S]*(?:mako-connectors\/runtime|connector-runtime)\/versions\/[^/]+\/node_modules\/@makoai\//,
  /Could not (?:install|stage) the connector (?:Node )?runtime/,
  /Timed out while installing the connector (?:Node )?runtime/,
  // Object storage (registry catalog, bundles) was down, not wrong.
  /Could not read the connector registry/,
  // A bundle build that the platform failed: the pinned esbuild install,
  // or npm ci that timed out or lost the registry. esbuild errors and
  // dependency resolution (E404, ERESOLVE) are the connector's and block.
  /Could not install the bundler/,
  /npm ci timed out after/,
  /npm ci failed:[\s\S]*\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|ERR_SOCKET_TIMEOUT|E50[0234])\b/,
];

/** Is this indexing failure the platform's, so it must retry, not block? */
export function isTransientIndexFailure(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  return TRANSIENT_PATTERNS.some(pattern => pattern.test(message));
}

const RETRY_BASE_MS = 60_000;
/** The backoff's ceiling, and the period of the retries that follow it. */
export const INDEX_RETRY_MAX_MS = 30 * 60_000;

/** Wait before retry n (1-based): 1, 2, 4, 8, 16, then every 30 min. */
export function indexRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(RETRY_BASE_MS * 2 ** (n - 1), INDEX_RETRY_MAX_MS);
}

/** The retry fields for a row that just failed transiently. */
export function nextIndexRetry(
  previousAttempts: number | undefined,
  now: Date,
): { indexRetryAttempts: number; nextIndexRetryAt: Date } {
  const attempts = (previousAttempts ?? 0) + 1;
  return {
    indexRetryAttempts: attempts,
    nextIndexRetryAt: new Date(now.getTime() + indexRetryDelayMs(attempts)),
  };
}
