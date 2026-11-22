/**
 * The Stripe folder's webhooks against the built-in Stripe webhook path.
 *
 * The folder runs as Mako runs it: a `webhook` command through
 * `SandboxedConnector.runWebhookBatch`, with only the box swapped for a
 * local process running the same SDK runner on the same files. Its answer
 * crosses `checkOutcome` and `shapeWebhookCdcRecords`, the API's own checks.
 * The built-in side is `buildWebhookCdcRecords` on `StripeConnector`, the
 * inline path production runs today. Stripe is a small local server that
 * serves single objects, so every request the folder makes is seen.
 *
 * Proven here:
 * - The same 94 events, mapped to the same entity and operation. A voided
 *   invoice lands as `void`, a detached payment method with no customer.
 * - The `stripe-v1` declaration accepts and refuses what
 *   `stripe.webhooks.constructEvent` does, on the same deliveries.
 * - Every event type gives the same applied rows on both paths: entity, id,
 *   operation, payload, source time and change id, with no request. An
 *   invoice event adds its lines, a subscription event its items.
 * - A list cut short at 10 is read whole, with the same requests on both
 *   paths. A failed read holds back the whole event. Children the flow does
 *   not sync cost nothing.
 * - A partial or thin payload is filled by one GET and never written with
 *   NULLs. A 404 skips, a failure retries, a spent budget defers.
 * - Provisioning creates the endpoint with the connection's key and returns
 *   the signing secret to the API only.
 *
 * Run: node --import tsx src/connectors/stripe/folder-webhook-batches.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import Stripe from "stripe";
import { SandboxedConnector } from "../workspace/SandboxedConnector";
import type { LoadedConnector } from "../workspace/resolver";
import type { ConnectorCommand, RunResult } from "../workspace/sync-box";
import { checkOutcome } from "../workspace/webhook-batch";
import {
  declaredWebhookVerification,
  verifyDeclaredWebhook,
} from "../workspace/webhook-verification";
import {
  hasWebhookProvisioner,
  stripeWebhookProvisioner,
  webhookProvisionerFor,
} from "../workspace/webhook-provisioners";
import {
  buildWebhookCdcRecords,
  shapeWebhookCdcRecords,
} from "../../inngest/functions/webhook-flow";
import { buildMergeStatement } from "../../sync-cdc/adapters/bigquery-sql";
import {
  FOLDER,
  RUNNER,
  ensureFolderInstalled,
  runFolderCommand,
} from "../../../../connectors/stripe/fixtures/harness.mjs";
import {
  LIST_PATH,
  SENT_AT,
  TEST_SIGNING_SECRET,
  buildWebhookEvents,
  entityOfEvent,
  rowsByEntity,
} from "../../../../connectors/stripe/fixtures/webhook-events.mjs";
import { STRIPE_API_VERSION, StripeConnector } from "./connector";
import {
  stripeSupportedWebhookEvents,
  stripeWebhookEventMapping,
  verifyStripeWebhook,
} from "./webhooks";

process.env.CONNECTOR_WEBHOOK_BATCHES = "true";

const API_KEY = "sk_test_webhooks";
const SOURCE = {
  id: "665f000000000000000000d1",
  name: "PL Stripe shadow",
  type: "stripe",
};
let spec: Record<string, any>;

/** A Stripe that serves objects by path. Every request is recorded. */
const objects = new Map<string, Record<string, unknown>>();
const failing = new Set<string>();
const limited = new Set<string>();
const refusing = new Set<string>();
const requests: string[] = [];
const endpoints: Array<Record<string, any>> = [];
let server: http.Server;
let baseUrl = "";

function serve(
  req: http.IncomingMessage,
  body: string,
  res: http.ServerResponse,
) {
  const url = new URL(req.url ?? "/", "http://stripe.local");
  const route = url.pathname;
  requests.push(`${req.method} ${route}`);
  res.setHeader("content-type", "application/json");
  const send = (status: number, value: unknown) => {
    res.statusCode = status;
    res.end(JSON.stringify(value));
  };
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    return send(401, { error: { type: "invalid_request_error" } });
  }
  if (route === "/v1/webhook_endpoints" && req.method === "POST") {
    const form = new URLSearchParams(body);
    const endpoint = {
      id: `we_fx${endpoints.length + 1}`,
      object: "webhook_endpoint",
      url: form.get("url"),
      api_version: form.get("api_version"),
      enabled_events: eventsOf(form),
      status: "enabled",
    };
    endpoints.push(endpoint);
    return send(200, { ...endpoint, secret: TEST_SIGNING_SECRET });
  }
  if (route === "/v1/webhook_endpoints" && req.method === "GET") {
    return send(200, {
      object: "list",
      data: endpoints,
      has_more: false,
      url: "/v1/webhook_endpoints",
    });
  }
  const endpoint = endpoints.find(
    e => route === `/v1/webhook_endpoints/${e.id}`,
  );
  if (endpoint && req.method === "POST") {
    const form = new URLSearchParams(body);
    endpoint.enabled_events = eventsOf(form);
    return send(200, endpoint);
  }
  if (failing.has(route)) {
    return send(500, { error: { type: "api_error", message: "Boom" } });
  }
  if (limited.has(route)) {
    return send(429, {
      error: { type: "rate_limit_error", message: "Slow down" },
    });
  }
  if (refusing.has(route)) {
    return send(400, {
      error: { type: "invalid_request_error", message: "No" },
    });
  }
  const object = objects.get(route);
  if (!object) {
    return send(404, {
      error: { type: "invalid_request_error", code: "resource_missing" },
    });
  }
  return send(200, object);
}

