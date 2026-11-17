/**
 * Boxed shadow and switch for built-in connectors, against a real in-memory
 * Mongo. The box, the repo commit and the CDC store are the seams.
 *
 * - runtime: a switched or shadow flow reads its built-in connection as
 *   `ws:<slug>` with the same id and a credential trimmed to the twin's
 *   spec; with the flag off nothing changes;
 * - shadow isolation: a shadow never writes its live flow's dataset;
 * - ingress: a switched flow's deliveries go to the box lane through the
 *   twin; a live flow's verified deliveries are copied to its shadow;
 * - batches: a switched flow's box-lane events run through the twin; after
 *   a switch back they go to the inline lane instead of being dropped;
 * - switch: the gate refuses, `force` overrides, built-in is one call;
 * - parity: a check stores per-entity results and opens the gate.
 */
import { createHmac } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const mocks = vi.hoisted(() => ({
  appendNormalizedEvents: vi.fn(),
  loadConnectorDefinition: vi.fn(),
  commitFlowFile: vi.fn(),
  startBackfill: vi.fn(),
}));

vi.mock("../../sync-cdc/ingest", () => ({
  cdcIngestService: { appendNormalizedEvents: mocks.appendNormalizedEvents },
}));
vi.mock("../workspace/resolver", async importOriginal => ({
  ...(await importOriginal<typeof import("../workspace/resolver")>()),
  loadConnectorDefinition: mocks.loadConnectorDefinition,
}));
vi.mock("../../services/flow-config.service", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../services/flow-config.service")
  >()),
  commitFlowFile: mocks.commitFlowFile,
}));
vi.mock("../../services/flow-sync.service", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../services/flow-sync.service")
  >()),
  listFlowDefinitionsAtMain: async () => [],
}));
vi.mock("../../sync-cdc/backfill", () => ({
  cdcBackfillService: { startBackfill: mocks.startBackfill },
}));

import {
  CdcEntityState,
  DatabaseConnection,
  Flow,
  FlowParityCheck,
  SourceConnection,
  WebhookEvent,
} from "../../database/workspace-schema";
import { webhookRoutes } from "../../routes/webhooks";
import { connectorRegistry } from "../registry";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import { processBoxWebhookBatch } from "../workspace/webhook-batch";
import type { RunResult } from "../workspace/sync-box";
import { applyFlowRuntime, applyFlowRuntimeById } from "./runtime";
import { parityGate, runParityCheck } from "./parity.service";
import { startShadow, stopShadow, switchFlowRuntime } from "./shadow.service";

const SECRET = "0f".repeat(32);
const KEY = "api_close_pl_secret_value";
const CLOSE_VERIFICATION = {
  scheme: "hmac-sha256",
  secretEncoding: "hex",
  signedPayload: ["header:close-sig-timestamp", "body"],
  signatureHeader: "close-sig-hash",
  signatureEncoding: "hex",
};
const CLOSE_SPEC = {
  connectionSpecification: {
    type: "object",
    required: ["api_key"],
    properties: { api_key: { type: "string", airbyte_secret: true } },
  },
  mako: { webhooks: { verification: CLOSE_VERIFICATION } },
};

let mongo: MongoMemoryServer;
const ws = new Types.ObjectId();
const conn = new Types.ObjectId();
const db = new Types.ObjectId();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Flow.init(), WebhookEvent.init(), FlowParityCheck.init()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const approved = (slug = "close") => ({
  boxedApproval: { by: "owner", at: new Date(), slug },
});

async function makeFlow(extra: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  await Flow.collection.insertOne({
    _id,
    workspaceId: ws,
    name: `pl_close ${_id}`,
    slug: `flow-${_id}`,
    sourceType: "connector",
    dataSourceId: conn,
    destinationDatabaseId: db,
    syncEngine: "cdc",
    syncMode: "incremental",
    createdBy: "u",
    runCount: 0,
    tableDestination: { connectionId: db, schema: "pl_close", tableName: "" },
    entityFilter: ["leads"],
    schedule: { enabled: true, cron: "0 * * * *", timezone: "UTC" },
    webhookConfig: {
      enabled: true,
      secret: SECRET,
      endpoint: `/api/webhooks/${ws}/${_id}`,
    },
    ...extra,
  });
  return _id;
}

