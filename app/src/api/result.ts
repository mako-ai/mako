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

function errorMessage(res: ApiResult): string {
  return (
    (res.error as { error?: string } | undefined)?.error ||
    `HTTP error! status: ${res.response.status}`
  );
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