/** `enabled_events[0]=...&enabled_events[1]=...`, as stripe-node sends it. */
const eventsOf = (form: URLSearchParams) =>
  [...form.entries()]
    .filter(([key]) => /^enabled_events\[\d*\]$/.test(key))
    .map(([, value]) => value);

/** Run the folder's `webhook` command, with every input as a file. */
function runFolder(
  command: string,
  inputs: Record<string, unknown>,
): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-stripe-webhook-"));
  const args = [
    RUNNER,
    command,
    "--connector",
    path.join(FOLDER, "connector.ts"),
  ];
  for (const [name, value] of Object.entries(inputs)) {
    if (value === undefined) continue;
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    args.push(`--${name}`, file);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: FOLDER,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({
        exitCode: code ?? 1,
        messages: stdout
          .split("\n")
          .filter(Boolean)
          .map(line => JSON.parse(line)),
        malformed: [],
        stderr,
        timedOut: false,
      });
    });
  });
}

const handed: Array<{ command: ConnectorCommand; options: any }> = [];

class BoxlessStripe extends SandboxedConnector {
  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "stripe",
      runtime: "node",
      entry: "connector.ts",
      sha: "webhooks",
      sourceSha: "webhooks",
      spec,
      entities: Object.keys(spec?.mako?.entities ?? {}),
      status: "indexed",
    } as LoadedConnector;
    return this.loaded;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    handed.push({ command, options });
    return runFolder(command, { config: options.config, batch: options.batch });
  }
}

const boxed = () =>
  new BoxlessStripe({
    _id: SOURCE.id,
    workspaceId: "ws_webhooks",
    name: SOURCE.name,
    type: "ws:stripe",
    config: { api_key: API_KEY, api_base_url: baseUrl },
  } as never);

const builtIn = () =>
  new StripeConnector({
    _id: SOURCE.id,
    name: SOURCE.name,
    type: "stripe",
    config: { api_key: API_KEY, api_base_url: baseUrl },
  } as never);

before(async () => {
  ensureFolderInstalled();
  const result = await runFolderCommand("spec");
  spec = result.messages.find((m: any) => m.type === "SPEC")!.spec;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => serve(req, body, res));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise(resolve => server?.close(resolve));
});

const outcomesOf = (result: RunResult): any[] =>
  result.messages.filter(m => m.type === "WEBHOOK").map(m => m.webhook);

/** The folder's applied rows, through the API's own checks and shaping. */
async function folderRows(events: ReturnType<typeof buildWebhookEvents>) {
  const result = await boxed().runWebhookBatch(
    { events },
    { timeoutMs: 60_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const declared = new Set(Object.keys(spec.mako.entities));
  const outcomes = outcomesOf(result);
  return {
    outcomes,
    rows: outcomes.map((outcome, i) => {
      const checked = checkOutcome(outcome, declared, 1_000);
      if (checked?.kind !== "records") return null;
      return shapeWebhookCdcRecords({
        rawRecords: checked.records,
        sourceConnection: { ...SOURCE, type: "ws:stripe" },
        destinationType: "bigquery",
        flow: {} as never,
        webhookEvent: events[i],
      });
    }),
  };
}

/** A row as stored, less the write time. */
const comparable = (record: Record<string, any>) => {
  const { _syncedAt: _drop, ...payload } = record.payload;
  return {
    entity: record.entity,
    recordId: record.recordId,
    operation: record.operation,
    payload,
    sourceTs: (record.sourceTs as Date).toISOString(),
    sourceTsKind: record.sourceTsKind,
    changeId: record.changeId,
  };
};

void test("the folder handles the same 94 events, mapped as the built-in maps them", async () => {
  const folder = await import(
    pathToFileURL(path.join(FOLDER, "webhooks.ts")).href
  );
  const events = stripeSupportedWebhookEvents();
  assert.equal(events.length, 94);
  assert.deepEqual(folder.stripeSupportedWebhookEvents(), events);
  assert.deepEqual(spec.mako.webhooks.events, events);
  for (const event of [
    ...events,
    "balance.available",
    "customer.source.created",
  ]) {
    assert.deepEqual(
      folder.stripeWebhookEventMapping(event),
      stripeWebhookEventMapping(event),
      event,
    );
  }
  assert.equal(
    new Set(events.map(e => stripeWebhookEventMapping(e)!.entity)).size,
    20,
  );
  assert.deepEqual(spec.mako.webhooks.verification, {
    scheme: "stripe-v1",
    signatureHeader: "stripe-signature",
    secretEncoding: "utf8",
    toleranceSeconds: 300,
  });
});

/** Deliveries of one body, signed in every way that matters. */
function deliveries(payload: string, now: number) {
  const sign = (
    timestamp: number,
    secret = TEST_SIGNING_SECRET,
    body = payload,
  ) =>
    Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret,
      timestamp,
    });
  const valid = sign(now);
  const v1Of = (header: string) =>
    header.split(",").find(p => p.startsWith("v1="))!;
  const other = sign(now, "whsec_other_0123456789abcdefABCDEF");
  return [
    ["valid", valid, true],
    // 290, not 299: `now` is taken before the deliveries are verified, and
    // a slow CI runner spent over 1 s in between, which made 299 s cross
    // the 300 s window (master and #1349, 17 Nov 2026).
    ["valid, 290 s old", sign(now - 290), true],
    [
      "two secrets while rolling, the second valid",
      `t=${now},${v1Of(other)},${v1Of(valid)}`,
      true,
    ],
    [
      "v0 and v1, as Stripe test mode sends",
      `${valid},v0=${"0".repeat(64)}`,
      true,
    ],
    ["301 s old", sign(now - 301), false],
    ["other secret", other, false],
    [
      "other body",
      sign(now, TEST_SIGNING_SECRET, payload.replace("evt_", "evt_x")),
      false,
    ],
    ["timestamp swapped", valid.replace(`t=${now}`, `t=${now - 1}`), false],
    ["no v1", `t=${now}`, false],
    ["v0 only", `t=${now},v0=${v1Of(valid).slice(3)}`, false],
    ["no timestamp", v1Of(valid), false],
    ["empty", "", false],
    ["garbage", "not a signature", false],
  ] as const;
}

