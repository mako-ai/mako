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

const GIB = 1024 ** 3;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * GIB) {
    return `${Number((bytes / (1024 * GIB)).toFixed(1))} TiB`;
  }
  if (bytes >= GIB) return `${Number((bytes / GIB).toFixed(1))} GiB`;
  return `${Number((bytes / 1024 ** 2).toFixed(1))} MiB`;
}

/**
 * BigQuery's refusal of a job over its `maximumBytesBilled`, reworded for
 * whoever has to change the query; null for any other error. BigQuery says
 * "Query exceeded limit for bytes billed: 1000. 10485760 or higher required."
 */
export function describeBytesBilledCap(
  error: string | undefined,
  capBytes: number,
): string | null {
  if (
    !error ||
    !/limit for bytes billed|bytesBilledLimitExceeded/i.test(error)
  ) {
    return null;
  }
  const required = Number(error.match(/(\d+) or higher required/)?.[1]);
  const scan =
    Number.isFinite(required) && required > 0
      ? `would bill ${formatBytes(required)}`
      : "would bill more";
  return `This query ${scan} on BigQuery, over the ${formatBytes(capBytes)} cap on agent and MCP queries, so it did not run and cost nothing. Read fewer bytes: filter on the table's partition column, select only the columns you need, or narrow the date range. For a query that has to read this much, use a console (create_console, run_console): consoles are not capped. An operator can change the cap with AGENT_BIGQUERY_MAX_BYTES_BILLED.`;
}
