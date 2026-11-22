import { beforeEach, describe, expect, it, vi } from "vitest";
import { CdcConsumerService } from "./consumer";
import { BoxLowMemoryError, boxLowMemoryRefusal } from "../apps/sandbox/box-memory";
import { withBoxMemoryWaits } from "../inngest/functions/flow/box-memory-wait";

const D = vi.hoisted(() => {
  const id = "507f1f77bcf86cd799439011";
  const eventId = "507f1f77bcf86cd799439022";
  return {
    id, eventId,
    flow: {
      _id: id,
      workspaceId: id,
      dataSourceId: id,
      syncEngine: "cdc",
      streamState: "active",
      webhookConfig: { enabled: true },
      tableDestination: { connectionId: id, schema: "fixture" },
      entityLayouts: [],
    },
    source: vi.fn(),
    connector: vi.fn(),
    schema: vi.fn(),
    untyped: vi.fn(),
    ensure: vi.fn(),
    findState: vi.fn(),
    read: vi.fn(),
    apply: vi.fn(),
    applied: vi.fn(),
    failed: vi.fn(),
    dropped: vi.fn(),
    webhookState: vi.fn(),
    advance: vi.fn(),
    transition: vi.fn(),
  };
});

vi.mock("../database/workspace-schema", async importOriginal => ({
  ...await importOriginal<typeof import("../database/workspace-schema")>(),
  Flow: { findById: () => ({ lean: async () => D.flow }) },
  DatabaseConnection: { findOne: () => ({ lean: async () => ({ type: "bigquery" }) }) },
  CdcEntityState: { findOne: D.findState, updateOne: vi.fn() },
  WebhookEvent: { updateMany: D.webhookState },
}));
vi.mock("../services/flow-sync.service", async importOriginal => ({
  ...await importOriginal<typeof import("../services/flow-sync.service")>(),
  ensureFlowDerivedCache: async () => "fresh",
}));
vi.mock("../sync/database-data-source-manager", async importOriginal => ({
  ...await importOriginal<typeof import("../sync/database-data-source-manager")>(),
  sourceConnectionManager: { getSourceConnection: D.source },
}));
vi.mock("../sync/connector-registry", async importOriginal => ({
  ...await importOriginal<typeof import("../sync/connector-registry")>(),
  syncConnectorRegistry: { getConnectorFor: D.connector },
}));
vi.mock("./adapters/registry", async importOriginal => ({
  ...await importOriginal<typeof import("./adapters/registry")>(),
  resolveCdcDestinationAdapter: () => ({ ensureLiveTable: D.ensure, applyEvents: D.apply }),
}));
vi.mock("./event-store", async importOriginal => ({
  ...await importOriginal<typeof import("./event-store")>(),
  getCdcEventStore: () => ({
    readAfter: D.read, markEventsApplied: D.applied,
    markEventsFailed: D.failed, markEventsDropped: D.dropped,
  }),
}));
vi.mock("./sync-state", async importOriginal => ({
  ...await importOriginal<typeof import("./sync-state")>(),
  cdcSyncStateService: {
    advanceConsumerCursor: D.advance, applyStreamTransition: D.transition,
  },
}));

const entity = "subscription_items";
const epochStart = 1795100000;
const epochEnd = 1797700000;
const row = {
  id: "si_local_period_fixture",
  current_period_start: epochStart,
  current_period_end: epochEnd,
};
const schema = {
  entity,
  keyColumns: ["id"],
  unknownFieldPolicy: "preserve",
  fields: {
    id: { type: "string", nullable: false, required: true },
    current_period_start: { type: "timestamp", nullable: true, required: false },
    current_period_end: { type: "timestamp", nullable: true, required: false },
  },
};
function noClaimOrWrite() {
  for (const mock of [
    D.ensure, D.findState, D.read, D.apply, D.applied, D.failed,
    D.dropped, D.webhookState, D.advance, D.transition,
  ]) {
    expect(mock).not.toHaveBeenCalled();
  }
}
const run = () => new CdcConsumerService().materializeEntity({
  workspaceId: D.id, flowId: D.id, entity,
});

