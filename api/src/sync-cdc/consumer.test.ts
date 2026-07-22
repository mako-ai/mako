import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression coverage for bug B3 (docs/sync-modes-hardening-plan.md, Phase 3):
 * the webhook/streaming consumer built the CDC entity layout without the
 * flow's `writeMode`, so `applyEvents`/`applyBatch` always took the
 * dedup-merge branch — even on `Incremental | Append` flows, where polled
 * rows append history and webhook-applied rows silently took the opposite
 * (merge) semantics. `materializeEntity` must pass `flow.writeMode` through.
 */

const FLOW_ID = "507f1f77bcf86cd799439011";

const flowDoc = {
  _id: FLOW_ID,
  syncEngine: "cdc",
  streamState: "active",
  tableDestination: { connectionId: "conn1", tableName: "users" },
  entityLayouts: [],
  dataSourceId: undefined,
  deleteMode: "soft",
  writeMode: "append",
};

vi.mock("../database/workspace-schema", () => ({
  Flow: { findById: vi.fn(() => ({ lean: () => Promise.resolve(flowDoc) })) },
  DatabaseConnection: {
    findById: vi.fn(() => ({
      lean: () => Promise.resolve({ type: "postgresql" }),
    })),
  },
  CdcEntityState: {
    findOne: vi.fn(() => ({ lean: () => Promise.resolve(null) })),
  },
  CdcChangeEvent: { countDocuments: vi.fn(() => Promise.resolve(0)) },
  WebhookEvent: {},
}));

const ensureLiveTable = vi.fn().mockResolvedValue(undefined);
const fakeAdapter = {
  destinationType: "postgresql",
  ensureLiveTable,
  applyEvents: vi.fn().mockResolvedValue({ applied: 0 }),
  applyBatch: vi.fn().mockResolvedValue({ written: 0 }),
};

vi.mock("./adapters/registry", async () => {
  const actual = await vi.importActual<typeof import("./adapters/registry")>(
    "./adapters/registry",
  );
  return {
    ...actual,
    resolveCdcDestinationAdapter: vi.fn(() => fakeAdapter),
  };
});

vi.mock("./event-store", () => ({
  getCdcEventStore: () => ({
    readAfter: vi.fn().mockResolvedValue([]), // empty → early return, no need to mock beyond layout construction
  }),
}));

import { CdcConsumerService } from "./consumer";
import { buildCdcEntityLayout } from "./adapters/registry";

describe("CdcConsumerService.materializeEntity — writeMode propagation (bug B3)", () => {
  beforeEach(() => {
    ensureLiveTable.mockClear();
    (buildCdcEntityLayout as any).mockClear?.();
  });

  it("passes the flow's writeMode into the CDC entity layout", async () => {
    const spy = vi.spyOn(
      await import("./adapters/registry"),
      "buildCdcEntityLayout",
    );

    const service = new CdcConsumerService();
    await service.materializeEntity({
      workspaceId: "ws1",
      flowId: FLOW_ID,
      entity: "users",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ writeMode: "append" }),
    );
    expect(ensureLiveTable).toHaveBeenCalledWith(
      expect.objectContaining({ writeMode: "append" }),
    );
    spy.mockRestore();
  });

  it("propagates append_dedup and overwrite the same way", async () => {
    for (const writeMode of ["append_dedup", "overwrite"] as const) {
      flowDoc.writeMode = writeMode;
      const spy = vi.spyOn(
        await import("./adapters/registry"),
        "buildCdcEntityLayout",
      );
      const service = new CdcConsumerService();
      await service.materializeEntity({
        workspaceId: "ws1",
        flowId: FLOW_ID,
        entity: "users",
      });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ writeMode }));
      spy.mockRestore();
    }
    flowDoc.writeMode = "append";
  });
});
