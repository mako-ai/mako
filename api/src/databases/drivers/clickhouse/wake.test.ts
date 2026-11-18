import { describe, expect, it } from "vitest";
import type { IDatabaseConnection } from "../../../database/workspace-schema";
import {
  buildClickHouseClientConfig,
  CLICKHOUSE_INTERACTIVE_WAKE_TIMEOUT_MS,
  CLICKHOUSE_SERVERLESS_WAKE_TIMEOUT_MS,
  isServerlessClickHouseUrl,
  resolveClickHouseWakeTimeoutMs,
} from "./config";
import { connectClickHouse, type ClickHouseConnectDeps } from "./engine";

function connection(fields: Record<string, unknown>): IDatabaseConnection {
  return {
    type: "clickhouse",
    connection: { use_connection_string: false, ...fields },
  } as unknown as IDatabaseConnection;
}

const CLOUD = connection({
  host: "https://abc123.europe-west4.gcp.clickhouse.cloud",
  port: 8443,
  ssl: true,
});
const SELF_HOSTED = connection({ host: "http://10.0.0.5", port: 8123 });

/**
 * A fake ClickHouse that answers `SELECT 1` only once `wakesAt` (fake ms)
 * has passed. Before that every ping waits for its request timeout and fails,
 * like a ClickHouse Cloud service that is still waking.
 */
function fakeServer(opts: { wakesAt: number; error?: string }) {
  let now = 0;
  let created = 0;
  let closed = 0;
  const pings: number[] = [];
  const timeouts: number[] = [];
  const deps: ClickHouseConnectDeps = {
    now: () => now,
    sleep: async ms => {
      now += ms;
    },
    createClient: config => {
      created += 1;
      timeouts.push(config.request_timeout);
      return {
        ping: async () => {
          pings.push(now);
          if (now >= opts.wakesAt) return { success: true };
          now += config.request_timeout;
          return {
            success: false,
            error: new Error(opts.error ?? "Timeout error."),
          };
        },
        close: async () => {
          closed += 1;
        },
      } as never;
    },
  };
  return { deps, pings, timeouts, stats: () => ({ created, closed, now }) };
}

describe("isServerlessClickHouseUrl", () => {
  it("matches ClickHouse Cloud hosts only", () => {
    expect(
      isServerlessClickHouseUrl(
        "https://abc.europe-west4.gcp.clickhouse.cloud:8443",
      ),
    ).toBe(true);
    expect(isServerlessClickHouseUrl("http://10.0.0.5:8123")).toBe(false);
    expect(isServerlessClickHouseUrl("https://clickhouse.example.com")).toBe(
      false,
    );
    expect(isServerlessClickHouseUrl("not a url")).toBe(false);
  });
});

describe("resolveClickHouseWakeTimeoutMs", () => {
  it("defaults to 10 minutes on ClickHouse Cloud and 0 elsewhere", () => {
    const cloud = buildClickHouseClientConfig(CLOUD);
    const self = buildClickHouseClientConfig(SELF_HOSTED);
    expect(resolveClickHouseWakeTimeoutMs(CLOUD, cloud.url)).toBe(
      CLICKHOUSE_SERVERLESS_WAKE_TIMEOUT_MS,
    );
    expect(resolveClickHouseWakeTimeoutMs(SELF_HOSTED, self.url)).toBe(0);
  });

  it("takes the connection's wake_timeout_ms, as a string or a number", () => {
    const url = "https://abc.gcp.clickhouse.cloud:8443";
    expect(
      resolveClickHouseWakeTimeoutMs(connection({ wake_timeout_ms: 0 }), url),
    ).toBe(0);
    expect(
      resolveClickHouseWakeTimeoutMs(
        connection({ wake_timeout_ms: "120000" }),
        "http://10.0.0.5:8123",
      ),
    ).toBe(120_000);
    expect(
      resolveClickHouseWakeTimeoutMs(connection({ wake_timeout_ms: "" }), url),
    ).toBe(CLICKHOUSE_SERVERLESS_WAKE_TIMEOUT_MS);
    expect(
      resolveClickHouseWakeTimeoutMs(connection({ wake_timeout_ms: -5 }), url),
    ).toBe(CLICKHOUSE_SERVERLESS_WAKE_TIMEOUT_MS);
  });
});