void test("stripe-v1 accepts and refuses exactly what constructEvent does", () => {
  const declaration = declaredWebhookVerification(spec);
  assert.ok(declaration);
  const now = Math.floor(Date.now() / 1000);
  const [event] = buildWebhookEvents(["invoice.paid"]);
  const payload = JSON.stringify(event.rawPayload);
  const stripe = () => new Stripe(API_KEY, { apiVersion: STRIPE_API_VERSION });
  let valid = 0;
  for (const [name, header, expected] of deliveries(payload, now)) {
    const delivery = {
      payload,
      headers: header ? { "stripe-signature": header } : {},
      secret: TEST_SIGNING_SECRET,
    };
    const ours = verifyDeclaredWebhook(declaration, delivery);
    const theirs = verifyStripeWebhook(stripe, delivery);
    assert.equal(theirs.valid, expected, `built-in: ${name}`);
    assert.equal(ours.valid, expected, `declared: ${name}`);
    if (ours.valid) {
      valid++;
      assert.deepEqual(ours.event, JSON.parse(JSON.stringify(theirs.event)));
    }
  }
  assert.equal(valid, 4);
  // No secret, or one that is too short to be a key: refused on both.
  for (const secret of [undefined, "whsec_short"]) {
    const delivery = {
      payload,
      headers: { "stripe-signature": deliveries(payload, now)[0][1] },
      secret,
    };
    assert.equal(verifyDeclaredWebhook(declaration, delivery).valid, false);
  }
});

void test("stripe-v1 also refuses a timestamp more than 300 s ahead, which constructEvent lets through", () => {
  const declaration = declaredWebhookVerification(spec)!;
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ id: "evt_future", type: "invoice.paid" });
  const header = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: TEST_SIGNING_SECRET,
    timestamp: now + 301,
  });
  const delivery = {
    payload,
    headers: { "stripe-signature": header },
    secret: TEST_SIGNING_SECRET,
  };
  assert.equal(verifyDeclaredWebhook(declaration, delivery).valid, false);
  assert.equal(
    verifyStripeWebhook(
      () => new Stripe(API_KEY, { apiVersion: STRIPE_API_VERSION }),
      delivery,
    ).valid,
    true,
  );
});

void test("a stripe-v1 declaration the API cannot run is refused", () => {
  const base = spec.mako.webhooks.verification;
  const wrap = (verification: unknown) => ({
    mako: { webhooks: { verification } },
  });
  for (const [name, bad] of [
    ["hex secret", { ...base, secretEncoding: "hex" }],
    ["no window", { ...base, toleranceSeconds: undefined }],
    ["window too wide", { ...base, toleranceSeconds: 86_401 }],
    ["header case", { ...base, signatureHeader: "Stripe-Signature" }],
    ["extra key", { ...base, signedPayload: ["body"] }],
  ] as const) {
    assert.equal(declaredWebhookVerification(wrap(bad)), null, name);
  }
});

/** Rows whose embedded `lines` or `items` are whole: they cost no request. */
function wholeRows() {
  const rows = rowsByEntity();
  const whole = (row: any, key: string) => row?.[key]?.has_more !== true;
  rows.invoices = rows.invoices.filter((r: any) => whole(r, "lines"));
  rows.subscriptions = rows.subscriptions.filter((r: any) => whole(r, "items"));
  return rows;
}

