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

const flowDoc: Record<string, unknown> = {
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
    // Scoped by workspace (utils/workspace-scope.ts): findOne, not findById.
    findOne: vi.fn(() => ({
      lean: () => Promise.resolve({ type: "postgresql" }),
    })),
  },
  CdcEntityState: {
    findOne: vi.fn(() => ({ lean: () => Promise.resolve(null) })),
  },
  CdcChangeEvent: {
    countDocuments: vi.fn(() => Promise.resolve(0)),
    find: vi.fn(() => ({
      lean: () =>
        Promise.resolve([
          { _id: "e1", webhookEventId: "507f1f77bcf86cd799439021" },
          { _id: "e2", webhookEventId: "507f1f77bcf86cd799439021" },
          { _id: "e3" },
        ]),
    })),
    updateMany: vi.fn(() => Promise.resolve({ modifiedCount: 3 })),
  },
  WebhookEvent: {
    updateMany: vi.fn(() => Promise.resolve({ modifiedCount: 1 })),
  },
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

const readAfter = vi.fn().mockResolvedValue([]);
const claimOrdinaryWebhookUpserts = vi.fn();
vi.mock("./event-store", () => ({
  getCdcEventStore: () => ({
    readAfter,
    claimOrdinaryWebhookUpserts,
  }),
}));

import { CdcConsumerService } from "./consumer";
import { buildCdcEntityLayout } from "./adapters/registry";
import { CdcChangeEvent, WebhookEvent } from "../database/workspace-schema";

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

it("skips a stale webhook batch before dispatch when retained ownership wins", async () => {
  const workspaceId = "507f1f77bcf86cd799439012";
  const eventId = "507f1f77bcf86cd799439013";
  readAfter.mockResolvedValueOnce([
    { id: eventId, source: "webhook", operation: "upsert" },
  ]);
  claimOrdinaryWebhookUpserts.mockResolvedValueOnce(false);
  fakeAdapter.applyEvents.mockClear();

  await expect(
    new CdcConsumerService().materializeEntity({
      workspaceId,
      flowId: FLOW_ID,
      entity: "users",
    }),
  ).resolves.toMatchObject({
    skipped: true,
    reason: "retained_cdc_ownership_changed",
    processed: 0,
  });
  expect(claimOrdinaryWebhookUpserts).toHaveBeenCalledExactlyOnceWith({
    workspaceId,
    flowId: FLOW_ID,
    entity: "users",
    eventIds: [eventId],
  });
  expect(fakeAdapter.applyEvents).not.toHaveBeenCalled();
});

describe("CdcConsumerService.materializeEntity — paused flow", () => {
  const updateMany = CdcChangeEvent.updateMany as unknown as ReturnType<
    typeof vi.fn
  >;
  const find = CdcChangeEvent.find as unknown as ReturnType<typeof vi.fn>;
  const webhookUpdateMany = WebhookEvent.updateMany as unknown as ReturnType<
    typeof vi.fn
  >;
  beforeEach(() => {
    updateMany.mockClear();
    find.mockClear();
    webhookUpdateMany.mockClear();
  });

  it("parks the paused flow's pending webhook events before reading", async () => {
    flowDoc.webhookConfig = { enabled: false };
    try {
      await new CdcConsumerService().materializeEntity({
        workspaceId: "ws1",
        flowId: FLOW_ID,
        entity: "users",
      });
      expect(find).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledTimes(1);
      const [filter] = find.mock.calls[0] as [any];
      const [byId, update] = updateMany.mock.calls[0] as [any, any];
      expect(byId._id).toEqual({ $in: ["e1", "e2", "e3"] });
      // Webhook events only: an operator's backfill of a paused flow applies.
      expect(filter).toMatchObject({
        entity: "users",
        sourceKind: "webhook",
        materializationStatus: { $in: ["pending", "failed"] },
      });
      expect(String(filter.flowId)).toBe(FLOW_ID);
      expect(update.$set).toMatchObject({
        materializationStatus: "dropped",
        materializationError: { code: "FLOW_PAUSED" },
      });
      // appliedAt puts parked events under the 7-day dropped-events TTL.
      expect(update.$set.appliedAt).toBeInstanceOf(Date);
      // Their WebhookEvents say dropped, so the orphan reconciler never
      // reports them applied. One id, deduplicated; e3 has none.
      expect(webhookUpdateMany).toHaveBeenCalledTimes(1);
      const [webhookFilter, webhookUpdate] = webhookUpdateMany.mock
        .calls[0] as [any, any];
      expect(webhookFilter._id.$in.map(String)).toEqual([
        "507f1f77bcf86cd799439021",
      ]);
      expect(webhookUpdate.$set).toMatchObject({
        applyStatus: "dropped",
        applyError: { code: "FLOW_PAUSED" },
      });
    } finally {
      delete flowDoc.webhookConfig;
    }
  });

  it("parks nothing while the webhook is on, or when the flag was never set", async () => {
    for (const webhookConfig of [{ enabled: true }, undefined]) {
      flowDoc.webhookConfig = webhookConfig;
      await new CdcConsumerService().materializeEntity({
        workspaceId: "ws1",
        flowId: FLOW_ID,
        entity: "users",
      });
    }
    delete flowDoc.webhookConfig;
    expect(updateMany).not.toHaveBeenCalled();
  });
});