describe("independent boxed CDC schema guard review", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    D.source.mockResolvedValue({ id: D.id, type: "ws:stripe" });
    D.connector.mockResolvedValue({
      resolveSchema: D.schema,
      declaresUntypedSchema: D.untyped,
    });
    D.schema.mockResolvedValue(schema);
    D.untyped.mockResolvedValue(false);
    D.findState.mockReturnValue({ lean: async () => ({ lastMaterializedSeq: 17, lastIngestSeq: 18 }) });
    D.read.mockResolvedValue([{
      id: D.eventId, webhookEventId: D.eventId, sourceKind: "webhook",
      recordId: row.id, ingestSeq: 18, operation: "upsert",
      sourceTs: "2026-11-20T00:00:00.000Z", payload: row,
    }]);
    D.apply.mockResolvedValue({ applied: 1 });
  });

  it("applies explicitly untyped workspace query rows without typed coercion", async () => {
    D.source.mockResolvedValue({ id: D.id, type: "ws:fixture-query" });
    D.schema.mockResolvedValue(null);
    D.untyped.mockResolvedValue(true);
    await expect(run()).resolves.toMatchObject({ applied: 1, latestIngestSeq: 18 });
    expect(D.untyped).toHaveBeenCalledExactlyOnceWith(entity);
    expect(D.apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      entitySchema: undefined, events: [expect.objectContaining({ payload: row })],
    }));
    expect(D.applied).toHaveBeenCalledExactlyOnceWith([D.eventId]);
  });

  it("rejects a configured missing source before table or event access", async () => {
    D.source.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(/source connection|schema/i);
    expect(D.connector).not.toHaveBeenCalled();
    noClaimOrWrite();
  });

  it("rejects a missing typed workspace schema before table or event access", async () => {
    D.schema.mockResolvedValue(null);
    await expect(run()).rejects.toThrow(/schema/i);
    expect(D.untyped).toHaveBeenCalledExactlyOnceWith(entity);
    noClaimOrWrite();
  });

  it("keeps the same pending event untouched on discovery error and retries with both periods", async () => {
    D.schema.mockRejectedValueOnce(new Error("synthetic discovery unavailable"));
    await expect(run()).rejects.toThrow(/schema|synthetic discovery unavailable/i);
    noClaimOrWrite();
    await expect(run()).resolves.toMatchObject({ applied: 1, latestIngestSeq: 18 });
    expect(D.read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ afterIngestSeq: 17 }));
    expect(D.apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      entitySchema: schema, events: [expect.objectContaining({
        id: D.eventId, payload: {
          id: row.id,
          current_period_start: new Date(epochStart * 1000),
          current_period_end: new Date(epochEnd * 1000),
        },
      })],
    }));
    expect(D.applied).toHaveBeenCalledExactlyOnceWith([D.eventId]);
    expect(D.advance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      lastIngestSeq: 18, processedEventsDelta: 1, rowsAppliedDelta: 1,
    }));
    expect(D.failed).not.toHaveBeenCalled();
    expect(D.dropped).not.toHaveBeenCalled();
  });

  it("keeps a low-memory refusal visible to the wait wrapper, before touching the event", async () => {
    const refusal = new BoxLowMemoryError("synthetic memory gate", 73, 100);
    D.schema.mockRejectedValueOnce(refusal);
    const caught = await run().then(() => null, error => error);
    expect(boxLowMemoryRefusal(caught)).toBe(refusal);
    noClaimOrWrite();
  });

  it("retries through the actual low-memory wait wrapper before reading the event", async () => {
    D.schema.mockRejectedValueOnce(new BoxLowMemoryError("synthetic memory gate", 73, 100));
    const runStep = vi.fn(async (_id, call) => call());
    const sleep = vi.fn(async () => { noClaimOrWrite(); });
    const materialization = await withBoxMemoryWaits(
      { run: runStep, sleep }, "materialize-local-fixture", run, { random: () => 0 },
    );
    expect(materialization).toMatchObject({ result: { applied: 1 }, waits: 1 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(runStep.mock.calls.map(([id]) => id)).toEqual([
      "materialize-local-fixture", "materialize-local-fixture-after-memory-wait-1",
    ]);
    expect(D.read).toHaveBeenCalledTimes(1);
    expect(D.applied).toHaveBeenCalledExactlyOnceWith([D.eventId]);
    expect(D.failed).not.toHaveBeenCalled();
  });
});