void test("every event type applies the same rows on both paths, with no request", async () => {
  const types = stripeSupportedWebhookEvents();
  const events = buildWebhookEvents(types, wholeRows());
  handed.length = 0;
  requests.length = 0;
  const { outcomes, rows } = await folderRows(events);

  // The box got the connection's credential and the events, nothing else.
  assert.equal(handed[0].command, "webhook");
  assert.deepEqual(Object.keys(handed[0].options.batch), ["events"]);
  assert.equal(handed[0].options.config.api_key, API_KEY);
  assert.equal(JSON.stringify(handed[0].options).includes("whsec_"), false);

  const connector = builtIn();
  let compared = 0;
  let children = 0;
  for (const [i, event] of events.entries()) {
    const theirs = await buildWebhookCdcRecords({
      connector,
      sourceConnection: SOURCE,
      destinationType: "bigquery",
      flow: {} as never,
      webhookEvent: event,
    });
    const entity = entityOfEvent(event.eventType);
    // An invoice brings its lines, a subscription its items.
    const object = event.rawPayload.data.object as any;
    const expected =
      1 +
      (entity === "invoices" ? object.lines.data.length : 0) +
      (entity === "subscriptions" ? object.items.data.length : 0);
    assert.equal(theirs.records.length, expected, event.eventType);
    assert.equal(rows[i]?.length, expected, event.eventType);
    assert.deepEqual(
      rows[i]!.map(comparable),
      theirs.records.map(comparable),
      event.eventType,
    );
    assert.equal(rows[i]![0].entity, entity);
    for (const record of outcomes[i].records) {
      assert.equal(
        record.sourceTsKind,
        entity === "payment_methods" ? "provider_event" : undefined,
        event.eventType,
      );
    }
    assert.equal(
      rows[i]![0].sourceTsKind,
      entity === "payment_methods" ? "provider_event" : undefined,
      event.eventType,
    );
    if (entity === "payment_methods") {
      assert.equal(
        rows[i]![0].sourceTs.toISOString(),
        new Date(event.rawPayload.created * 1000).toISOString(),
        event.eventType,
      );
    }
    children += expected - 1;
    compared++;
  }
  assert.equal(compared, 94);
  assert.ok(children >= 13, `children: ${children}`);
  assert.deepEqual(requests, [], "a whole payload costs no request");
});

void test("a voided invoice lands as void and a detached payment method with no customer, on both paths", async () => {
  const rowsOf = wholeRows();
  const invoice = structuredClone(rowsOf.invoices[0]);
  invoice.status = "void";
  const card = structuredClone(
    rowsOf.payment_methods.find((row: any) => row.type === "card")!,
  );
  assert.equal(typeof card.customer, "string");
  card.customer = null;
  const events = buildWebhookEvents(
    ["invoice.voided", "payment_method.detached"],
    { invoices: [invoice], payment_methods: [card] },
  );
  requests.length = 0;
  const { rows } = await folderRows(events);
  const connector = builtIn();
  for (const [i, event] of events.entries()) {
    const theirs = await buildWebhookCdcRecords({
      connector,
      sourceConnection: SOURCE,
      destinationType: "bigquery",
      flow: {} as never,
      webhookEvent: event,
    });
    assert.deepEqual(
      rows[i]!.map(comparable),
      theirs.records.map(comparable),
      event.eventType,
    );
  }
  const [voided] = rows[0]!;
  assert.equal(voided.entity, "invoices");
  assert.equal(voided.recordId, invoice.id);
  assert.equal(voided.operation, "upsert");
  assert.equal(voided.payload.status, "void");
  assert.equal(
    voided.sourceTs.toISOString(),
    new Date(invoice.created * 1000).toISOString(),
  );
  const [detached] = rows[1]!;
  assert.equal(detached.entity, "payment_methods");
  assert.equal(detached.recordId, card.id);
  assert.equal(detached.operation, "upsert");
  assert.equal(detached.payload.customer, null);
  assert.equal(detached.payload.type, "card");
  assert.ok(detached.payload.card, "the card details stay on the row");
  // A detached method keeps every list column: no fill request.
  assert.deepEqual(requests, []);
});

