import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  BaseConnector,
  ConnectorEntitySchema,
} from "../connectors/base/BaseConnector";
import type { CdcStoredEvent } from "./events";

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

const readAfter = vi
  .fn<() => Promise<CdcStoredEvent[]>>()
  .mockResolvedValue([]);
const markEventsApplied = vi.fn();
const markEventsFailed = vi.fn();
const advanceConsumerCursor = vi.hoisted(() => vi.fn());

vi.mock("./event-store", () => ({
  getCdcEventStore: () => ({
    readAfter,
    markEventsApplied,
    markEventsFailed,
  }),
}));
vi.mock("./sync-state", () => ({
  cdcSyncStateService: { advanceConsumerCursor },
}));
vi.mock("../sync/database-data-source-manager", () => ({
  sourceConnectionManager: { getSourceConnection: vi.fn() },
}));
vi.mock("../sync/connector-registry", () => ({
  syncConnectorRegistry: { getConnectorFor: vi.fn() },
}));

import { CdcConsumerService } from "./consumer";
import { buildCdcEntityLayout } from "./adapters/registry";
import {
  CdcChangeEvent,
  Flow,
  WebhookEvent,
} from "../database/workspace-schema";
import {
  BoxLowMemoryError,
  boxLowMemoryRefusal,
} from "../apps/sandbox/box-memory";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { SchemaResolutionError } from "../sync/sync-orchestrator";

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

describe("CdcConsumerService.materializeEntity — boxed schema", () => {
  const entity = "subscription_items";
  const scope = { workspaceId: FLOW_ID, flowId: FLOW_ID, entity };
  const service = new CdcConsumerService();
  const source = vi.mocked(sourceConnectionManager.getSourceConnection);
  const connector = vi.mocked(syncConnectorRegistry.getConnectorFor);
  const schema: ConnectorEntitySchema = {
    entity,
    keyColumns: ["id"],
    fields: {
      id: { type: "string" },
      current_period_start: { type: "timestamp" },
      current_period_end: { type: "timestamp" },
    },
    unknownFieldPolicy: "string",
  };
  const payload = {
    id: "si_fixture",
    current_period_start: 1795100000,
    current_period_end: 1797700000,
  };
  const event: CdcStoredEvent = {
    ...scope,
    id: "cdc-fixture",
    recordId: payload.id,
    webhookEventId: "507f1f77bcf86cd799439021",
    source: "webhook",
    operation: "upsert",
    sourceTs: new Date("2026-11-21T00:00:00Z"),
    ingestTs: new Date("2026-11-21T00:00:01Z"),
    ingestSeq: 1,
    idempotencyKey: "fixture",
    materializationStatus: "pending",
    payload,
  };

  function useConnector(
    resolveSchema: () => Promise<ConnectorEntitySchema | null>,
    declaresUntypedSchema?: () => Promise<boolean>,
  ) {
    connector.mockResolvedValue({
      resolveSchema,
      declaresUntypedSchema,
    } as unknown as BaseConnector);
  }

  function expectStillPending() {
    expect(ensureLiveTable).not.toHaveBeenCalled();
    expect(readAfter).not.toHaveBeenCalled();
    expect(fakeAdapter.applyEvents).not.toHaveBeenCalled();
    expect(markEventsApplied).not.toHaveBeenCalled();
    expect(markEventsFailed).not.toHaveBeenCalled();
    expect(WebhookEvent.updateMany).not.toHaveBeenCalled();
    expect(advanceConsumerCursor).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    flowDoc.workspaceId = FLOW_ID;
    flowDoc.dataSourceId = FLOW_ID;
    flowDoc.webhookConfig = { enabled: true };
    source.mockResolvedValue({ type: "ws:stripe" } as Awaited<
      ReturnType<typeof source>
    >);
    readAfter.mockResolvedValue([event]);
    fakeAdapter.applyEvents.mockResolvedValue({ applied: 1 });
  });

  afterEach(() => {
    delete flowDoc.workspaceId;
    delete flowDoc.dataSourceId;
    delete flowDoc.webhookConfig;
    readAfter.mockResolvedValue([]);
  });

  it.each(["missing catalog", "discovery error"] as const)(
    "keeps the event pending on %s and writes typed periods on retry",
    async failure => {
      const resolveSchema =
        vi.fn<() => Promise<ConnectorEntitySchema | null>>();
      if (failure === "missing catalog") {
        resolveSchema.mockResolvedValueOnce(null);
      } else {
        resolveSchema.mockRejectedValueOnce(new Error("discover disconnected"));
      }
      useConnector(resolveSchema.mockResolvedValue(schema));

      await expect(service.materializeEntity(scope)).rejects.toBeInstanceOf(
        SchemaResolutionError,
      );
      expectStillPending();

      await expect(service.materializeEntity(scope)).resolves.toMatchObject({
        processed: 1,
        applied: 1,
      });
      expect(fakeAdapter.applyEvents).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          entitySchema: schema,
          events: [
            expect.objectContaining({
              id: event.id,
              payload: {
                ...payload,
                current_period_start: new Date(
                  payload.current_period_start * 1000,
                ),
                current_period_end: new Date(payload.current_period_end * 1000),
              },
            }),
          ],
        }),
      );
      expect(markEventsApplied).toHaveBeenCalledExactlyOnceWith([event.id]);
      expect(markEventsFailed).not.toHaveBeenCalled();
      expect(WebhookEvent.updateMany).toHaveBeenCalledTimes(1);
    },
  );

  it("allows a workspace connector to declare its stream untyped", async () => {
    const declaresUntyped = vi.fn(async () => true);
    useConnector(async () => null, declaresUntyped);

    await expect(service.materializeEntity(scope)).resolves.toMatchObject({
      applied: 1,
    });
    expect(declaresUntyped).toHaveBeenCalledWith(entity);
    expect(fakeAdapter.applyEvents).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entitySchema: undefined, events: [event] }),
    );
  });

  it("still allows an untyped built-in connector", async () => {
    source.mockResolvedValueOnce({ type: "rest" } as Awaited<
      ReturnType<typeof source>
    >);
    useConnector(async () => null);

    await expect(service.materializeEntity(scope)).resolves.toMatchObject({
      applied: 1,
    });
    expect(fakeAdapter.applyEvents).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entitySchema: undefined, events: [event] }),
    );
  });

  it.each(["discover", "check untyped declaration"])(
    "preserves box-memory backoff during %s",
    async phase => {
      const refusal = new BoxLowMemoryError("synthetic memory refusal", 32, 64);
      const refuse = async () => {
        throw refusal;
      };
      if (phase === "discover") useConnector(refuse);
      else useConnector(async () => null, refuse);

      await expect(service.materializeEntity(scope)).rejects.toSatisfy(
        (error: unknown) => boxLowMemoryRefusal(error) === refusal,
      );
      expectStillPending();
    },
  );

  it("keeps work pending when its configured source cannot be resolved", async () => {
    source.mockResolvedValueOnce(null);
    await expect(service.materializeEntity(scope)).rejects.toBeInstanceOf(
      SchemaResolutionError,
    );
    expectStillPending();
  });

  it("still rejects a missing flow before resolving its schema", async () => {
    vi.mocked(Flow.findById).mockReturnValueOnce({
      lean: async () => null,
    } as never);
    await expect(service.materializeEntity(scope)).rejects.toThrow(
      "Flow not found",
    );
    expect(source).not.toHaveBeenCalled();
    expectStillPending();
  });
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
