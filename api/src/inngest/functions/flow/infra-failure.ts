/**
 * Which backfill failures are Mako's own, not the connector's.
 *
 * Backfill auto-resume stops after MAX_CONSECUTIVE_FAILURES (10). Before
 * this, every failure counted. On 18 Nov 2026, 3 platform incidents (a
 * half-installed connector runtime, killed sync boxes, revision swaps) took
 * one CH backfill to 5 of 10 without a single connector error. Failures
 * matched here do not count toward the cap. Auto-resume retries them with
 * backoff instead (see infraResumeBackoffMs). A connector's own errors, such
 * as a 401, a bad record or a crash in its code, still count.
 */

const INFRA_FAILURE_PATTERNS: RegExp[] = [
  // The SDK runtime in the box is missing a module: an install problem,
  // never the connector's code (its own imports resolve under connectors/).
  /ERR_MODULE_NOT_FOUND[\s\S]*(?:mako-connectors\/runtime|connector-runtime)\/versions\//,
  /Could not (?:install|stage) the connector (?:Node )?runtime/,
  /Timed out while installing the connector (?:Node )?runtime/,
  /staged connector runtime failed its check/,
  // The box went away under the run.
  /Sandbox \S+ for \S+ was replaced or is gone/,
  /box was replaced during the run/,
  /Connector run cleanup failed/,
  /envd inside it could not be reached/,
  /E2B list did not answer within/,
  /This box cannot isolate connector runs/,
  // No box to lease, or a new one never answered.
  /No connector box for this connection after \d+ s/,
  /A new connector box did not answer its first ping/,
  // The box's memory gate refused a new run (sync-box.ts
  // ConnectorBoxLowMemoryError): too many runs at once, never this one's.
  /MB of memory free; a connector run needs/,
  // The worker died: a revision swap, a crash or an instance shutdown.
  // No bare "SIGTERM" pattern: Mako never writes it into a run error, so
  // that word only reaches here from a connector's own message or stderr.
  /Flow execution abandoned due to worker crash or timeout/,
];

/** Is this failure the platform's, so it must not use up a resume attempt? */
export function isInfrastructureFailure(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  return INFRA_FAILURE_PATTERNS.some(pattern => pattern.test(message));
}

const INFRA_BACKOFF_BASE_MS = 60_000;
const INFRA_BACKOFF_MAX_MS = 30 * 60_000;

/** Wait before resuming after the nth infrastructure failure in a row: 1, 2, 4 … 30 min. */
export function infraResumeBackoffMs(infraFailures: number): number {
  const n = Math.max(1, Math.floor(infraFailures));
  return Math.min(INFRA_BACKOFF_BASE_MS * 2 ** (n - 1), INFRA_BACKOFF_MAX_MS);
}

// Match the structured failure from the Meta creative connector. Do not
// classify arbitrary HTTP 400s or transport failures as provider throttles.
const META_CREATIVE_THROTTLE =
  /\bmeta-ads ad_creatives read failed: HTTP 400: code 80004: subcode 2446079\s*$/;

type ProviderThrottle = { kind: "provider-throttle"; retryAfterMs?: number };

/** Compatibility boundary: boxed reads currently forward only error text. */
export function readProviderThrottle(
  message: string | undefined,
): ProviderThrottle | undefined {
  if (message && META_CREATIVE_THROTTLE.test(message)) {
    return { kind: "provider-throttle" };
  }
}

/** A provider's longer delay wins when the error transport carries one. */
export function providerBackfillRetryAt(
  throttle: ProviderThrottle | undefined,
  now: Date,
): Date | undefined {
  if (!throttle) return undefined;
  const supplied = throttle.retryAfterMs;
  const delay =
    typeof supplied === "number" && Number.isFinite(supplied)
      ? Math.max(INFRA_BACKOFF_MAX_MS, supplied)
      : INFRA_BACKOFF_MAX_MS;
  return new Date(Math.min(now.getTime() + delay, 8.64e15));
}

/** Combine provider cooldown with the existing infrastructure retry policy. */
export function backfillResumeDue(
  state:
    | (NonNullable<Parameters<typeof infraResumeDue>[0]> & {
        providerRetryAt?: Date | null;
      })
    | undefined,
  now: Date,
): boolean {
  const retryAt = state?.providerRetryAt;
  return (!retryAt || now >= retryAt) && infraResumeDue(state, now);
}

/** May an interrupted backfill resume now, given its last infrastructure failure? */
export function infraResumeDue(
  state:
    | { infraFailures?: number | null; lastInfraFailureAt?: Date | null }
    | undefined,
  now: Date,
): boolean {
  const failures = state?.infraFailures ?? 0;
  const at = state?.lastInfraFailureAt;
  if (failures <= 0 || !at) return true;
  return (
    now.getTime() - new Date(at).getTime() >= infraResumeBackoffMs(failures)
  );
}

/**
 * The platform-failure streak a restarted backfill keeps. A resume of the
 * same run (runId reused) keeps it, so the backoff grows 1, 2, 4 … 30 min.
 * A new run starts at zero.
 */
export function carriedInfraBackoff(
  state:
    | { infraFailures?: number | null; lastInfraFailureAt?: Date | null }
    | undefined,
  reusedRunId: boolean,
): { infraFailures: number; lastInfraFailureAt?: Date } {
  if (!reusedRunId) return { infraFailures: 0 };
  return {
    infraFailures: state?.infraFailures ?? 0,
    lastInfraFailureAt: state?.lastInfraFailureAt ?? undefined,
  };
}