void test("payment-method changes use event time for the strict live MERGE", async () => {
  const card = wholeRows().payment_methods.find(row => row.type === "card");
  assert.ok(card);
  const storedAt = SENT_AT - 60;
  const attachedAt = SENT_AT - 120;
  assert.ok(card.created < attachedAt);
  const events = buildWebhookEvents(
    ["payment_method.detached", "payment_method.attached"],
    { payment_methods: [{ ...card, customer: null }, card] },
  );
  events[1].rawPayload.created = attachedAt;
  const endpoint = `/v1/payment_methods/${card.id}`;
  objects.set(endpoint, { ...card, customer: null });
  const thin = {
    ...events[0],
    eventId: "evt_thin_detach",
    rawPayload: {
      id: "evt_thin_detach",
      object: "v2.core.event",
      type: events[0].eventType,
      created: new Date(SENT_AT * 1000).toISOString(),
      related_object: { id: card.id },
    },
  };
  requests.length = 0;
  const { outcomes, rows } = await folderRows([...events, thin]);
  assert.deepEqual(requests, [`GET ${endpoint}`]);
  for (const outcome of outcomes) {
    assert.equal(outcome.records[0].sourceTsKind, "provider_event");
  }
  const connector = builtIn();
  const native = await Promise.all(
    events.map(webhookEvent =>
      buildWebhookCdcRecords({
        connector,
        sourceConnection: SOURCE,
        destinationType: "bigquery",
        flow: {} as never,
        webhookEvent,
      }),
    ),
  );
  assert.deepEqual(
    rows.slice(0, 2).map(records => records?.map(comparable)),
    native.map(result => result.records.map(comparable)),
  );
  const [detached, attached, thinDetached] = rows.map(records => records![0]);
  assert.equal(
    detached.sourceTs.toISOString(),
    new Date(SENT_AT * 1000).toISOString(),
  );
  assert.equal(
    attached.sourceTs.toISOString(),
    new Date(attachedAt * 1000).toISOString(),
  );
  assert.equal(
    thinDetached.sourceTs.toISOString(),
    detached.sourceTs.toISOString(),
  );
  assert.equal(thinDetached.sourceTsKind, "provider_event");
  assert.equal(thinDetached.payload.customer, null);

  const columns = ["id", "customer", "_mako_source_ts"];
  const merge = buildMergeStatement({
    fullLive: "live_methods",
    fullStaging: "staged_methods",
    columns,
    keyColumns: ["id"],
    stagingCols: new Set(columns),
    liveTypes: new Map([
      ["id", "STRING"],
      ["customer", "STRING"],
      ["_mako_source_ts", "TIMESTAMP"],
    ]),
  })
    .replaceAll("`", '"')
    .replaceAll("SAFE_CAST(", "TRY_CAST(")
    .replaceAll("TIMESTAMP('", "bq_timestamp('");
  const instance = await DuckDBInstance.create(":memory:");
  const db = await instance.connect();
  try {
    await db.run("CREATE MACRO bq_timestamp(s) AS CAST(s AS TIMESTAMP)");
    await db.run(
      "CREATE TABLE live_methods (id STRING, customer STRING, _mako_source_ts TIMESTAMP)",
    );
    await db.run("CREATE TABLE staged_methods AS SELECT * FROM live_methods");
    const read = async () =>
      (
        await db.runAndReadAll(
          "SELECT customer, epoch(_mako_source_ts) AS clock FROM live_methods",
        )
      ).getRowObjects();
    const apply = async (record: typeof detached) => {
      const customer = record.payload.customer;
      assert.ok(typeof customer === "string" || customer === null);
      await db.run("DELETE FROM staged_methods");
      await db.run(
        "INSERT INTO staged_methods VALUES ($1,$2,CAST($3 AS TIMESTAMP))",
        [record.recordId, customer, record.sourceTs.toISOString()],
      );
      await db.run(merge);
    };
    for (const change of [detached, thinDetached, native[0].records[0]]) {
      await db.run("DELETE FROM live_methods");
      await db.run(
        "INSERT INTO live_methods VALUES ($1,$2,CAST($3 AS TIMESTAMP))",
        [card.id, card.customer, new Date(storedAt * 1000).toISOString()],
      );
      await apply(attached);
      assert.deepEqual(await read(), [
        { customer: card.customer, clock: storedAt },
      ]);
      await apply(change);
      assert.deepEqual(await read(), [{ customer: null, clock: SENT_AT }]);
      await apply(attached);
      assert.deepEqual(await read(), [{ customer: null, clock: SENT_AT }]);
    }
  } finally {
    db.closeSync();
    instance.closeSync();
  }
});

void test("payment-method events with no valid created keep the object clock", async () => {
  const card = wholeRows().payment_methods.find(row => row.type === "card");
  assert.ok(card);
  const [snapshot] = buildWebhookEvents(["payment_method.updated"], {
    payment_methods: [card],
  });
  const invalid = [
    undefined,
    "not a date",
    "2026-02-30T00:00:00Z",
    0,
    1.5,
    SENT_AT * 1000,
  ];
  const events = invalid.map((created, index) => {
    const eventId = `${snapshot.eventId}_fallback_${index}`;
    return {
      ...snapshot,
      eventId,
      rawPayload: { ...snapshot.rawPayload, id: eventId, created },
    };
  });
  const endpoint = `/v1/payment_methods/${card.id}`;
  objects.set(endpoint, card);
  const thin = [undefined, "2026-02-30T00:00:00Z"].map((created, index) => {
    const eventId = `evt_thin_fallback_${index}`;
    return {
      ...snapshot,
      eventId,
      rawPayload: {
        id: eventId,
        type: snapshot.eventType,
        object: "v2.core.event",
        created,
        related_object: { id: card.id },
      },
    };
  });
  requests.length = 0;
  const { outcomes, rows } = await folderRows([...events, ...thin]);
  assert.deepEqual(
    requests,
    thin.map(() => `GET ${endpoint}`),
  );
  for (const outcome of outcomes) {
    assert.equal(Object.hasOwn(outcome.records[0], "sourceTsKind"), false);
  }
  for (const records of rows) {
    assert.equal(Object.hasOwn(records![0], "sourceTsKind"), false);
  }
  const objectTime = new Date(card.created * 1000).toISOString();
  assert.deepEqual(
    rows.map(records => records?.[0].sourceTs.toISOString()),
    [...events, ...thin].map(() => objectTime),
  );
  for (const event of events) {
    const [record] = builtIn().extractWebhookCdcRecords(
      event.rawPayload,
      event.eventType,
    );
    assert.equal(record.sourceTs.toISOString(), objectTime);
    assert.equal(Object.hasOwn(record, "sourceTsKind"), false);
  }
});

