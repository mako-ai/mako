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
  cancelBackfill: vi.fn(),
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
  cdcBackfillService: {
    startBackfill: mocks.startBackfill,
    cancelBackfill: mocks.cancelBackfill,
  },
}));

import {
  CdcEntityState,
  DatabaseConnection,
  Flow,
  FlowExecution,
  FlowParityCheck,
  SourceConnection,
  WebhookEvent,
} from "../../database/workspace-schema";
import { webhookRoutes } from "../../routes/webhooks";
import { connectorRegistry } from "../registry";
import { sourceConnectionManager } from "../../sync/database-data-source-manager";
import { processBoxWebhookBatch } from "../workspace/webhook-batch";
import type { RunResult } from "../workspace/sync-box";
import {
  applyFlowRuntime,
  applyFlowRuntimeById,
  approvalBinding,
  boxedKind,
} from "./runtime";
import { syncConnectorRegistry } from "../../sync/connector-registry";
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

/** Marks a flow for an owner/admin approval of this twin, bound as the code binds it. */
const approved = (slug = "close", sourceSha = "source-sha") => ({
  __approve: { slug, sourceSha },
});

async function makeFlow(extra: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  const { __approve, ...fields } = extra as {
    __approve?: { slug: string; sourceSha: string };
  } & Record<string, unknown>;
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
    ...fields,
  });
  if (__approve) {
    const row = (await Flow.findById(_id).lean()) as any;
    await Flow.collection.updateOne(
      { _id },
      {
        $set: {
          boxedApproval: {
            by: "owner",
            at: new Date(),
            kind: boxedKind(row),
            slug: __approve.slug,
            ...approvalBinding(row),
            sourceSha: __approve.sourceSha,
          },
        },
      },
    );
  }
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
  mocks.cancelBackfill.mockReset();
  mocks.cancelBackfill.mockResolvedValue(undefined);
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

describe("review attacks", () => {
  const def = (extra: Record<string, unknown> = {}) => ({
    slug: "close",
    sha: "sha",
    sourceSha: "source-sha",
    entry: "connector.ts",
    runtime: "node",
    entities: ["leads"],
    spec: CLOSE_SPEC,
    status: "indexed",
    ...extra,
  });

  it("1. refuses the key to code pushed after the approval", async () => {
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    mocks.loadConnectorDefinition.mockResolvedValue(
      def({ sourceSha: "pushed-by-a-member" }),
    );
    await expect(applyFlowRuntime(decrypted(), await lean(id))).rejects.toThrow(
      /changed since an owner\/admin approved it/,
    );
  });

  it("1. refuses a folder that names itself after another registry connector", async () => {
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    mocks.loadConnectorDefinition.mockResolvedValue(
      def({
        sourceSha: "other",
        registry: {
          ref: "mako/evil@1",
          slug: "evil",
          version: "1.0.0",
          hash: "h",
          sha256: "s",
        },
      }),
    );
    await expect(applyFlowRuntime(decrypted(), await lean(id))).rejects.toThrow(
      /changed since/,
    );
  });

  it("1. accepts Mako's registry connector for the same type at any hash", async () => {
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    mocks.loadConnectorDefinition.mockResolvedValue(
      def({
        sourceSha: "registry-upgrade",
        registry: {
          ref: "mako/close@1",
          slug: "close",
          version: "1.1.0",
          hash: "h2",
          sha256: "s",
        },
      }),
    );
    const out = await applyFlowRuntime(decrypted(), await lean(id));
    expect(out.type).toBe("ws:close");
  });

  it("1. re-checks the code where the box loads it, so a push after the check is refused", async () => {
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    const rewritten = await applyFlowRuntime(decrypted(), await lean(id));
    expect(rewritten.boxedPin).toEqual({
      connectionType: "close",
      sourceSha: "source-sha",
    });
    mocks.loadConnectorDefinition.mockResolvedValue(
      def({ sourceSha: "pushed-between-check-and-run" }),
    );
    await expect(
      syncConnectorRegistry.getConnectorFor(rewritten),
    ).rejects.toThrow(/changed since/);
  });

  it("2. voids the approval when the destination moves under it", async () => {
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    await Flow.collection.updateOne(
      { _id: id },
      { $set: { "tableDestination.schema": "somewhere_else" } },
    );
    const source = decrypted();
    expect(await applyFlowRuntime(source, await lean(id))).toBe(source);
  });

  it("2. a shadow's approval never boxes a flow whose file dropped shadow_of", async () => {
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
    // The file drops `shadow_of:`, says `runtime: boxed` and points at live.
    await Flow.collection.updateOne(
      { _id: shadow },
      {
        $unset: { shadowOf: 1 },
        $set: {
          connectorRuntime: "boxed",
          tableDestination: {
            connectionId: db,
            schema: "pl_close",
            tableName: "",
          },
        },
      },
    );
    const source = decrypted();
    expect(await applyFlowRuntime(source, await lean(shadow))).toBe(source);
  });

  it("5. a chunk naming another workspace's flow id runs as before", async () => {
    const foreignWs = new Types.ObjectId();
    const foreign = new Types.ObjectId();
    await Flow.collection.insertOne({
      _id: foreign,
      workspaceId: foreignWs,
      dataSourceId: conn,
      connectorRuntime: "boxed",
    });
    const source = decrypted();
    expect(await applyFlowRuntimeById(source, String(foreign))).toBe(source);
  });

  it("a switch waits while either flow has a run in flight: two writers never race", async () => {
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
    for (const running of [live, shadow]) {
      await FlowExecution.collection.insertOne({
        flowId: running,
        workspaceId: ws,
        status: "running",
        startedAt: new Date(),
        success: false,
        logs: [],
      });
      await expect(
        switchFlowRuntime({
          flow: (await Flow.findById(live))!,
          target: "boxed",
          force: true,
        }),
      ).rejects.toThrow(/in flight/);
      await FlowExecution.collection.deleteMany({});
    }
  });
});