describe("connectClickHouse", () => {
  it("waits through a 6-minute Cloud wake and returns a full-timeout client", async () => {
    const server = fakeServer({ wakesAt: 6 * 60_000 });
    const config = buildClickHouseClientConfig(CLOUD);
    const client = await connectClickHouse(
      CLOUD,
      config,
      undefined,
      server.deps,
    );
    expect(client).toBeTruthy();
    const { created, closed, now } = server.stats();
    expect(now).toBeGreaterThanOrEqual(6 * 60_000);
    expect(now).toBeLessThan(CLICKHOUSE_SERVERLESS_WAKE_TIMEOUT_MS);
    // Probes wait at most 30 s; the returned client keeps the 120 s timeout.
    expect(Math.max(...server.timeouts.slice(0, -1))).toBeLessThanOrEqual(
      30_000,
    );
    expect(server.timeouts.at(-1)).toBe(config.request_timeout);
    // Every probe is closed; only the returned client stays open.
    expect(created - closed).toBe(1);
  });

  it("gives up after the wake timeout with a message that says why", async () => {
    const server = fakeServer({ wakesAt: Number.POSITIVE_INFINITY });
    const db = connection({
      host: "https://abc.gcp.clickhouse.cloud",
      port: 8443,
      wake_timeout_ms: 120_000,
    });
    await expect(
      connectClickHouse(
        db,
        buildClickHouseClientConfig(db),
        undefined,
        server.deps,
      ),
    ).rejects.toThrow(/did not answer within 120 s .*asleep or starting/);
    expect(server.stats().now).toBeLessThanOrEqual(120_000 + 30_000);
    expect(server.stats().created).toBe(server.stats().closed);
  });

  it("fails at once on a non-retryable error such as bad credentials", async () => {
    const server = fakeServer({
      wakesAt: Number.POSITIVE_INFINITY,
      error: "Authentication failed: password is incorrect",
    });
    const config = buildClickHouseClientConfig(CLOUD);
    await expect(
      connectClickHouse(CLOUD, config, undefined, server.deps),
    ).rejects.toThrow(/Authentication failed/);
    expect(server.pings).toHaveLength(1);
  });

  it("keeps 3 quick retries off Cloud, and a failed ping now counts as failed", async () => {
    const server = fakeServer({ wakesAt: Number.POSITIVE_INFINITY });
    const config = {
      ...buildClickHouseClientConfig(SELF_HOSTED),
      request_timeout: 10,
    };
    await expect(
      connectClickHouse(SELF_HOSTED, config, undefined, server.deps),
    ).rejects.toThrow(/Timeout error/);
    // 1 try + 3 retries. Before this change a failed ping counted as success.
    expect(server.pings).toHaveLength(4);
  });

  it("stops waiting when the caller aborts", async () => {
    const server = fakeServer({ wakesAt: Number.POSITIVE_INFINITY });
    const controller = new AbortController();
    const deps: ClickHouseConnectDeps = {
      ...server.deps,
      sleep: async () => {
        controller.abort();
        throw new Error("Operation cancelled");
      },
    };
    await expect(
      connectClickHouse(
        CLOUD,
        buildClickHouseClientConfig(CLOUD),
        controller.signal,
        deps,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(server.pings).toHaveLength(1);
  });

  it("caps the wait for an interactive test at 60 s", async () => {
    const server = fakeServer({ wakesAt: Number.POSITIVE_INFINITY });
    await expect(
      connectClickHouse(
        CLOUD,
        buildClickHouseClientConfig(CLOUD),
        undefined,
        server.deps,
        { maxWakeTimeoutMs: CLICKHOUSE_INTERACTIVE_WAKE_TIMEOUT_MS },
      ),
    ).rejects.toThrow(/did not answer within 60 s/);
    // 60 s budget plus at most one 30 s attempt in flight at the deadline.
    expect(server.stats().now).toBeLessThanOrEqual(60_000 + 30_000);
  });

  it("still wakes a service that answers inside the interactive cap", async () => {
    const server = fakeServer({ wakesAt: 20_000 });
    const client = await connectClickHouse(
      CLOUD,
      buildClickHouseClientConfig(CLOUD),
      undefined,
      server.deps,
      { maxWakeTimeoutMs: CLICKHOUSE_INTERACTIVE_WAKE_TIMEOUT_MS },
    );
    expect(client).toBeDefined();
  });

  it("fails at once when the hostname does not resolve", async () => {
    const server = fakeServer({
      wakesAt: Number.POSITIVE_INFINITY,
      error: "getaddrinfo ENOTFOUND wrong.europe-west4.gcp.clickhouse.cloud",
    });
    await expect(
      connectClickHouse(
        CLOUD,
        buildClickHouseClientConfig(CLOUD),
        undefined,
        server.deps,
      ),
    ).rejects.toThrow(/ENOTFOUND/);
    expect(server.pings).toHaveLength(1);
  });

  it("keeps retrying a temporary DNS failure (EAI_AGAIN)", async () => {
    const server = fakeServer({
      wakesAt: Number.POSITIVE_INFINITY,
      error: "getaddrinfo EAI_AGAIN abc.europe-west4.gcp.clickhouse.cloud",
    });
    await expect(
      connectClickHouse(
        CLOUD,
        buildClickHouseClientConfig(CLOUD),
        undefined,
        server.deps,
        { maxWakeTimeoutMs: CLICKHOUSE_INTERACTIVE_WAKE_TIMEOUT_MS },
      ),
    ).rejects.toThrow(/did not answer within 60 s/);
    expect(server.pings.length).toBeGreaterThan(1);
  });
});