void test("a partial upsert takes its fetched object, which wins over the event; deletes cost none", async () => {
  const rowsOf = rowsByEntity();
  const sub = structuredClone(rowsOf.subscriptions[0]);
  const customer = structuredClone(rowsOf.customers[0]);
  objects.set(`/v1/subscriptions/${sub.id}`, {
    ...sub,
    // Newer than the event: a late fill must not write the event's status.
    status: "canceled",
    // Stripe leaves this one out too: stored as NULL, as a backfill would.
    pause_collection: undefined,
  });
  objects.set(`/v1/customers/${customer.id}`, customer);

  const events = buildWebhookEvents([
    "customer.subscription.updated",
    "customer.updated",
    "customer.deleted",
  ]);
  events[0].rawPayload.data.object = { ...sub, status: "active" };
  delete events[0].rawPayload.data.object.items;
  delete events[0].rawPayload.data.object.pause_collection;
  events[1].rawPayload.data.object = {
    id: customer.id,
    object: "customer",
    email: "new@example.test",
  };
  events[2].rawPayload.data.object = {
    id: "cus_deleted",
    object: "customer",
    deleted: true,
  };

  requests.length = 0;
  const { outcomes, rows } = await folderRows(events);
  assert.deepEqual(
    outcomes.map(o => o.outcome),
    ["records", "records", "records"],
  );

  const filledSub = rows[0]![0].payload;
  assert.deepEqual(filledSub.items, sub.items);
  assert.equal(filledSub.status, "canceled");
  assert.equal(filledSub.pause_collection, null);
  const filledCustomer = rows[1]![0].payload;
  // The fetched object is as new as the event or newer: it wins.
  assert.equal(filledCustomer.email, customer.email);
  assert.equal(filledCustomer.name, customer.name);
  assert.equal(filledCustomer.created, customer.created);
  // Includable columns stay absent: Stripe never returns them unexpanded.
  assert.equal("subscriptions" in filledCustomer, false);
  assert.equal(
    rows[1]![0].sourceTs.toISOString(),
    new Date(customer.created * 1000).toISOString(),
  );
  assert.equal(rows[2]![0].operation, "delete");

  assert.deepEqual(requests, [
    `GET /v1/subscriptions/${sub.id}`,
    `GET /v1/customers/${customer.id}`,
  ]);
});

void test("an invoice's lines and a subscription's items ride on their events; a long list is read whole", async () => {
  const rowsOf = rowsByEntity();
  const invoice = structuredClone(
    rowsOf.invoices.find((r: any) => r.lines.has_more),
  );
  const sub = structuredClone(
    rowsOf.subscriptions.find((r: any) => r.items.has_more),
  );
  assert.ok(invoice && sub, "the dataset holds one long list of each");
  const allLines = Array.from({ length: 13 }, (_, k) => ({
    ...invoice.lines.data[0],
    id: `il_long_${k}`,
  }));
  const allItems = Array.from({ length: 12 }, (_, k) => ({
    ...sub.items.data[0],
    id: `si_long_${k}`,
  }));
  objects.set(`/v1/invoices/${invoice.id}/lines`, {
    object: "list",
    data: allLines,
    has_more: false,
    url: `/v1/invoices/${invoice.id}/lines`,
  });
  objects.set(`/v1/subscription_items`, {
    object: "list",
    data: allItems,
    has_more: false,
    url: "/v1/subscription_items",
  });

  const events = buildWebhookEvents(
    ["invoice.paid", "customer.subscription.updated", "invoice.deleted"],
    { ...rowsOf, invoices: [invoice], subscriptions: [sub] },
  );
  requests.length = 0;
  const { outcomes, rows } = await folderRows(events);
  assert.deepEqual(
    outcomes.map(o => o.outcome),
    ["records", "records", "records"],
  );
  const folderRequests = [...requests];
  assert.deepEqual(folderRequests, [
    `GET /v1/invoices/${invoice.id}/lines`,
    "GET /v1/subscription_items",
  ]);

  // Lines carry their invoice; items their subscription's period.
  const lines = rows[0]!.filter(r => r.entity === "invoice_line_items");
  assert.deepEqual(
    lines.map(r => r.recordId),
    allLines.map(l => l.id),
  );
  for (const line of lines) {
    assert.equal(line.payload.invoice, invoice.id);
    assert.equal(line.payload.invoice_id, invoice.id);
    assert.equal(line.payload.invoice_created, invoice.created);
    assert.equal(
      line.sourceTs.toISOString(),
      new Date(invoice.created * 1000).toISOString(),
    );
    assert.equal(
      line.changeId,
      `${events[0].eventId}:invoice_line_items:${line.recordId}`,
    );
  }
  const items = rows[1]!.filter(r => r.entity === "subscription_items");
  assert.equal(items.length, 12);
  for (const item of items) {
    assert.equal(item.payload.subscription, sub.id);
    assert.equal(item.payload.current_period_end, sub.current_period_end);
  }
  // A delete takes its lines with it, from the payload alone.
  const deleted = rows[2]!;
  assert.equal(deleted.length, 1 + invoice.lines.data.length);
  assert.ok(deleted.every(r => r.operation === "delete"));

  // The built-in path: the same rows and the same requests.
  requests.length = 0;
  for (const [i, event] of events.entries()) {
    const theirs = await buildWebhookCdcRecords({
      connector: builtIn(),
      sourceConnection: SOURCE,
      flow: {} as never,
      webhookEvent: event,
    });
    assert.deepEqual(
      rows[i]!.map(comparable),
      theirs.records.map(comparable),
      event.eventType,
    );
  }
  assert.deepEqual(requests, folderRequests);
});