const decrypted = () => ({
  id: String(conn),
  name: "PL Close",
  type: "close",
  workspaceId: String(ws),
  active: true,
  connection: { api_key: KEY, api_base_url: "https://proxy.example" },
  settings: {},
});

beforeEach(async () => {
  process.env.CONNECTOR_BOXED_SWITCH = "true";
  process.env.CONNECTOR_WEBHOOK_BATCHES = "true";
  vi.restoreAllMocks();
  mocks.appendNormalizedEvents.mockReset();
  mocks.appendNormalizedEvents.mockResolvedValue({ inserted: 0, deduped: 0 });
  mocks.loadConnectorDefinition.mockReset();
  mocks.loadConnectorDefinition.mockResolvedValue({
    slug: "close",
    sha: "sha",
    sourceSha: "source-sha",
    entry: "connector.ts",
    runtime: "node",
    entities: ["leads", "contacts"],
    spec: CLOSE_SPEC,
    status: "indexed",
  });
  mocks.commitFlowFile.mockReset();
  mocks.commitFlowFile.mockResolvedValue({
    ok: true,
    changed: true,
    sourceBlobSha: "blob",
  });
  mocks.startBackfill.mockReset();
  mocks.startBackfill.mockResolvedValue({ runId: "run-1", reusedRunId: false });
  vi.spyOn(sourceConnectionManager, "getSourceConnection").mockImplementation(
    async () => decrypted(),
  );
  await Promise.all([
    WebhookEvent.deleteMany({}),
    Flow.collection.deleteMany({}),
    FlowParityCheck.deleteMany({}),
    CdcEntityState.collection.deleteMany({}),
    SourceConnection.collection.deleteMany({}),
    DatabaseConnection.collection.deleteMany({}),
  ]);
  await SourceConnection.collection.insertOne({
    _id: conn,
    workspaceId: ws,
    name: "PL Close",
    type: "close",
    config: { api_key: "encrypted" },
  });
  await DatabaseConnection.collection.insertOne({
    _id: db,
    workspaceId: ws,
    name: "bq",
    type: "bigquery",
    connection: { project_id: "proj", location: "EU" },
  });
});

async function lean(id: Types.ObjectId) {
  return (await Flow.findById(id).lean()) as any;
}

describe("runtime", () => {
  it("leaves a built-in flow's connection unchanged", async () => {
    const id = await makeFlow();
    const source = decrypted();
    expect(await applyFlowRuntime(source, await lean(id))).toBe(source);
    expect(mocks.loadConnectorDefinition).not.toHaveBeenCalled();
  });

  it("reads a switched flow's connection through its twin, same id, credential trimmed to the spec", async () => {
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    const out = await applyFlowRuntime(decrypted(), await lean(id));
    expect(out.type).toBe("ws:close");
    expect(out.id).toBe(String(conn));
    expect(out.connection).toEqual({ api_key: KEY });
    expect(mocks.loadConnectorDefinition).toHaveBeenCalledWith(
      String(ws),
      "close",
    );
  });

  it("ignores runtime: boxed from a file without an owner/admin approval", async () => {
    const id = await makeFlow({ connectorRuntime: "boxed" });
    const source = decrypted();
    expect(await applyFlowRuntime(source, await lean(id))).toBe(source);
    const other = await makeFlow({
      connectorRuntime: "boxed",
      boxedConnector: "evil",
      ...approved("close"),
    });
    expect(await applyFlowRuntime(source, await lean(other))).toBe(source);
  });

  it("refuses an unapproved shadow", async () => {
    const live = await makeFlow();
    const shadow = await makeFlow({
      shadowOf: live,
      tableDestination: { connectionId: db, schema: "pl_close_shadow" },
    });
    await expect(
      applyFlowRuntime(decrypted(), await lean(shadow)),
    ).rejects.toThrow(/no owner\/admin approval/);
  });

  it("uses boxedConnector as the twin's slug", async () => {
    const id = await makeFlow({
      connectorRuntime: "boxed",
      boxedConnector: "close-v2",
      ...approved("close-v2"),
    });
    const out = await applyFlowRuntime(decrypted(), await lean(id));
    expect(out.type).toBe("ws:close-v2");
  });

  it("ignores runtime: boxed with the flag off, without reading Mongo by id", async () => {
    process.env.CONNECTOR_BOXED_SWITCH = "false";
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    const source = decrypted();
    expect(await applyFlowRuntime(source, await lean(id))).toBe(source);
    expect(await applyFlowRuntimeById(source, String(id))).toBe(source);
  });

  it("refuses a twin whose required credential field the connection lacks, naming the field only", async () => {
    vi.spyOn(sourceConnectionManager, "getSourceConnection").mockResolvedValue({
      ...decrypted(),
      connection: { token: KEY },
    });
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    await expect(
      applyFlowRuntime(
        { ...decrypted(), connection: { token: KEY } },
        await lean(id),
      ),
    ).rejects.toThrow(/lacks api_key/);
    await expect(
      applyFlowRuntime(
        { ...decrypted(), connection: { token: KEY } },
        await lean(id),
      ),
    ).rejects.not.toThrow(new RegExp(KEY));
  });
});

