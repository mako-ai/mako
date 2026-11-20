/**
 * Helpers for pointing BigQuery clients at a local emulator
 * (e.g. ghcr.io/goccy/bigquery-emulator) during local dev / integration tests.
 *
 * When a BigQuery connection's `api_base_url` resolves to a localhost host, both
 * client stacks treat it as an emulator:
 *  - the custom Axios REST client skips the JWT/OAuth token exchange and sends a
 *    dummy bearer (the emulator ignores auth);
 *  - the `@google-cloud/bigquery` SDK (CDC Parquet load path) is given an
 *    explicit `apiEndpoint` on that client only, so it also skips auth. No
 *    process env var is written.
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

/** `host[:port]` form of the emulator address. */
export function bigQueryEmulatorHostPort(apiBaseUrl: string): string {
  const url = toUrl(apiBaseUrl);
  if (!url) return apiBaseUrl;
  return url.host;
}

/**
 * Refuses an `api_base_url` a tenant could use to aim Mako's BigQuery client
 * at an internal or foreign host. Checked at call time, so a test can flip
 * NODE_ENV.
 *
 * - Not production: anything is allowed (local emulator, test doubles).
 * - Production: only an https `*.googleapis.com` host (bigquery.googleapis.com,
 *   bigquery.<region>.rep.googleapis.com). Loopback, private and foreign
 *   hosts are refused. A missing value means the default Google endpoint.
 */
export function assertBigQueryApiBaseUrl(apiBaseUrl?: string): void {
  if (process.env.NODE_ENV !== "production") return;
  const raw = apiBaseUrl?.trim();
  if (!raw) return;
  if (isLocalBigQueryEmulator(raw)) {
    throw new Error(
      "BigQuery: a local api_base_url is not allowed in production.",
    );
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error("BigQuery: api_base_url is not a valid URL.");
  }
  const host = url.hostname.toLowerCase();
  const isGoogleHost =
    host === "googleapis.com" || host.endsWith(".googleapis.com");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !isGoogleHost
  ) {
    throw new Error(
      "BigQuery: in production api_base_url must be an https *.googleapis.com address.",
    );
  }
}