void test("children the flow does not sync cost no request and no record", async () => {
  const rowsOf = rowsByEntity();
  const invoice = rowsOf.invoices.find((r: any) => r.lines.has_more);
  assert.ok(invoice, "fixture needs an invoice with more lines");
  const events = buildWebhookEvents(["invoice.paid"], {
    ...rowsOf,
    invoices: [invoice],
  });
  requests.length = 0;
  const result = await boxed().runWebhookBatch(
    { events, enabledEntities: ["invoices"] },
    { timeoutMs: 60_000 },
  );
  const [outcome] = outcomesOf(result);
  assert.equal(outcome.outcome, "records");
  assert.deepEqual(
    outcome.records.map((r: any) => r.entity),
    ["invoices"],
  );
  assert.deepEqual(requests, []);

  const theirs = await buildWebhookCdcRecords({
    connector: builtIn(),
    sourceConnection: SOURCE,
    flow: { entityFilter: ["invoices"] } as never,
    webhookEvent: events[0],
  });
  assert.deepEqual(
    theirs.records.map(r => r.entity),
    ["invoices"],
  );
  assert.deepEqual(requests, []);
});

void test("a long list that cannot be read defers the whole event, never half of it", async () => {
  const rowsOf = rowsByEntity();
  const invoice = rowsOf.invoices.find((r: any) => r.lines.has_more);
  assert.ok(invoice, "fixture needs an invoice with more lines");
  failing.add(`/v1/invoices/${invoice.id}/lines`);
  try {
    const events = buildWebhookEvents(["invoice.paid"], {
      ...rowsOf,
      invoices: [invoice],
    });
    const { outcomes } = await folderRows(events);
    assert.equal(outcomes[0].outcome, "deferred");

    const theirs = await buildWebhookCdcRecords({
      connector: builtIn(),
      sourceConnection: SOURCE,
      flow: {} as never,
      webhookEvent: events[0],
    });
    assert.equal(theirs.records.length, 0);
    assert.equal(theirs.retry?.mode, "fail");
  } finally {
    failing.delete(`/v1/invoices/${invoice.id}/lines`);
  }
});

void test("a thin event, which only names its object, takes the whole object", async () => {
  const invoice = structuredClone(rowsByEntity().invoices[0]);
  objects.set(`/v1/invoices/${invoice.id}`, invoice);
  const events = [
    {
      eventId: "evt_thin",
      eventType: "invoice.paid",
      receivedAt: new Date(SENT_AT * 1000).toISOString(),
      rawPayload: {
        id: "evt_thin",
        object: "v2.core.event",
        type: "invoice.paid",
        related_object: {
          id: invoice.id,
          type: "invoice",
          url: `/v1/invoices/${invoice.id}`,
        },
      },
    },
  ];
  requests.length = 0;
  const { outcomes, rows } = await folderRows(events);
  assert.equal(outcomes[0].outcome, "records");
  const {
    _syncedAt: _a,
    _dataSourceId: _b,
    _dataSourceName: _c,
    ...payload
  } = rows[0]![0].payload;
  assert.deepEqual(payload, invoice);
  assert.equal(rows[0]![0].changeId, "evt_thin");
  assert.deepEqual(requests, [`GET /v1/invoices/${invoice.id}`]);
});

void test("404 or a deleted object skips; Stripe's errors defer; a 400 fails for a retry", async () => {
  const charge = structuredClone(rowsByEntity().charges[0]);
  failing.add("/v1/charges/ch_broken");
  limited.add("/v1/charges/ch_limited");
  refusing.add("/v1/charges/ch_refused");
  objects.set("/v1/customers/cus_gone_since", {
    id: "cus_gone_since",
    object: "customer",
    deleted: true,
  });
  const events = buildWebhookEvents([
    "charge.updated",
    "charge.updated",
    "customer.updated",
    "charge.updated",
    "charge.updated",
  ]);
  for (const [i, id] of [
    [3, "ch_limited"],
    [4, "ch_refused"],
  ] as const) {
    events[i].rawPayload.data.object = { id, object: "charge", amount: 1 };
  }
  events[0].rawPayload.data.object = {
    id: "ch_missing",
    object: "charge",
    amount: 1,
  };
  events[1].rawPayload.data.object = {
    ...charge,
    id: "ch_broken",
    outcome: undefined,
  };
  delete events[1].rawPayload.data.object.outcome;
  events[2].rawPayload.data.object = {
    id: "cus_gone_since",
    object: "customer",
  };
  const { outcomes } = await folderRows(events);
  assert.deepEqual(
    outcomes.map(o => o.outcome),
    ["skipped", "deferred", "skipped", "deferred", "extract_failed"],
  );
  assert.match(outcomes[0].reason, /404/);
  assert.match(outcomes[1].reason, /ch_broken.*HTTP 500/);
  assert.match(outcomes[3].reason, /ch_limited.*HTTP 429/);
  assert.match(outcomes[4].reason, /ch_refused.*HTTP 400/);
});

void test("a charge without `refunds`, as Stripe sends it since 2022-11-15, makes no request", async () => {
  const [event] = buildWebhookEvents(["charge.succeeded"]);
  delete event.rawPayload.data.object.refunds;
  requests.length = 0;
  const { outcomes, rows } = await folderRows([event]);
  assert.equal(outcomes[0].outcome, "records");
  assert.equal("refunds" in rows[0]![0].payload, false);
  assert.deepEqual(requests, []);
});

