import { describe, expect, it } from "vitest";
import {
  buildEntityRows,
  configuredEntityNames,
  entityBackfillChip,
  entityLabel,
  entityStreamChip,
  entityTotals,
  formatLag,
  formatLog,
} from "./backfill-helpers";

describe("formatLag", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatLag(null)).toBe("—");
    expect(formatLag(Number.NaN)).toBe("—");
    expect(formatLag(42)).toBe("42s");
    expect(formatLag(120)).toBe("2m");
    expect(formatLag(125)).toBe("2m 5s");
    expect(formatLag(7200)).toBe("2h");
    expect(formatLag(7260)).toBe("2h 1m");
  });
});

describe("entityLabel", () => {
  it("turns parent:subEntity into sub_entity_parent", () => {
    expect(entityLabel("customers")).toBe("customers");
    expect(entityLabel("invoices:lineItems")).toBe("line_items_invoices");
  });
});

describe("entity chips", () => {
  it("stream chip: syncing, live, pending", () => {
    expect(
      entityStreamChip({ backlogCount: 3, lastMaterializedAt: null }, "active")
        .label,
    ).toBe("Syncing");
    expect(
      entityStreamChip(
        { backlogCount: 0, lastMaterializedAt: null, backfillDone: true },
        "active",
      ).label,
    ).toBe("Live");
    expect(
      entityStreamChip(
        { backlogCount: 0, lastMaterializedAt: null, backfillDone: true },
        "paused",
      ).label,
    ).toBe("Pending");
  });

  it("backfill chip: done, in progress, not started", () => {
    expect(entityBackfillChip({ backlogCount: 0, backfillDone: true })).toEqual(
      { label: "Done", color: "success" },
    );
    expect(entityBackfillChip({ backlogCount: 2 }).label).toBe("In progress");
    expect(entityBackfillChip({ backlogCount: 0 }).label).toBe("Not started");
  });
});

describe("formatLog", () => {
  it("prefixes the entity and appends row counts", () => {
    expect(
      formatLog({
        timestamp: "t",
        level: "info",
        message: "Wrote batch",
        metadata: { entity: "a:b", totalWritten: 1000, totalFetched: 2000 },
      }),
    ).toBe("[b_a] Wrote batch (1,000 written / 2,000 fetched)");
  });

  it("adds request details to warnings and errors only", () => {
    const metadata = {
      status: 429,
      method: "GET",
      endpoint: "/v1/things",
      error: "rate limited",
      requestId: "req_1",
    };
    expect(
      formatLog({
        timestamp: "t",
        level: "error",
        message: "Failed",
        metadata,
      }),
    ).toBe(
      "Failed - status=429 | GET /v1/things | error=rate limited | requestId=req_1",
    );
    expect(
      formatLog({ timestamp: "t", level: "info", message: "Failed", metadata }),
    ).toBe("Failed");
  });
});

describe("configuredEntityNames", () => {
  it("prefers enabled layouts, then the entity filter", () => {
    expect(
      configuredEntityNames({
        entityLayouts: [
          { entity: "a" },
          { entity: "b", enabled: false },
          { entity: "c", enabled: true },
        ],
        entityFilter: ["x"],
      }),
    ).toEqual(["a", "c"]);
    expect(configuredEntityNames({ entityFilter: ["x", " ", "y"] })).toEqual([
      "x",
      "y",
    ]);
    expect(configuredEntityNames(undefined)).toEqual([]);
  });
});

describe("buildEntityRows / entityTotals", () => {
  it("keeps an unavailable write count distinct from zero", () => {
    const rows = buildEntityRows(
      { entityFilter: ["missing", "zero"] },
      [],
      null,
      { missing: null, zero: 0 },
      {},
    );
    expect(rows.map(row => row.execRows)).toEqual([null, 0]);
  });

  it("merges configured entities, CDC state, counts and live stats", () => {
    const rows = buildEntityRows(
      { entityFilter: ["customers", "orders"] },
      [
        {
          entity: "orders",
          backlogCount: 4,
          destinationRowCount: 10,
          lifetimeEventsProcessed: 7,
          lifetimeRowsApplied: 5,
          backfillDone: true,
        },
        { entity: "extra", lifetimeRowsApplied: 1 },
      ],
      { customers: 3 },
      { orders: 9 },
      { orders: "syncing" },
    );
    expect(rows.map(r => r.entity)).toEqual(["customers", "orders", "extra"]);
    expect(rows[0]).toMatchObject({
      destinationRowCount: 3,
      backlogCount: 0,
      execRows: 0,
      execStatus: null,
    });
    expect(rows[1]).toMatchObject({
      destinationRowCount: 10,
      backlogCount: 4,
      backfillDone: true,
      execRows: 9,
      execStatus: "syncing",
    });
    expect(rows[2].destinationRowCount).toBeNull();

    expect(entityTotals(rows)).toEqual({
      totalEventsProcessed: 7,
      // max(applied, live rows) per entity: 0 + 9 + 1
      totalRowsApplied: 10,
      totalDestinationRows: 13,
      hasAnyDestinationCount: true,
    });
    expect(entityTotals([]).hasAnyDestinationCount).toBe(false);
  });
});
