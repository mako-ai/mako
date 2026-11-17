/**
 * Webhook batches for workspace connectors, against a real in-memory Mongo.
 *
 * The box is a fake runner (the one seam), so these check the API side of
 * every trust boundary:
 * - ingress verifies in the API with the flow's secret and puts a boxed
 *   connector's events in their own lane, pinned to their connection;
 * - the inline cron never touches that lane;
 * - a batch holds one flow's events for its current connection only, never
 *   the signing secret, and stays under its count and byte caps;
 * - nothing the box answers is trusted: undeclared entities, malformed
 *   records, missing outcomes, system keys and oversized answers are all
 *   contained to the events they belong to;
 * - a failed or timed-out box fails its own batch and ends the run.
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
}));

vi.mock("../../sync-cdc/ingest", () => ({
  cdcIngestService: { appendNormalizedEvents: mocks.appendNormalizedEvents },
}));
vi.mock("./resolver", async importOriginal => ({
  ...(await importOriginal<typeof import("./resolver")>()),
  loadConnectorDefinition: mocks.loadConnectorDefinition,
}));

import {
  DatabaseConnection,
  Flow,
  SourceConnection,
  WebhookEvent,
} from "../../database/workspace-schema";
import { webhookRoutes } from "../../routes/webhooks";
import { ingestPendingWebhookEvents } from "../../inngest/functions/webhook-flow";
import {
  BOX_CODES,
  cutBatch,
  flowsWithPendingBoxWebhooks,
  processBoxWebhookBatch,
  type WebhookBatchRunner,
} from "./webhook-batch";
import { ConnectorOutputTooLargeError, type RunResult } from "./sync-box";
import { WEBHOOK_BATCH_DEFAULTS } from "./webhook-config";

const SECRET = "0f".repeat(32);
const CLOSE_VERIFICATION = {
  scheme: "hmac-sha256",
  secretEncoding: "hex",
  signedPayload: ["header:close-sig-timestamp", "body"],
  signatureHeader: "close-sig-hash",
  signatureEncoding: "hex",
};

let mongo: MongoMemoryServer;
const ws = new Types.ObjectId();
const conn = new Types.ObjectId();
const otherConn = new Types.ObjectId();
const db = new Types.ObjectId();
let flowId: Types.ObjectId;
let otherFlowId: Types.ObjectId;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

async function makeFlow(dataSourceId: Types.ObjectId, extra = {}) {
  const _id = new Types.ObjectId();
  await Flow.collection.insertOne({
    _id,
    workspaceId: ws,
    type: "webhook",
    dataSourceId,
    destinationDatabaseId: db,
    syncEngine: "cdc",
    tableDestination: { connectionId: db },
    entityFilter: ["leads", "contacts"],
    webhookConfig: {
      enabled: true,
      secret: SECRET,
      endpoint: `/api/webhooks/${ws}/${_id}`,
    },
    ...extra,
  });
  return _id;
}

beforeEach(async () => {
  process.env.CONNECTOR_WEBHOOK_BATCHES = "true";
  mocks.appendNormalizedEvents.mockReset();
  mocks.appendNormalizedEvents.mockResolvedValue({ inserted: 0, deduped: 0 });
  mocks.loadConnectorDefinition.mockReset();
  mocks.loadConnectorDefinition.mockResolvedValue({
    slug: "close",
    sha: "sha",
    sourceSha: "source-sha",
    entry: "connector.ts",
    runtime: "node",
    entities: ["leads", "contacts", "users"],
    spec: { mako: { webhooks: { verification: CLOSE_VERIFICATION } } },
    status: "indexed",
  });
  await Promise.all([
    WebhookEvent.deleteMany({}),
    Flow.collection.deleteMany({}),
    SourceConnection.collection.deleteMany({}),
    DatabaseConnection.collection.deleteMany({}),
  ]);
  await SourceConnection.collection.insertMany([
    {
      _id: conn,
      workspaceId: ws,
      name: "PL Close shadow",
      type: "ws:close",
      config: { api_key: "api_key_pl" },
    },
    {
      _id: otherConn,
      workspaceId: ws,
      name: "Other",
      type: "ws:close",
      config: { api_key: "api_key_other" },
    },
  ]);
  await DatabaseConnection.collection.insertOne({
    _id: db,
    workspaceId: ws,
    name: "bq",
    type: "bigquery",
  });
  flowId = await makeFlow(conn);
  otherFlowId = await makeFlow(otherConn);
});

let seq = 0;
async function boxEvent(
  fid = flowId,
  dataSourceId = conn,
  rawPayload: unknown = { event: { id: `ev${seq}` } },
  extra = {},
) {
  seq++;
  const doc = await WebhookEvent.create({
    flowId: fid,
    workspaceId: ws,
    eventId: `ev_${seq}`,
    eventType: "lead.updated",
    receivedAt: new Date(Date.UTC(2026, 10, 17, 8, 0, seq)),
    status: "pending",
    rawPayload,
    lane: "box",
    dataSourceId,
    ...extra,
  });
  return doc;
}

/** A fake box: records what it was handed, answers with `answer`. */
function fakeRunner(
  answer: (events: any[]) => RunResult | Promise<RunResult>,
  declared = ["leads", "contacts", "users"],
) {
  const calls: Array<{ connectionId: string; batch: any; timeoutMs: number }> =
    [];
  const factory = async (
    connectionId: string,
  ): Promise<WebhookBatchRunner> => ({
    declaredEntities: async () => declared,
    runWebhookBatch: async (batch, options) => {
      calls.push({ connectionId, batch, timeoutMs: options.timeoutMs });
      return answer(batch.events);
    },
  });
  return { factory, calls };
}