void test("past the fill budget, events are deferred, never answered partial", async () => {
  const folder = await import(
    pathToFileURL(path.join(FOLDER, "webhook-handler.ts")).href
  );
  const product = structuredClone(rowsByEntity().products[0]);
  let clock = 0;
  const gets: string[] = [];
  const stripe = {
    products: {
      async retrieve(id: string) {
        gets.push(id);
        clock += 600;
        return { ...product, id };
      },
    },
  };
  const events = buildWebhookEvents([
    "product.updated",
    "product.updated",
    "product.updated",
    "product.deleted",
  ]);
  for (const [i, event] of events.slice(0, 3).entries()) {
    event.rawPayload.data.object = { id: `prod_p${i}`, object: "product" };
  }
  const outcomes = await folder.handleStripeWebhookBatch(
    { stripe: () => stripe, log: () => {}, budgetMs: 1_000, now: () => clock },
    events,
  );
  assert.deepEqual(
    outcomes.map((o: any) => o.outcome),
    ["records", "records", "deferred", "records"],
  );
  assert.equal(gets.length, 2);
});

void test("an id that cannot go into a path is refused before any request", async () => {
  const events = buildWebhookEvents([
    "coupon.updated",
    "coupon.updated",
    "coupon.updated",
  ]);
  for (const [i, id] of ["..", ".", "a b"].entries()) {
    events[i].rawPayload.data.object = { id, object: "coupon" };
  }
  requests.length = 0;
  const { outcomes } = await folderRows(events);
  assert.deepEqual(
    outcomes.map(o => o.outcome),
    ["extract_failed", "extract_failed", "extract_failed"],
  );
  assert.deepEqual(requests, []);
});

void test("the fill table covers every entity with events, less what Stripe never returns", async () => {
  const folder = await import(
    pathToFileURL(path.join(FOLDER, "webhook-handler.ts")).href
  );
  const withEvents = new Set(
    stripeSupportedWebhookEvents().map(
      e => stripeWebhookEventMapping(e)!.entity,
    ),
  );
  assert.deepEqual(
    Object.keys(folder.STRIPE_WEBHOOK_FILL_FIELDS).sort(),
    [...withEvents].sort(),
  );
  assert.deepEqual(Object.keys(LIST_PATH).sort(), [...withEvents].sort());
  // A list row of every entity has every fill field: a whole payload is
  // never mistaken for a partial one.
  const rows = rowsByEntity();
  for (const [entity, fields] of Object.entries(
    folder.STRIPE_WEBHOOK_FILL_FIELDS as Record<string, string[]>,
  )) {
    for (const row of rows[entity]) {
      for (const field of fields) assert.ok(field in row, `${entity}.${field}`);
    }
  }
});

void test("provisioning creates the endpoint pinned to 2023-10-16 and returns its secret", async () => {
  const stripe = new Stripe(API_KEY, {
    apiVersion: STRIPE_API_VERSION,
    host: "127.0.0.1",
    port: Number(new URL(baseUrl).port),
    protocol: "http",
  });
  const provisioner = stripeWebhookProvisioner(stripe);
  const url = "https://api.example.test/api/webhooks/ws1/flowS";
  endpoints.length = 0;

  assert.equal(await provisioner.update({ endpointUrl: url }), null);
  const created = await provisioner.create({
    endpointUrl: url,
    enabledEntities: ["invoices", "customers"],
  });
  assert.equal(created.signingSecret, TEST_SIGNING_SECRET);
  assert.equal(endpoints[0].api_version, "2023-10-16");
  assert.deepEqual(endpoints[0].enabled_events, [
    "customer.created",
    "customer.updated",
    "customer.deleted",
    "invoice.created",
    "invoice.finalized",
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.updated",
    "invoice.voided",
    "invoice.marked_uncollectible",
    "invoice.payment_succeeded",
    "invoice.payment_action_required",
    "invoice.finalization_failed",
    "invoice.sent",
    "invoice.deleted",
  ]);

  // A save later retargets the same endpoint; Stripe shows no secret again.
  const updated = await provisioner.update({
    endpointUrl: url,
    enabledEntities: ["charges"],
    providerWebhookId: created.providerWebhookId,
  });
  assert.equal(updated?.providerWebhookId, created.providerWebhookId);
  assert.equal(updated?.signingSecret, undefined);
  assert.equal(endpoints.length, 1);
  assert.deepEqual(endpoints[0].enabled_events, [
    "charge.succeeded",
    "charge.failed",
    "charge.captured",
    "charge.refunded",
    "charge.updated",
    "charge.pending",
    "charge.expired",
  ]);
});

void test("a boxed Stripe folder offers provisioning, with the flag on and its scheme declared", async () => {
  assert.equal(hasWebhookProvisioner("stripe"), true);
  await assert.rejects(() => webhookProvisionerFor("stripe", {}), /API key/);
  const connector = boxed();
  (connector as any).loaded = {
    slug: "stripe",
    spec,
    entities: [],
  };
  assert.equal(connector.supportsWebhooks(), true);
  assert.equal(connector.webhookDelivery(), "box");
  assert.equal(connector.supportsWebhookProvisioning(), true);
  assert.equal(connector.supportsWebhookSubscriptionUpdate(), true);
  assert.deepEqual(
    connector.getSupportedWebhookEvents(),
    stripeSupportedWebhookEvents(),
  );
});
