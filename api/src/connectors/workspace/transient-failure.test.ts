import { describe, expect, it } from "vitest";
import {
  INDEX_RETRY_MAX_MS,
  indexRetryDelayMs,
  isTransientIndexFailure,
  nextIndexRetry,
} from "./transient-failure";

describe("isTransientIndexFailure", () => {
  it.each([
    // ws:cloudflare-billing, 18 Nov 2026.
    "[unavailable] The sandbox is running but port is not open: The sandbox is running but envd inside it could not be reached (e.g. its network is down). Check the sandbox state with 'Sandbox.getInfo()'.",
    "Sandbox ix4jt4l5niwopbimyvwa4 for connector-sync:v2:6846e6a01b05af0948070582 was replaced or is gone.",
    "The connector's box was replaced during the run; its output is missing.",
    "Connector run cleanup failed: cleanup timed out",
    "No connector box for this connection after 120 s. 3 runs are waiting.",
    "A new connector box did not answer its first ping.",
    "E2B list did not answer within 10000 ms",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/lib/mako-connectors/runtime/versions/afaf3869/node_modules/@makoai/connector-sdk/src/run.js' imported from /var/lib/mako-connectors/runtime/versions/afaf3869/node_modules/@makoai/connector-sdk/bin/mako-connector.js",
    "Could not install the connector Node runtime: curl: (28) timed out",
    "Timed out while installing the connector runtime.",
    "Could not read the connector registry to resolve mako/stripe@^1: 503",
  ])("retries on the platform's error: %s", message => {
    expect(isTransientIndexFailure(message)).toBe(true);
  });

  it.each([
    "The connector's default export is not a defineConnector(...) result.",
    'spec failed: entity "leads" has no fields',
    // The connector's own import, not the SDK runtime's.
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/lib/mako-connectors/runtime/versions/afaf3869/connectors/acme@abc/helpers.ts' imported from /var/lib/mako-connectors/runtime/versions/afaf3869/connectors/acme@abc/connector.ts",
    "SyntaxError: Unexpected token '}'",
    "The connector timed out.",
    "",
  ])("blocks on the connector's own error: %s", message => {
    expect(isTransientIndexFailure(message)).toBe(false);
  });

  it("treats a missing message as the connector's", () => {
    expect(isTransientIndexFailure(undefined)).toBe(false);
    expect(isTransientIndexFailure(null)).toBe(false);
  });
});

describe("index retry backoff", () => {
  it("waits 1, 2, 4, 8, 16, then 30 min forever", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(indexRetryDelayMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000,
      1_800_000,
    ]);
    expect(indexRetryDelayMs(1000)).toBe(INDEX_RETRY_MAX_MS);
  });

  it("counts the attempt and schedules the next", () => {
    const now = new Date("2026-11-18T11:00:00Z");
    expect(nextIndexRetry(undefined, now)).toEqual({
      indexRetryAttempts: 1,
      nextIndexRetryAt: new Date("2026-11-18T11:01:00Z"),
    });
    expect(nextIndexRetry(2, now)).toEqual({
      indexRetryAttempts: 3,
      nextIndexRetryAt: new Date("2026-11-18T11:04:00Z"),
    });
  });
});