const ok = (messages: any[]): RunResult => ({
  exitCode: 0,
  messages,
  malformed: [],
  stderr: "",
  timedOut: false,
});

const leadOutcome = (e: any, extra: Record<string, unknown> = {}) => ({
  type: "WEBHOOK",
  webhook: {
    eventId: e.eventId,
    outcome: "records",
    records: [
      {
        entity: "leads",
        recordId: `lead_${e.eventId}`,
        operation: "upsert",
        payload: { id: `lead_${e.eventId}`, name: "Lead", contacts: [] },
        sourceTs: "2026-11-17T08:00:00.000Z",
        changeId: e.eventId,
        ...extra,
      },
    ],
  },
});

describe("ingress", () => {
  const sign = (body: string, ts = "1763290800") =>
    createHmac("sha256", Buffer.from(SECRET, "hex"))
      .update(ts + body)
      .digest("hex");

  async function deliver(body: string, headers: Record<string, string>) {
    return webhookRoutes.request(`/webhooks/${ws}/${flowId}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  it("verifies in the API and stores a boxed connector's event in the box lane, pinned to its connection", async () => {
    const body = JSON.stringify({
      event: { id: "ev_real", object_type: "lead", action: "updated" },
    });
    const res = await deliver(body, {
      "close-sig-hash": sign(body),
      "close-sig-timestamp": "1763290800",
    });
    expect(res.status).toBe(200);
    const stored = await WebhookEvent.findOne({ eventId: "ev_real" }).lean();
    expect(stored).toMatchObject({
      lane: "box",
      status: "pending",
      eventType: "lead.updated",
    });
    expect(String(stored!.dataSourceId)).toBe(String(conn));
    // The signing secret is nowhere in what was stored.
    expect(JSON.stringify(stored)).not.toContain(SECRET);
  });

  it("refuses a delivery whose signature does not match", async () => {
    const body = JSON.stringify({ event: { id: "ev_forged" } });
    const res = await deliver(body, {
      "close-sig-hash": sign(`${body} `),
      "close-sig-timestamp": "1763290800",
    });
    expect(res.status).toBe(400);
    expect(await WebhookEvent.countDocuments({})).toBe(0);
  });

  it("refuses every delivery when the connector declares no verification", async () => {
    mocks.loadConnectorDefinition.mockResolvedValue({
      slug: "close",
      sha: "sha",
      sourceSha: "source-sha",
      entities: ["leads"],
      spec: { mako: {} },
    });
    const body = JSON.stringify({ event: { id: "ev_x" } });
    const res = await deliver(body, {
      "close-sig-hash": sign(body),
      "close-sig-timestamp": "1763290800",
    });
    expect(res.status).toBe(400);
    expect(await WebhookEvent.countDocuments({})).toBe(0);
  });

  it("answers 503, never 2xx, when the connector's definition cannot load", async () => {
    mocks.loadConnectorDefinition.mockRejectedValue(
      new Error('The connector "close" is blocked'),
    );
    const body = JSON.stringify({ event: { id: "ev_blocked" } });
    const res = await deliver(body, {
      "close-sig-hash": sign(body),
      "close-sig-timestamp": "1763290800",
    });
    expect(res.status).toBe(503);
    expect(await WebhookEvent.countDocuments({})).toBe(0);
  });

  it("with the flag off, keeps today's path: no lane, the shared-token check", async () => {
    process.env.CONNECTOR_WEBHOOK_BATCHES = "false";
    const body = JSON.stringify({ id: "ev_token", type: "x" });
    const res = await deliver(body, { "x-mako-webhook-token": SECRET });
    expect(res.status).toBe(200);
    const stored = await WebhookEvent.findOne({ eventId: "ev_token" }).lean();
    expect(stored?.lane).toBeUndefined();
    expect(mocks.loadConnectorDefinition).not.toHaveBeenCalled();
  });
});

describe("the inline cron", () => {
  it("never claims a box-lane event", async () => {
    const box = await boxEvent();
    await WebhookEvent.create({
      flowId: new Types.ObjectId(),
      workspaceId: ws,
      eventId: "inline_1",
      eventType: "x",
      status: "pending",
      rawPayload: {},
    });
    const logger = { info: () => {}, warn: () => {} };
    const result = await ingestPendingWebhookEvents(logger);
    expect(result.dropped).toBe(1);
    const after = await WebhookEvent.findById(box._id).lean();
    expect(after).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("a batch", () => {
  it("hands the box one flow's events for its own connection, and writes their records", async () => {
    const mine = [await boxEvent(), await boxEvent()];
    await boxEvent(otherFlowId, otherConn);
    const box = fakeRunner(events => ok(events.map(e => leadOutcome(e))));

    const result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });

    expect(result).toMatchObject({ claimed: 2, ingested: 2, failed: 0 });
    expect(result.entities).toEqual(["leads"]);
    expect(box.calls).toHaveLength(1);
    expect(box.calls[0].connectionId).toBe(String(conn));
    expect(box.calls[0].timeoutMs).toBe(WEBHOOK_BATCH_DEFAULTS.timeoutMs);
    expect(box.calls[0].batch.events.map((e: any) => e.eventId)).toEqual(
      mine.map(e => e.eventId),
    );
    // The events, as stored, and nothing else: no secret, no headers.
    expect(Object.keys(box.calls[0].batch.events[0]).sort()).toEqual([
      "eventId",
      "eventType",
      "rawPayload",
      "receivedAt",
    ]);
    expect(JSON.stringify(box.calls[0].batch)).not.toContain(SECRET);

    const [call] = mocks.appendNormalizedEvents.mock.calls;
    expect(call[0].flowId).toBe(String(flowId));
    expect(call[0].events[0]).toMatchObject({
      entity: "leads",
      recordId: `lead_${mine[0].eventId}`,
      operation: "upsert",
      source: "webhook",
      changeId: mine[0].eventId,
      payload: expect.objectContaining({
        _dataSourceId: String(conn),
        _dataSourceName: "PL Close shadow",
      }),
    });
    const stored = await WebhookEvent.find({ flowId }).lean();
    expect(stored.every(e => e.status === "completed")).toBe(true);
    expect(stored.every(e => e.applyStatus === "pending")).toBe(true);
    // The other flow's event was never touched.
    expect(
      await WebhookEvent.findOne({ flowId: otherFlowId }).lean(),
    ).toMatchObject({ status: "pending" });
  });

  it("drops events verified for a connection the flow no longer uses", async () => {
    const stale = await boxEvent(flowId, otherConn);
    const box = fakeRunner(events => ok(events.map(e => leadOutcome(e))));
    const result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });
    expect(result.next).toBe("empty");
    expect(box.calls).toHaveLength(0);
    expect(await WebhookEvent.findById(stale._id).lean()).toMatchObject({
      status: "completed",
      applyStatus: "dropped",
      applyError: { code: BOX_CODES.connectionChanged },
    });
  });

  it("is capped in count and in bytes, and fails an event too large for any batch", async () => {
    const limits = {
      ...WEBHOOK_BATCH_DEFAULTS,
      maxEvents: 3,
      maxBytes: 2_000,
    };
    for (let i = 0; i < 5; i++) await boxEvent();
    const box = fakeRunner(events => ok(events.map(e => leadOutcome(e))));
    let result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
      limits,
    });
    expect(result).toMatchObject({ claimed: 3, next: "more" });

    const big = await boxEvent(flowId, conn, { blob: "x".repeat(3_000) });
    result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
      limits,
    });
    expect(result).toMatchObject({ claimed: 2 });
    result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
      limits,
    });
    expect(result).toMatchObject({ failed: 1, next: "more" });
    expect(await WebhookEvent.findById(big._id).lean()).toMatchObject({
      status: "failed",
      attempts: 5,
      applyError: { code: BOX_CODES.eventTooLarge },
    });
    for (const call of box.calls) {
      expect(call.batch.events.length).toBeLessThanOrEqual(3);
      expect(Buffer.byteLength(JSON.stringify(call.batch))).toBeLessThanOrEqual(
        2_000,
      );
    }
  });

  it("trusts nothing in the box's answer", async () => {
    const events: Array<{ eventId: string }> = [];
    for (let i = 0; i < 7; i++) events.push(await boxEvent());
    const box = fakeRunner(batch =>
      ok([
        // 0: an entity the connector never declared, and a valid record.
        {
          type: "WEBHOOK",
          webhook: {
            eventId: batch[0].eventId,
            outcome: "records",
            records: [
              {
                entity: "secret_table",
                recordId: "x",
                operation: "upsert",
                payload: { id: "x" },
              },
              {
                entity: "leads",
                recordId: "lead_ok",
                operation: "upsert",
                // System keys are Mako's: a connector cannot set them.
                payload: {
                  id: "lead_ok",
                  _dataSourceId: "someone_else",
                  _mako_deleted_at: "2020-01-01",
                },
              },
            ],
          },
        },
        // 1: only invalid records.
        {
          type: "WEBHOOK",
          webhook: {
            eventId: batch[1].eventId,
            outcome: "records",
            records: [{ entity: "leads", operation: "upsert", payload: {} }],
          },
        },
        // 2: too many records.
        {
          type: "WEBHOOK",
          webhook: {
            eventId: batch[2].eventId,
            outcome: "records",
            records: Array.from({ length: 1_001 }, (_, i) => ({
              entity: "leads",
              recordId: `l${i}`,
              operation: "upsert",
              payload: {},
            })),
          },
        },
        // 3: no outcome at all. An outcome for an event not in the batch.
        {
          type: "WEBHOOK",
          webhook: { eventId: "ev_not_in_batch", outcome: "unmapped" },
        },
        // 4: skipped on purpose.
        {
          type: "WEBHOOK",
          webhook: {
            eventId: batch[4].eventId,
            outcome: "skipped",
            reason: "gone",
          },
        },
        // 5: an entity the flow does not sync.
        {
          type: "WEBHOOK",
          webhook: {
            eventId: batch[5].eventId,
            outcome: "records",
            records: [
              {
                entity: "users",
                recordId: "u1",
                operation: "upsert",
                payload: { id: "u1" },
              },
            ],
          },
        },
        // 6: unmapped.
        {
          type: "WEBHOOK",
          webhook: { eventId: batch[6].eventId, outcome: "unmapped" },
        },
        // A second answer for 6 is ignored.
        leadOutcome(batch[6]),
      ]),
    );
    const result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });
    expect(result).toMatchObject({
      claimed: 7,
      ingested: 1,
      failed: 3,
      dropped: 2,
      applied: 1,
    });
    const written = mocks.appendNormalizedEvents.mock.calls[0][0].events;
    expect(written).toHaveLength(1);
    expect(written[0].recordId).toBe("lead_ok");
    expect(written[0].payload._dataSourceId).toBe(String(conn));
    expect(written[0].payload._mako_deleted_at).toBeUndefined();

    const byId = new Map(
      (await WebhookEvent.find({ flowId }).lean()).map(e => [e.eventId, e]),
    );
    const at = (i: number) => byId.get(events[i].eventId)!;
    expect(at(0)).toMatchObject({
      status: "completed",
      applyStatus: "pending",
    });
    expect(at(1)).toMatchObject({
      status: "failed",
      applyError: { code: "EXTRACT_FAILED" },
    });
    expect(at(2)).toMatchObject({
      status: "failed",
      attempts: 5,
      applyError: { code: BOX_CODES.tooManyRecords },
    });
    expect(at(3)).toMatchObject({
      status: "failed",
      applyError: { code: BOX_CODES.noOutcome },
    });
    expect(at(4)).toMatchObject({
      status: "completed",
      applyStatus: "dropped",
      applyError: { code: BOX_CODES.skipped, message: "gone" },
    });
    expect(at(5)).toMatchObject({
      applyStatus: "dropped",
      applyError: { code: "ENTITY_DISABLED" },
    });
    expect(at(6)).toMatchObject({
      status: "completed",
      applyStatus: "applied",
    });
  });

  /** Run batches of the flow until it settles or `max` runs. */
  async function drain(runner: ReturnType<typeof fakeRunner>, max = 20) {
    const results = [];
    for (let i = 0; i < max; i++) {
      const result = await processBoxWebhookBatch({
        flowId: String(flowId),
        runner: runner.factory,
      });
      results.push(result);
      if (result.next === "empty") break;
    }
    return results;
  }

  it("a timed-out box costs one run, blames no event of a larger batch, and halves the next one", async () => {
    const mine = [await boxEvent(), await boxEvent()];
    const theirs = await boxEvent(otherFlowId, otherConn);
    const box = fakeRunner(() => ({
      exitCode: 124,
      messages: [],
      malformed: [],
      stderr: "",
      timedOut: true,
    }));
    const result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });
    expect(result).toMatchObject({ next: "stop", failed: 0, claimed: 2 });
    expect(box.calls).toHaveLength(1);
    for (const e of mine) {
      expect(await WebhookEvent.findById(e._id).lean()).toMatchObject({
        status: "pending",
        attempts: 0,
      });
    }
    expect(
      (await Flow.collection.findOne({ _id: flowId }))?.webhookConfig
        ?.boxBatchSize,
    ).toBe(1);
    expect(mocks.appendNormalizedEvents).not.toHaveBeenCalled();
    expect(await WebhookEvent.findById(theirs._id).lean()).toMatchObject({
      status: "pending",
    });

    // Alone, an event that still times out is failed for the retry cron.
    await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });
    expect(await WebhookEvent.findById(mine[0]._id).lean()).toMatchObject({
      status: "failed",
      attempts: 1,
      applyError: {
        code: BOX_CODES.boxFailed,
        message: "The connector timed out.",
      },
    });
    expect(box.calls).toHaveLength(2);
  });

  it("isolates the one event that crashes the box, and every other event is written", async () => {
    const events = [];
    for (let i = 0; i < 8; i++) events.push(await boxEvent());
    const poison = events[5].eventId;
    const box = fakeRunner(batch =>
      batch.some(e => e.eventId === poison)
        ? ok([
            {
              type: "TRACE",
              trace: { type: "ERROR", error: { message: "handler threw" } },
            },
          ])
        : ok(batch.map(e => leadOutcome(e))),
    );
    const results = await drain(box);
    // No run makes more than one box run.
    expect(box.calls.length).toBeLessThanOrEqual(results.length);
    expect(results.at(-1)?.next).toBe("empty");
    const stored = new Map(
      (await WebhookEvent.find({ flowId }).lean()).map(e => [e.eventId, e]),
    );
    for (const e of events) {
      const row = stored.get(e.eventId)!;
      if (e.eventId === poison) {
        expect(row).toMatchObject({
          status: "failed",
          applyError: { code: BOX_CODES.boxFailed, message: "handler threw" },
        });
      } else {
        expect(row.status).toBe("completed");
        // Never blamed: no attempt was spent on a batch the poison broke.
        expect(row.attempts).toBe(1);
      }
    }
  });

  it("a connector that throws or exits non-zero fails the event, with its message", async () => {
    await boxEvent();
    const box = fakeRunner(() =>
      ok([
        {
          type: "TRACE",
          trace: { type: "ERROR", error: { message: "401: key revoked" } },
        },
      ]),
    );
    const result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });
    expect(result).toMatchObject({ next: "stop", reason: "401: key revoked" });
  });

  it("an answer over the protocol cap shrinks the next batch, one box run at a time, down to the event that causes it", async () => {
    for (let i = 0; i < 4; i++) await boxEvent();
    const huge = (
      await WebhookEvent.find({ flowId }).sort({ receivedAt: 1 })
    )[2].eventId;
    const box = fakeRunner(events => {
      if (events.some(e => e.eventId === huge)) {
        throw new ConnectorOutputTooLargeError("too big", "bytes");
      }
      return ok(events.map(e => leadOutcome(e)));
    });
    const first = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });
    expect(first).toMatchObject({ next: "stop", claimed: 4, failed: 0 });
    expect(box.calls).toHaveLength(1);
    await drain(box);
    expect(box.calls.map(c => c.batch.events.length)).toEqual([4, 2, 2, 1, 1]);
    expect(await WebhookEvent.findOne({ eventId: huge }).lean()).toMatchObject({
      status: "failed",
      attempts: 5,
      applyError: { code: BOX_CODES.outputTooLarge },
    });
    expect(
      await WebhookEvent.countDocuments({ flowId, status: "completed" }),
    ).toBe(3);
  });

  it("fails only the event whose payload echoes the signing secret, and sends the rest", async () => {
    const leak = await boxEvent(flowId, conn, { note: `key ${SECRET}` });
    const clean = await boxEvent();
    const box = fakeRunner(events => ok(events.map(e => leadOutcome(e))));
    const result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });
    expect(box.calls).toHaveLength(1);
    expect(box.calls[0].batch.events.map((e: any) => e.eventId)).toEqual([
      clean.eventId,
    ]);
    expect(JSON.stringify(box.calls[0].batch)).not.toContain(SECRET);
    expect(result).toMatchObject({ failed: 1, ingested: 1 });
    expect(await WebhookEvent.findById(leak._id).lean()).toMatchObject({
      status: "failed",
      applyError: { code: BOX_CODES.secretInBatch },
    });
  });

  it("never writes an entity the connector did not declare, even one the shaping renames", async () => {
    await Flow.collection.updateOne(
      { _id: flowId },
      { $unset: { entityFilter: "" } },
    );
    const e = await boxEvent();
    const box = fakeRunner(
      batch =>
        ok([
          {
            type: "WEBHOOK",
            webhook: {
              eventId: batch[0].eventId,
              outcome: "records",
              records: [
                {
                  entity: "activities",
                  recordId: "x",
                  operation: "upsert",
                  payload: { _type: "Anything" },
                },
              ],
            },
          },
        ]),
      ["activities"],
    );
    await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });
    expect(mocks.appendNormalizedEvents).not.toHaveBeenCalled();
    expect(await WebhookEvent.findById(e._id).lean()).toMatchObject({
      applyStatus: "dropped",
      applyError: { code: "ENTITY_DISABLED" },
    });
  });

  it("a deferred event is parked as ENRICH_DEFERRED with its attempt refunded, as the inline path does", async () => {
    const [deferred, written] = [await boxEvent(), await boxEvent()];
    const box = fakeRunner(events =>
      ok([
        {
          type: "WEBHOOK",
          webhook: {
            eventId: events[0].eventId,
            outcome: "deferred",
            reason: "budget spent",
          },
        },
        leadOutcome(events[1]),
      ]),
    );
    const result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });
    expect(result).toMatchObject({ deferred: 1, ingested: 1, failed: 0 });
    expect(await WebhookEvent.findById(deferred._id).lean()).toMatchObject({
      status: "failed",
      attempts: 0,
      applyError: { code: "ENRICH_DEFERRED", message: "budget spent" },
    });
    expect(await WebhookEvent.findById(written._id).lean()).toMatchObject({
      status: "completed",
    });
  });

  it("with the flag off, touches nothing", async () => {
    process.env.CONNECTOR_WEBHOOK_BATCHES = "false";
    const e = await boxEvent();
    const box = fakeRunner(events => ok(events.map(x => leadOutcome(x))));
    const result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });
    expect(result.next).toBe("stop");
    expect(box.calls).toHaveLength(0);
    expect(await WebhookEvent.findById(e._id).lean()).toMatchObject({
      status: "pending",
    });
  });

  it("hands a flow pointed at a new in-process connection back to the inline cron", async () => {
    const e = await boxEvent();
    const inProcess = new Types.ObjectId();
    await SourceConnection.collection.insertOne({
      _id: inProcess,
      workspaceId: ws,
      name: "PL Close",
      type: "close",
      config: {},
    });
    await Flow.collection.updateOne(
      { _id: flowId },
      { $set: { dataSourceId: inProcess } },
    );
    const box = fakeRunner(() => ok([]));
    const result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: box.factory,
    });
    expect(result.next).toBe("stop");
    expect(box.calls).toHaveLength(0);
    const after = await WebhookEvent.findById(e._id).lean();
    expect(after?.lane).toBeUndefined();
    expect(after?.status).toBe("pending");
  });

  it("hands a flow that moved to an in-process connector back to the inline cron", async () => {
    await SourceConnection.collection.updateOne(
      { _id: conn },
      { $set: { type: "close" } },
    );
    const e = await boxEvent();
    const result = await processBoxWebhookBatch({
      flowId: String(flowId),
      runner: fakeRunner(() => ok([])).factory,
    });
    expect(result.next).toBe("stop");
    const after = await WebhookEvent.findById(e._id).lean();
    expect(after?.lane).toBeUndefined();
    expect(after?.status).toBe("pending");
  });
});

describe("dispatch", () => {
  it("lists each flow with pending box-lane events once, with its connection", async () => {
    await boxEvent();
    await boxEvent();
    await boxEvent(otherFlowId, otherConn);
    await boxEvent(otherFlowId, otherConn, {}, { status: "completed" });
    const flows = await flowsWithPendingBoxWebhooks();
    expect(
      flows
        .map(f => [f.flowId, f.connectionId, f.workspaceId])
        .sort((a, b) => a[0].localeCompare(b[0])),
    ).toEqual(
      [
        [String(flowId), String(conn), String(ws)],
        [String(otherFlowId), String(otherConn), String(ws)],
      ].sort((a, b) => a[0].localeCompare(b[0])),
    );
  });

  it("cutBatch never returns an empty batch with nothing to fail", () => {
    const event = (n: number) => ({
      _id: new Types.ObjectId(),
      eventId: `e${n}`,
      eventType: "t",
      rawPayload: { n },
      receivedAt: new Date(0),
    });
    const { batch, tooLarge } = cutBatch([event(1), event(2)], {
      maxEvents: 500,
      maxBytes: 10,
    });
    expect(batch).toEqual([]);
    expect(tooLarge?.eventId).toBe("e1");
  });
});
