/**
 * Helpers for pointing BigQuery clients at a local emulator
 * (e.g. ghcr.io/goccy/bigquery-emulator) during local dev / integration tests.
 *
 * When a BigQuery connection's `api_base_url` resolves to a localhost host, both
 * client stacks treat it as an emulator:
 *  - the custom Axios REST client skips the JWT/OAuth token exchange and sends a
 *    dummy bearer (the emulator ignores auth);
 *  - the `@google-cloud/bigquery` SDK (CDC Parquet load path) is given an
 *    explicit `apiEndpoint` and `BIGQUERY_EMULATOR_HOST` so it also skips auth.
 *
 * This keeps real-GCP behavior unchanged (non-local hosts are never treated as
 * an emulator) while enabling fully offline local testing.
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function toUrl(apiBaseUrl: string): URL | undefined {
  const trimmed = apiBaseUrl.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return undefined;
  }
}

/** True when `apiBaseUrl` points at a local BigQuery emulator host. */
export function isLocalBigQueryEmulator(apiBaseUrl?: string): boolean {
  if (!apiBaseUrl) return false;
  const url = toUrl(apiBaseUrl);
  if (!url) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOCAL_HOSTNAMES.has(host);
}

/** Normalized `scheme://host[:port]` (no path) for the SDK `apiEndpoint`. */
export function bigQueryEmulatorEndpoint(apiBaseUrl: string): string {
  const url = toUrl(apiBaseUrl);
  if (!url) return apiBaseUrl;
  return `${url.protocol}//${url.host}`;
}

/** `host[:port]` form for the SDK's `BIGQUERY_EMULATOR_HOST` env var. */
export function bigQueryEmulatorHostPort(apiBaseUrl: string): string {
  const url = toUrl(apiBaseUrl);
  if (!url) return apiBaseUrl;
  return url.host;
}