describe("review round 2", () => {
  it("C. refuses a shadow that names another table connection but writes the live dataset", async () => {
    const live = await makeFlow();
    const shadow = await makeFlow({
      shadowOf: live,
      ...approved(),
      destinationDatabaseName: "elsewhere",
      tableDestination: {
        connectionId: new Types.ObjectId(),
        database: "x",
        schema: "pl_close",
        tableName: "shadow_",
      },
    });
    await expect(
      applyFlowRuntime(decrypted(), await lean(shadow)),
    ).rejects.toThrow(/writes the live flow's dataset/);
  });

  it("F. a chunk stays on the runtime its run decided", async () => {
    const id = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    const source = decrypted();
    // Decided built-in at the start: stays built-in though the flow is boxed now.
    expect(await applyFlowRuntimeById(source, String(id), "builtin")).toBe(
      source,
    );
    // Decided boxed, then switched back: the run stops, no cursor crosses.
    await Flow.collection.updateOne(
      { _id: id },
      { $unset: { connectorRuntime: 1, boxedApproval: 1 } },
    );
    await expect(
      applyFlowRuntimeById(source, String(id), "boxed"),
    ).rejects.toThrow(/can no longer run boxed/);
    // Decided boxed, then the flag went off: the same.
    const again = await makeFlow({ connectorRuntime: "boxed", ...approved() });
    process.env.CONNECTOR_BOXED_SWITCH = "false";
    await expect(
      applyFlowRuntimeById(source, String(again), "boxed"),
    ).rejects.toThrow(/can no longer run boxed/);
  });

  it("H. stop cancels a shadow backfill in progress", async () => {
    const live = await makeFlow();
    await makeFlow({
      shadowOf: live,
      ...approved(),
      tableDestination: {
        connectionId: db,
        schema: "pl_close_shadow",
        tableName: "",
      },
      backfillState: { status: "running", runId: "r1" },
    });
    const out = await stopShadow({ live: (await Flow.findById(live))! });
    expect(out?.cancelledBackfill).toBe(true);
    expect(mocks.cancelBackfill).toHaveBeenCalledTimes(1);
  });

  it("E. start on a shadow already running this twin never restarts its backfill", async () => {
    const live = await makeFlow();
    const first = await startShadow({
      live: (await Flow.findById(live))!,
      userId: "u",
    });
    await Flow.collection.updateOne(
      { _id: new Types.ObjectId(first.shadowFlowId) },
      {
        $set: {
          backfillState: {
            status: "completed",
            completedAt: new Date(),
            runId: "run-1",
          },
        },
      },
    );
    mocks.startBackfill.mockClear();
    const again = await startShadow({
      live: (await Flow.findById(live))!,
      userId: "u",
    });
    expect(again.created).toBe(false);
    expect(mocks.startBackfill).not.toHaveBeenCalled();
    // New twin code: the shadow restarts its evidence.
    mocks.loadConnectorDefinition.mockResolvedValue({
      slug: "close",
      sha: "sha2",
      sourceSha: "source-sha-2",
      entry: "connector.ts",
      runtime: "node",
      entities: ["leads"],
      spec: CLOSE_SPEC,
      status: "indexed",
    });
    await startShadow({ live: (await Flow.findById(live))!, userId: "u" });
    expect(mocks.startBackfill).toHaveBeenCalledTimes(1);
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

  async function switchedPair() {
    const live = await makeFlow({ connectorRuntime: undefined });
    const twin = await makeFlow({
      replaces: live,
      connectorRuntime: "boxed",
      webhookConfig: undefined,
      ...approved(),
    });
    await Flow.collection.updateOne(
      { _id: live },
      {
        $set: {
          "webhookConfig.enabled": false,
          "schedule.enabled": false,
          boxedSwitch: { to: twin, by: "owner", at: new Date(), webhook: true },
        },
      },
    );
    return { live, twin };
  }

  it("a paused built-in flow verifies each delivery and forwards it to its twin's box lane", async () => {
    builtinVerifies();
    const { live, twin } = await switchedPair();
    const body = JSON.stringify({ event: { id: "ev_fwd" } });
    expect((await deliver(live, body)).status).toBe(200);
    expect(await WebhookEvent.countDocuments({ flowId: live })).toBe(0);
    const forwarded = await WebhookEvent.findOne({ flowId: twin }).lean();
    expect(forwarded).toMatchObject({
      lane: "box",
      status: "pending",
      eventId: "ev_fwd",
    });
    expect(String(forwarded!.dataSourceId)).toBe(String(conn));
  });

  it("forwards to the twin's inline lane when it cannot run boxed (flag off)", async () => {
    builtinVerifies();
    const { live, twin } = await switchedPair();
    process.env.CONNECTOR_BOXED_SWITCH = "false";
    const body = JSON.stringify({ event: { id: "ev_fwd_off" } });
    expect((await deliver(live, body)).status).toBe(200);
    const forwarded = await WebhookEvent.findOne({ flowId: twin }).lean();
    expect(forwarded?.eventId).toBe("ev_fwd_off");
    expect(forwarded?.lane).toBeUndefined();
  });

  it("refuses a delivery to a paused flow whose named twin does not name it back", async () => {
    builtinVerifies();
    const live = await makeFlow();
    const stranger = await makeFlow({ webhookConfig: undefined });
    await Flow.collection.updateOne(
      { _id: live },
      {
        $set: {
          "webhookConfig.enabled": false,
          boxedSwitch: { to: stranger, webhook: true },
        },
      },
    );
    const res = await deliver(live, JSON.stringify({ event: { id: "ev_x" } }));
    expect(res.status).toBe(403);
    expect(await WebhookEvent.countDocuments({})).toBe(0);
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
    // Boxed by shadowOf alone; no runtime a file could carry to live.
    expect(shadow.connectorRuntime).toBeUndefined();
    expect(shadow.boxedApproval).toMatchObject({
      by: "u",
      kind: "shadow",
      slug: "close",
      connectionId: String(conn),
      shadowOf: String(id),
      sourceSha: "source-sha",
    });
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

  it("refuses a switch while the gate is closed; with force, promotes the shadow and pauses the built-in; back in one call", async () => {
    const live = await makeFlow({
      backfillSchedule: { enabled: true, cron: "0 3 * * 0", timezone: "UTC" },
    });
    await expect(
      switchFlowRuntime({
        flow: (await Flow.findById(live))!,
        target: "boxed",
      }),
    ).rejects.toThrow(/No shadow/);
    const started = await startShadow({
      live: (await Flow.findById(live))!,
      userId: "u",
    });
    const shadow = new Types.ObjectId(started.shadowFlowId);
    await expect(
      switchFlowRuntime({
        flow: (await Flow.findById(live))!,
        target: "boxed",
      }),
    ).rejects.toThrow(/parity gate is closed/);

    const out = await switchFlowRuntime({
      flow: (await Flow.findById(live))!,
      target: "boxed",
      force: true,
      userId: "owner",
    });
    expect(out).toMatchObject({
      runtime: "boxed",
      forced: true,
      writerFlowId: String(shadow),
    });

    // The built-in is paused: poll, webhook and resync off, crons kept.
    const paused = await lean(live);
    expect(paused.schedule.enabled).toBe(false);
    expect(paused.webhookConfig.enabled).toBe(false);
    expect(paused.backfillSchedule.enabled).toBe(false);
    expect(paused.boxedSwitch).toMatchObject({
      to: shadow,
      webhook: true,
      poll: { enabled: true, cron: "0 * * * *" },
      resync: { enabled: true, cron: "0 3 * * 0" },
    });
    // The shadow writes the live dataset, with the live triggers.
    const writer = await lean(shadow);
    expect(writer.shadowOf).toBeUndefined();
    expect(String(writer.replaces)).toBe(String(live));
    expect(writer.tableDestination.schema).toBe("pl_close");
    expect(writer.backfillSchedule).toMatchObject({
      enabled: true,
      cron: "0 3 * * 0",
    });
    expect(writer.boxedApproval).toMatchObject({
      kind: "switch",
      slug: "close",
    });
    // It runs boxed on the live dataset; the paused built-in never runs.
    expect((await applyFlowRuntime(decrypted(), writer)).type).toBe("ws:close");
    await expect(applyFlowRuntime(decrypted(), paused)).rejects.toThrow(
      /paused/,
    );

    // A forwarded event pending in the twin goes back to the built-in.
    await WebhookEvent.create({
      flowId: shadow,
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
      flow: (await Flow.findById(live))!,
      target: "builtin",
    });
    expect(back).toMatchObject({
      runtime: "builtin",
      changed: true,
      relaned: 1,
      writerFlowId: String(live),
    });
    const restored = await lean(live);
    expect(restored.boxedSwitch).toBeUndefined();
    expect(restored.schedule).toMatchObject({
      enabled: true,
      cron: "0 * * * *",
    });
    expect(restored.webhookConfig.enabled).toBe(true);
    expect(restored.backfillSchedule).toMatchObject({
      enabled: true,
      cron: "0 3 * * 0",
    });
    const stopped = await lean(shadow);
    expect(String(stopped.shadowOf)).toBe(String(live));
    expect(stopped.replaces).toBeUndefined();
    expect(stopped.tableDestination.schema).toBe("pl_close_shadow");
    expect(stopped.schedule.enabled).toBe(false);
    expect(stopped.boxedApproval).toBeUndefined();
    const event = await WebhookEvent.findOne({ eventId: "ev_pending" }).lean();
    expect(String(event!.flowId)).toBe(String(live));
    expect(event!.lane).toBeUndefined();
  });

  it("refuses to switch a webhook flow whose twin declares no verification", async () => {
    const live = await makeFlow();
    await makeFlow({
      shadowOf: live,
      ...approved(),
      tableDestination: {
        connectionId: db,
        schema: "pl_close_shadow",
        tableName: "",
      },
    });
    mocks.loadConnectorDefinition.mockResolvedValue({
      slug: "close",
      sourceSha: "source-sha",
      entities: ["leads"],
      spec: { connectionSpecification: CLOSE_SPEC.connectionSpecification },
      status: "indexed",
    });
    await expect(
      switchFlowRuntime({
        flow: (await Flow.findById(live))!,
        target: "boxed",
        force: true,
      }),
    ).rejects.toThrow(/declares no webhook verification/);
  });

  it("refuses a promoted twin whose replaced flow is not paused for it", async () => {
    const live = await makeFlow();
    const twin = await makeFlow({
      replaces: live,
      connectorRuntime: "boxed",
      ...approved(),
    });
    await expect(
      applyFlowRuntime(decrypted(), await lean(twin)),
    ).rejects.toThrow(/not paused for it/);
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

  it("stores a clean check and opens the gate once 30 min of live updates are covered", async () => {
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
    expect(check.window?.coverageMinutes).toBe(30);
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

  it("reports differing values with samples without blocking; a new NULL blocks", async () => {
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
    expect(check.clean).toBe(true);
    expect(check.entities[0].notes.join(" ")).toMatch(
      /3 rows differ in field values/,
    );
    expect(check.entities[0].topFields).toEqual([
      {
        field: "name",
        rows: 3,
        samples: [{ key: '{"id":"lead_1"}', live: '"A"', shadow: '"B"' }],
      },
    ]);

    const nulls = fakeQuery(
      summary({ rows_differing: 2, d2: 2, n2: 2, new_null_rows: 2 }),
    );
    const bad = await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "manual",
      deps: {
        query: nulls.query,
        keyColumns: async () => ["id"],
        // A minute later, so it is the latest check.
        now: () => new Date(now.getTime() + 60_000),
      },
    });
    expect(bad.clean).toBe(false);
    const gate = await parityGate(
      { _id: live, workspaceId: ws },
      new Date(now.getTime() + 120_000),
    );
    expect(gate.open).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(
      /2 rows have a value on live and NULL on the shadow \(name 2\)/,
    );
  });

  it("blocks on a key gap, a missing live column, and a failed shadow run in the window", async () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const { shadow } = await shadowPair(new Date("2026-11-17T09:00:00Z"));
    const gap = await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "manual",
      deps: {
        query: fakeQuery(summary({ shadow_only: 1 })).query,
        keyColumns: async () => ["id"],
        now: () => now,
      },
    });
    expect(gap.reasons.join(" ")).toMatch(/1 of 98 keys are on one side only/);

    const missingColumn = fakeQuery(summary());
    const query = async (d: unknown, sql: string) => {
      if (
        sql.includes("INFORMATION_SCHEMA") &&
        sql.includes("pl_close_shadow")
      ) {
        return ["id", "_mako_source_ts", "_syncedAt", "_mako_deleted_at"].map(
          column_name => ({ table_name: "leads", column_name }),
        );
      }
      return missingColumn.query(d, sql);
    };
    const cols = await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "manual",
      deps: { query, keyColumns: async () => ["id"], now: () => now },
    });
    expect(cols.reasons.join(" ")).toMatch(
      /the shadow lacks 1 live column: name/,
    );

    await FlowExecution.collection.insertOne({
      flowId: shadow,
      workspaceId: ws,
      status: "failed",
      startedAt: new Date("2026-11-17T11:40:00Z"),
      success: false,
      logs: [],
    });
    const failed = await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "manual",
      deps: {
        query: fakeQuery(summary()).query,
        keyColumns: async () => ["id"],
        now: () => now,
      },
    });
    expect(failed.errors).toMatchObject({ failedRuns: 1 });
    expect(failed.reasons.join(" ")).toMatch(
      /1 shadow run failed in the window/,
    );
  });

  it("4. refuses a dataset name that is not plain, before any SQL", async () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const { shadow } = await shadowPair(new Date("2026-11-17T09:00:00Z"));
    await Flow.collection.updateOne(
      { _id: shadow },
      { $set: { "tableDestination.schema": "x\\` OR 1=1 --" } },
    );
    const { query, sqls } = fakeQuery(summary());
    const check = await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "manual",
      deps: { query, keyColumns: async () => ["id"], now: () => now },
    });
    expect(check.status).toBe("error");
    expect(check.error).toMatch(/dataset name/);
    expect(sqls).toHaveLength(0);
  });

  it("keeps the gate closed until the window covers 30 min after the backfill", async () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const { live, shadow } = await shadowPair(new Date("2026-11-17T11:30:00Z"));
    const { query } = fakeQuery(summary());
    await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "scheduled",
      deps: { query, keyColumns: async () => ["id"], now: () => now },
    });
    const gate = await parityGate({ _id: live, workspaceId: ws }, now);
    expect(gate.open).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(/covers 20 min/);
  });

  it("A. keeps the gate closed for an entity the shadow never synced", async () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const { live, shadow } = await shadowPair(new Date("2026-11-17T09:00:00Z"));
    await CdcEntityState.collection.insertOne({
      flowId: live,
      workspaceId: ws,
      entity: "subscriptions",
    });
    const { query } = fakeQuery(summary());
    const check = await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "manual",
      deps: { query, keyColumns: async () => ["id"], now: () => now },
    });
    expect(check.clean).toBe(false);
    expect(check.reasons.join(" ")).toMatch(
      /has not synced 1 entity .*subscriptions/,
    );
  });

  it("D. a clean check opens no gate for other twin code, nor after a new backfill", async () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const { live, shadow } = await shadowPair(new Date("2026-11-17T09:00:00Z"));
    const { query } = fakeQuery(summary());
    await runParityCheck({
      shadowFlowId: String(shadow),
      trigger: "manual",
      deps: { query, keyColumns: async () => ["id"], now: () => now },
    });
    const ref = { _id: live, workspaceId: ws };
    expect(
      (await parityGate(ref, now, { slug: "close", sourceSha: "source-sha" }))
        .open,
    ).toBe(true);
    const otherCode = await parityGate(ref, now, {
      slug: "close",
      sourceSha: "pushed",
    });
    expect(otherCode.open).toBe(false);
    expect(otherCode.reasons.join(" ")).toMatch(/latest check ran close/);
    expect(
      (
        await parityGate(ref, now, {
          slug: "close-v2",
          sourceSha: "source-sha",
        })
      ).open,
    ).toBe(false);
    await Flow.collection.updateOne(
      { _id: shadow },
      {
        $set: { "backfillState.completedAt": new Date("2026-11-17T11:59:00Z") },
      },
    );
    const rebackfilled = await parityGate(ref, now);
    expect(rebackfilled.reasons.join(" ")).toMatch(
      /predates the shadow's current backfill/,
    );
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
    expect(out).toMatchObject({
      runtime: "boxed",
      forced: false,
      writerFlowId: String(shadow),
    });
  });
});
