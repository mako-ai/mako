import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * getMaxTrackingValue: a failed query is a failure, never "no data".
 *
 * Drivers return `{ success: false }` for a failed query instead of throwing
 * (databases/checked-query.ts). This used to fall through to
 * `{ success: true, maxValue: undefined }`, so an incremental poll read a
 * warehouse hiccup as an empty table and re-fetched the whole entity.
 */

const { executeQuery } = vi.hoisted(() => ({ executeQuery: vi.fn() }));
vi.mock("../../databases/registry", () => ({
  databaseRegistry: {
    getDriver: () => ({
      executeQuery,
      quoteIdentifier: (n: string) => `\`${n}\``,
    }),
  },
}));

import { getMaxTrackingValue } from "./query-introspection";

const conn = { type: "bigquery" } as any;

describe("getMaxTrackingValue", () => {
  beforeEach(() => executeQuery.mockReset());

  it("returns the max value", async () => {
    executeQuery.mockResolvedValue({
      success: true,
      data: [{ max_value: "2026-11-17T14:59:30.000Z" }],
    });
    expect(await getMaxTrackingValue(conn, "t", "_syncedAt", "s")).toEqual({
      success: true,
      maxValue: "2026-11-17T14:59:30.000Z",
    });
  });

  it("an empty table is success with no value", async () => {
    executeQuery.mockResolvedValue({
      success: true,
      data: [{ max_value: null }],
    });
    expect(await getMaxTrackingValue(conn, "t", "_syncedAt", "s")).toEqual({
      success: true,
      maxValue: undefined,
    });
  });

  it("a missing table is a failure carrying the driver's error", async () => {
    executeQuery.mockResolvedValue({
      success: false,
      error: "Not found: Table realadvisor-prod:s.t",
    });
    expect(await getMaxTrackingValue(conn, "t", "_syncedAt", "s")).toEqual({
      success: false,
      error: "Not found: Table realadvisor-prod:s.t",
    });
  });

  it("a transient error is a failure, not an empty table", async () => {
    executeQuery.mockResolvedValue({
      success: false,
      error: "rateLimitExceeded",
    });
    const result = await getMaxTrackingValue(conn, "t", "_syncedAt", "s");
    expect(result.success).toBe(false);
    expect(result.error).toBe("rateLimitExceeded");
  });

  it("keeps a MongoDB destination's failed SQL probe as no value", async () => {
    executeQuery.mockResolvedValue({ success: false, error: "not SQL" });
    expect(
      await getMaxTrackingValue({ type: "mongodb" } as any, "t", "_syncedAt"),
    ).toEqual({ success: true, maxValue: undefined });
  });
});