describe("shadow isolation", () => {
  it("refuses a shadow that writes its live flow's dataset", async () => {
    const live = await makeFlow();
    const shadow = await makeFlow({
      shadowOf: live,
      webhookConfig: undefined,
      ...approved(),
    });
    await expect(
      applyFlowRuntime(decrypted(), await lean(shadow)),
    ).rejects.toThrow(/writes the live flow's dataset/);
  });

  it("runs a shadow with its own dataset boxed", async () => {
    const live = await makeFlow();
    const shadow = await makeFlow({
      shadowOf: live,
      ...approved(),
      tableDestination: {
        connectionId: db,
        schema: "pl_close_shadow",
        tableName: "",
      },
    });
    const out = await applyFlowRuntime(decrypted(), await lean(shadow));
    expect(out.type).toBe("ws:close");
  });

  it("refuses a shadow run with the flag off", async () => {
    process.env.CONNECTOR_BOXED_SWITCH = "false";
    const live = await makeFlow();
    const shadow = await makeFlow({
      shadowOf: live,
      ...approved(),
      tableDestination: { connectionId: db, schema: "pl_close_shadow" },
    });
    await expect(
      applyFlowRuntime(decrypted(), await lean(shadow)),
    ).rejects.toThrow(/CONNECTOR_BOXED_SWITCH/);
  });

  it("refuses a shadow of another workspace's flow", async () => {
    const otherWs = new Types.ObjectId();
    const foreign = new Types.ObjectId();
    await Flow.collection.insertOne({ _id: foreign, workspaceId: otherWs });
    const shadow = await makeFlow({
      shadowOf: foreign,
      ...approved(),
      tableDestination: { connectionId: db, schema: "pl_close_shadow" },
    });
    await expect(
      applyFlowRuntime(decrypted(), await lean(shadow)),
    ).rejects.toThrow(/not in this workspace/);
  });
});

describe("ingress", () => {
  const TS = "1763290800";
  const sign = (body: string) =>
    createHmac("sha256", Buffer.from(SECRET, "hex"))
      .update(TS + body)
      .digest("hex");
  const deliver = (flowId: Types.ObjectId, body: string) =>
    webhookRoutes.request(`/webhooks/${ws}/${flowId}`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "close-sig-hash": sign(body),
        "close-sig-timestamp": TS,
      },
    });
  const builtinVerifies = () =>
    vi.spyOn(connectorRegistry, "getConnectorFor").mockReturnValue({
      supportsWebhooks: () => true,
      webhookDelivery: () => "inline",
      verifyWebhook: async ({ payload }: { payload: string }) => ({
        valid: true,
        event: JSON.parse(payload),
      }),
    } as never);

  it("stores a switched flow's delivery in the box lane, verified by the twin's declared scheme", async () => {
    const spy = builtinVerifies();
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    const body = JSON.stringify({
      event: { id: "ev_sw", object_type: "lead", action: "updated" },
    });
    const res = await deliver(id, body);
    expect(res.status).toBe(200);
    const stored = await WebhookEvent.findOne({ eventId: "ev_sw" }).lean();
    expect(stored).toMatchObject({ lane: "box", status: "pending" });
    expect(String(stored!.dataSourceId)).toBe(String(conn));
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps a switched flow on built-in ingress when webhook batches are off", async () => {
    process.env.CONNECTOR_WEBHOOK_BATCHES = "false";
    const spy = builtinVerifies();
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    const body = JSON.stringify({ event: { id: "ev_off" } });
    expect((await deliver(id, body)).status).toBe(200);
    const stored = await WebhookEvent.findOne({ eventId: "ev_off" }).lean();
    expect(stored?.lane).toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it("copies a live flow's verified delivery to its active shadow's box lane", async () => {
    builtinVerifies();
    const live = await makeFlow();
    const shadow = await makeFlow({
      shadowOf: live,
      connectorRuntime: "boxed",
      ...approved(),
      webhookConfig: undefined,
      tableDestination: { connectionId: db, schema: "pl_close_shadow" },
    });
    const body = JSON.stringify({ event: { id: "ev_m" } });
    expect((await deliver(live, body)).status).toBe(200);
    const liveEvent = await WebhookEvent.findOne({ flowId: live }).lean();
    expect(liveEvent?.lane).toBeUndefined();
    const copy = await WebhookEvent.findOne({ flowId: shadow }).lean();
    expect(copy).toMatchObject({
      lane: "box",
      status: "pending",
      eventId: "ev_m",
    });
    expect(JSON.stringify(copy)).not.toContain(SECRET);
    // A vendor retry is not copied twice.
    await deliver(live, body);
    expect(await WebhookEvent.countDocuments({ flowId: shadow })).toBe(1);
  });

  it("copies nothing with the flag off, or to a stopped shadow", async () => {
    builtinVerifies();
    const live = await makeFlow();
    const shadow = await makeFlow({
      shadowOf: live,
      ...approved(),
      webhookConfig: undefined,
      tableDestination: { connectionId: db, schema: "pl_close_shadow" },
      schedule: { enabled: false, cron: "0 * * * *" },
    });
    await deliver(live, JSON.stringify({ event: { id: "ev_stopped" } }));
    process.env.CONNECTOR_BOXED_SWITCH = "false";
    await Flow.updateOne(
      { _id: shadow },
      { $set: { "schedule.enabled": true } },
    );
    await deliver(live, JSON.stringify({ event: { id: "ev_flag_off" } }));
    expect(await WebhookEvent.countDocuments({ flowId: shadow })).toBe(0);
  });
});

describe("box-lane batches", () => {
  const ok = (messages: any[]): RunResult => ({
    exitCode: 0,
    messages,
    malformed: [],
    stderr: "",
    timedOut: false,
  });
  async function boxEvent(flowId: Types.ObjectId, eventId: string) {
    return WebhookEvent.create({
      flowId,
      workspaceId: ws,
      eventId,
      eventType: "lead.updated",
      receivedAt: new Date(),
      status: "pending",
      rawPayload: { event: { id: eventId } },
      lane: "box",
      dataSourceId: conn,
    });
  }

  it("runs a switched flow's events through the twin, handed the flow", async () => {
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    await boxEvent(id, "ev_b1");
    const seen: any[] = [];
    const result = await processBoxWebhookBatch({
      flowId: String(id),
      runner: async (connectionId, workspaceId, flow) => {
        seen.push({ connectionId, workspaceId, flow: String(flow?._id) });
        return {
          declaredEntities: async () => ["leads"],
          runWebhookBatch: async batch =>
            ok(
              batch.events.map((e: any) => ({
                type: "WEBHOOK",
                webhook: {
                  eventId: e.eventId,
                  outcome: "skipped",
                  reason: "test",
                },
              })),
            ),
        };
      },
    });
    expect(result.claimed).toBe(1);
    expect(seen).toEqual([
      { connectionId: String(conn), workspaceId: String(ws), flow: String(id) },
    ]);
  });

  it("hands a switched-back flow's pending events to the inline lane", async () => {
    const id = await makeFlow();
    await boxEvent(id, "ev_back");
    const result = await processBoxWebhookBatch({
      flowId: String(id),
      runner: async () => {
        throw new Error("no box for a built-in flow");
      },
    });
    expect(result.next).toBe("stop");
    const event = await WebhookEvent.findOne({ eventId: "ev_back" }).lean();
    expect(event).toMatchObject({ status: "pending" });
    expect(event?.lane).toBeUndefined();
    expect(event?.dataSourceId).toBeUndefined();
  });
});

describe("shadow and switch", () => {
  it("starts a shadow on the same connection, its own dataset, boxed, and its full backfill at once", async () => {
    const id = await makeFlow();
    const live = await Flow.findById(id);
    const out = await startShadow({ live: live!, userId: "u" });
    expect(out).toMatchObject({
      created: true,
      dataset: "pl_close_shadow",
      backfillRunId: "run-1",
      webhooksMirrored: true,
    });
    const shadow = await lean(new Types.ObjectId(out.shadowFlowId));
    expect(String(shadow.dataSourceId)).toBe(String(conn));
    expect(String(shadow.shadowOf)).toBe(String(id));
    expect(shadow.connectorRuntime).toBe("boxed");
    expect(shadow.boxedApproval).toMatchObject({ by: "u", slug: "close" });
    expect(shadow.tableDestination.schema).toBe("pl_close_shadow");
    expect(shadow.schedule).toMatchObject({ enabled: true, cron: "0 * * * *" });
    expect(shadow.webhookConfig?.endpoint).toBeUndefined();
    expect(mocks.startBackfill).toHaveBeenCalledWith(
      String(ws),
      out.shadowFlowId,
      expect.objectContaining({ trigger: "manual" }),
    );
    expect(mocks.commitFlowFile).toHaveBeenCalled();
    // The live flow is untouched.
    expect((await lean(id)).connectorRuntime).toBeUndefined();

    const stopped = await stopShadow({ live: live! });
    expect(stopped?.shadowFlowId).toBe(out.shadowFlowId);
    expect(
      (await lean(new Types.ObjectId(out.shadowFlowId))).schedule.enabled,
    ).toBe(false);
  });

  it("refuses to start a shadow with the flag off", async () => {
    process.env.CONNECTOR_BOXED_SWITCH = "false";
    const live = await Flow.findById(await makeFlow());
    await expect(startShadow({ live: live! })).rejects.toThrow(
      /CONNECTOR_BOXED_SWITCH is off/,
    );
  });

  it("refuses a switch while the gate is closed, switches with force, and back in one call", async () => {
    const id = await makeFlow();
    await expect(
      switchFlowRuntime({ flow: (await Flow.findById(id))!, target: "boxed" }),
    ).rejects.toThrow(/parity gate is closed: No shadow/);

    const forced = await switchFlowRuntime({
      flow: (await Flow.findById(id))!,
      target: "boxed",
      force: true,
    });
    expect(forced).toMatchObject({
      runtime: "boxed",
      changed: true,
      forced: true,
    });
    expect((await lean(id)).connectorRuntime).toBe("boxed");

    await WebhookEvent.create({
      flowId: id,
      workspaceId: ws,
      eventId: "ev_pending",
      eventType: "lead.updated",
      receivedAt: new Date(),
      status: "pending",
      rawPayload: {},
      lane: "box",
      dataSourceId: conn,
    });
    const back = await switchFlowRuntime({
      flow: (await Flow.findById(id))!,
      target: "builtin",
    });
    expect(back).toMatchObject({
      runtime: "builtin",
      changed: true,
      relaned: 1,
    });
    expect((await lean(id)).connectorRuntime).toBeUndefined();
  });

  it("refuses to switch a webhook flow whose twin declares no verification", async () => {
    mocks.loadConnectorDefinition.mockResolvedValue({
      slug: "close",
      entities: ["leads"],
      spec: { connectionSpecification: CLOSE_SPEC.connectionSpecification },
      status: "indexed",
    });
    const id = await makeFlow();
    await expect(
      switchFlowRuntime({
        flow: (await Flow.findById(id))!,
        target: "boxed",
        force: true,
      }),
    ).rejects.toThrow(/declares no webhook verification/);
  });
});

describe("parity", () => {
  async function shadowPair(backfillCompletedAt: Date) {
    const live = await makeFlow();
    const shadow = await makeFlow({
      shadowOf: live,
      connectorRuntime: "boxed",
      ...approved(),
      webhookConfig: undefined,
      tableDestination: {
        connectionId: db,
        schema: "pl_close_shadow",
        tableName: "",
      },
      backfillState: { status: "completed", completedAt: backfillCompletedAt },
    });
    await CdcEntityState.collection.insertMany([
      { flowId: live, workspaceId: ws, entity: "leads" },
      { flowId: shadow, workspaceId: ws, entity: "leads" },
    ]);
    return { live, shadow };
  }

  const summary = (extra: Record<string, unknown> = {}) => ({
    live_rows: 100,
    shadow_rows: 100,
    recent: 2,
    compared: 98,
    both_keys: 98,
    live_only: 0,
    shadow_only: 0,
    rows_differing: 0,
    live_checksum: "42",
    shadow_checksum: "42",
    w_live: 10,
    w_matched: 10,
    w_lag_p50: 30,
    w_lag_p95: 120,
    d0: 0,
    d1: 0,
    d2: 0,
    ...extra,
  });

  function fakeQuery(row: Record<string, unknown>, samples: any[] = []) {
    const sqls: string[] = [];
    const query = async (_d: unknown, sql: string) => {
      sqls.push(sql);
      if (sql.includes("INFORMATION_SCHEMA")) {
        return [
          "id",
          "name",
          "_mako_source_ts",
          "_syncedAt",
          "_mako_ingest_seq",
          "_mako_deleted_at",
        ].map(column_name => ({ table_name: "leads", column_name }));
      }
      if (sql.includes("ARRAY_AGG")) return samples;
      return [row];
    };
    return { query, sqls };
  }

  it("stores a clean check and opens the gate once 2 h of live updates are covered", async () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const { live, shadow } = await shadowPair(new Date("2026-11-17T09:00:00Z"));
    const { query, sqls } = fakeQuery(summary());
    const check = await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "manual",
      deps: { query, keyColumns: async () => ["id"], now: () => now },
    });
    expect(check.status).toBe("done");
    expect(check.clean).toBe(true);
    expect(check.window?.coverageMinutes).toBe(120);
    expect(check.entities[0]).toMatchObject({
      entity: "leads",
      compared: 98,
      liveChecksum: "42",
      window: { liveRows: 10, matched: 10, lagP95Seconds: 120 },
    });
    // Both datasets are read; the live one is never written.
    expect(sqls.some(s => s.includes("`pl_close`.`leads`"))).toBe(true);
    expect(sqls.some(s => s.includes("`pl_close_shadow`.`leads`"))).toBe(true);
    expect(sqls.every(s => /^\s*(WITH|SELECT)/.test(s))).toBe(true);

    const gate = await parityGate(
      { _id: live, workspaceId: ws },
      new Date(now.getTime() + 5 * 60_000),
    );
    expect(gate).toMatchObject({ open: true, reasons: [] });
  });

  it("reports differing fields with samples, and keeps the gate closed", async () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const { live, shadow } = await shadowPair(new Date("2026-11-17T09:00:00Z"));
    const { query } = fakeQuery(
      summary({
        rows_differing: 3,
        d2: 3,
      }) /* columns sort as _mako_source_ts, id, name */,
      [
        {
          field: "name",
          samples: [{ key: '{"id":"lead_1"}', live: '"A"', shadow: '"B"' }],
        },
      ],
    );
    const check = await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "manual",
      deps: { query, keyColumns: async () => ["id"], now: () => now },
    });
    expect(check.clean).toBe(false);
    expect(check.entities[0].topFields).toEqual([
      {
        field: "name",
        rows: 3,
        samples: [{ key: '{"id":"lead_1"}', live: '"A"', shadow: '"B"' }],
      },
    ]);
    const gate = await parityGate({ _id: live, workspaceId: ws }, now);
    expect(gate.open).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(/3 of 98 rows differ/);
  });

  it("keeps the gate closed until the window covers 2 h after the backfill", async () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const { live, shadow } = await shadowPair(new Date("2026-11-17T11:00:00Z"));
    const { query } = fakeQuery(summary());
    await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "scheduled",
      deps: { query, keyColumns: async () => ["id"], now: () => now },
    });
    const gate = await parityGate({ _id: live, workspaceId: ws }, now);
    expect(gate.open).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(/covers 50 min/);
  });

  it("switches once the gate is open, without force", async () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const { live, shadow } = await shadowPair(new Date("2026-11-17T09:00:00Z"));
    const { query } = fakeQuery(summary());
    await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "manual",
      deps: { query, keyColumns: async () => ["id"], now: () => now },
    });
    const out = await switchFlowRuntime({
      flow: (await Flow.findById(live))!,
      target: "boxed",
      now,
    });
    expect(out).toMatchObject({ runtime: "boxed", forced: false });
  });
});
