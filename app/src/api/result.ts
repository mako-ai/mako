/**
 * Helpers for consuming `openapi-fetch` results in stores.
 *
 * `openapi-fetch` returns `{ data, error, response }` and never throws. These
 * adapters reproduce the legacy `apiClient` contract (throw on transport/HTTP
 * error) and unwrap the standard `{ success, data }` envelope, while leaving
 * the path/param/body type-checking intact at the call site.
 */
export interface ApiResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanMessage(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorMessageFrom(value: unknown): string | null {
  const direct = cleanMessage(value);
  if (direct) return direct;

  if (value instanceof Error) {
    return cleanMessage(value.message);
  }

  if (!isRecord(value)) return null;

  const primary =
    cleanMessage(value.error) ??
    cleanMessage(value.message) ??
    cleanMessage(value.detail) ??
    cleanMessage(value.title) ??
    cleanMessage(value.reason);

  const code = cleanMessage(value.code);
  if (primary && code && !primary.includes(code)) {
    return `${primary} (${code})`;
  }
  if (primary) return primary;
  if (code) return code;

  const issues = value.issues;
  if (Array.isArray(issues)) {
    const issue = issues.find(isRecord);
    const issueMessage =
      issue &&
      (cleanMessage(issue.message) ??
        cleanMessage(issue.error) ??
        cleanMessage(issue.code));
    if (issueMessage) return issueMessage;
  }

  const nested = errorMessageFrom(value.data);
  if (nested) return nested;

  if (Object.keys(value).length > 0) {
    try {
      return `Request failed with response: ${JSON.stringify(value)}`;
    } catch {
      return "Request failed with an unreadable error response";
    }
  }

  return null;
}

function errorMessage(res: ApiResult): string {
  const parsedMessage =
    errorMessageFrom(res.error) ?? errorMessageFrom(res.data);
  if (parsedMessage) return parsedMessage;

  const statusLabel = [res.response.status, res.response.statusText]
    .filter(Boolean)
    .join(" ");
  if (statusLabel) {
    return `Request failed with ${statusLabel} and no error body`;
  }
  return "Request failed before receiving a valid HTTP status or error body";
}

/**
 * Throws on transport/HTTP error; otherwise returns the parsed body as the
 * `{ success, data }` envelope with `data` typed as `unknown` (callers assert
 * their domain type — the API DTO is a structural subset).
 */
export function unwrap(res: ApiResult): { data?: unknown } {
  if (res.error || !res.response.ok) {
    throw new Error(errorMessage(res));
  }
  return (res.data ?? {}) as { data?: unknown };
}

/** Throws on error; returns the raw response body as `unknown` (no envelope). */
export function unwrapBody(res: ApiResult): unknown {
  if (res.error || !res.response.ok) {
    throw new Error(errorMessage(res));
  }
  return res.data;
}
