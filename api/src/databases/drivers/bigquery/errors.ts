/**
 * Extract a human-readable message from a Google/BigQuery API error.
 *
 * Handles the two distinct error-body shapes Google returns, both of which the
 * old `error?.response?.data?.error?.message` chain silently dropped:
 *
 * - BigQuery / Google REST API:  `{ error: { code, message, errors: [...] } }`
 *     → `data.error.message` (object shape)
 * - OAuth2 token endpoint:       `{ error: "invalid_grant", error_description }`
 *     → `data.error` is a STRING, so `.message` is `undefined` and the real
 *       reason (e.g. a rotated/disabled service-account key) gets masked as a
 *       generic "Request failed with status code 400".
 *
 * Always includes the HTTP status code so the caller sees 400/401/403 etc.
 */
export function describeGoogleApiError(
  error: unknown,
  fallback: string,
): string {
  const err = error as {
    message?: unknown;
    response?: { status?: number; data?: unknown };
  } | null;
  const status: number | undefined = err?.response?.status;
  const data = err?.response?.data;
  let detail: string | undefined;

  if (data && typeof data === "object") {
    const body = data as { error?: unknown; error_description?: unknown };
    const errField = body.error;
    if (
      errField &&
      typeof errField === "object" &&
      typeof (errField as { message?: unknown }).message === "string"
    ) {
      // BigQuery / Google REST API shape
      detail = (errField as { message: string }).message;
    } else if (typeof errField === "string") {
      // OAuth2 token endpoint shape: { error, error_description }
      const description = body.error_description;
      detail =
        typeof description === "string" && description.trim()
          ? `${errField}: ${description}`
          : errField;
    }
  } else if (typeof data === "string" && data.trim()) {
    detail = data.trim();
  }

  const message =
    detail ||
    (typeof err?.message === "string" && err.message.trim()
      ? err.message
      : fallback);

  return status ? `${message} (HTTP ${status})` : message;
}

/**
 * How a timed-out BigQuery query ended, said accurately.
 *
 * The old message always claimed the query "may still be running", which was
 * true only because nothing tried to stop it. Now that we do, the message has
 * to distinguish the two outcomes — a cancelled job stops scanning and stops
 * billing, and telling someone otherwise sends them hunting a job that is
 * already gone.
 */
export function abandonedSuffix(cancelled: boolean): string {
  return cancelled
    ? " and was cancelled in BigQuery."
    : ". The query may still be running in BigQuery.";
}
