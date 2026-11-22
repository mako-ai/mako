/**
 * The Calendly folder's webhook handler, run as Mako runs it: a `webhook`
 * command through `SandboxedConnector.runWebhookBatch`, with only the box
 * swapped for a local process running the same SDK runner on the same
 * files. Calendly is a small local server that serves single objects, so
 * every request the handler makes is seen. No real data, no network.
 *
 * The rule: the writer replaces a whole row, so a column a payload lacks
 * is written NULL. Calendly's embedded `scheduled_event` lacks
 * `calendar_event`, and its event_type payloads lack `slug`, `profile` and
 * `internal_note` (RealAdvisor's warehouse: 29,901 of 29,984 and 11 of 11
 * webhook-written rows NULL). So a scheduled_events or event_types upsert
 * that lacks any REST column is filled from `GET /<object>/<uuid>`. Only
 * absent or null keys are filled and the webhook's non-null values win. A
 * 404 drops the record. A failed read fails the event for a retry. A spent
 * budget defers it. A partial record is never answered unfilled.
 *
 * The in-process connector this folder replaced did not fill: it wrote
 * those NULLs. The test holds the folder to the golden mapping
 * (`golden/webhooks.json`, the extraction before any fill) plus the REST
 * object's values for exactly the keys the payload lacks.
 *
 * Run: node --import tsx src/connectors/calendly-folder-webhook-batches.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SandboxedConnector } from "./workspace/SandboxedConnector";
import type { LoadedConnector } from "./workspace/resolver";
import type { ConnectorCommand, RunResult } from "./workspace/sync-box";
import {
  FOLDER,
  ensureFolderInstalled,
  runFolderCommand,
} from "../../../connectors/calendly/fixtures/harness.mjs";
import {
  BASE,
  buildDataset,
} from "../../../connectors/calendly/fixtures/dataset.mjs";
import {
  buildWebhookEvents,
  storedEvent,
  webhookEventType,
} from "../../../connectors/calendly/fixtures/webhook-events.mjs";
import { MAKO_SYSTEM_FIELDS } from "./base/BaseConnector";
import { jsonSchemaToEntitySchema } from "./workspace/spec-translation";

process.env.CONNECTOR_WEBHOOK_BATCHES = "true";

const TOKEN = "cal_test_webhooks";
let spec: Record<string, any>;

/** A Calendly that serves objects by path. Every request is recorded. */
const objects = new Map<string, Record<string, unknown>>();
const failing = new Set<string>();
/** Paths answered 403, as for a token of another organization. */
const forbidden = new Set<string>();
/** Paths answered 401, as for a revoked token. */
const unauthorized = new Set<string>();
/** Paths answered 429 with `Retry-After: 60`. */
const limited = new Set<string>();
const requests: string[] = [];
let server: http.Server;
let baseUrl = "";

/** Fixture URIs (`BASE`) on this server. */
const local = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value).split(BASE).join(baseUrl));

/** What the box would be handed, kept for the assertions. */
const handed: Array<{ command: ConnectorCommand; options: any }> = [];

class BoxlessCalendly extends SandboxedConnector {
  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "calendly",
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
    const result = await runFolderCommand(command, {
      config: options.config,
      batch: options.batch,
    });
    return {
      exitCode: result.code ?? 1,
      messages: result.messages as RunResult["messages"],
      malformed: [],
      stderr: result.stderr,
      timedOut: false,
    };
  }
}

const connector = () =>
  new BoxlessCalendly({
    _id: "665f000000000000000000d1",
    workspaceId: "ws_webhooks",
    name: "Calendly shadow",
    type: "ws:calendly",
    config: { access_token: TOKEN, api_base_url: baseUrl },
  } as never);

before(async () => {
  ensureFolderInstalled();
  const result = await runFolderCommand("spec");
  spec = result.messages.find(m => m.type === "SPEC")?.spec ?? {};
  const discover = await runFolderCommand("discover", {
    config: { access_token: "cal_test_schema" },
  });
  for (const stream of discover.messages.find(m => m.type === "CATALOG")
    ?.catalog?.streams ?? []) {
    schemas[stream.name] = jsonSchemaToEntitySchema(stream.name, stream);
  }
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://calendly.local");
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ title: "Unauthenticated" }));
      return;
    }
    if (limited.has(url.pathname)) {
      res.statusCode = 429;
      res.setHeader("retry-after", "60");
      res.end(JSON.stringify({ title: "Too Many Requests" }));
      return;
    }
    if (unauthorized.has(url.pathname)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ title: "Unauthenticated", message: "No" }));
      return;
    }
    if (forbidden.has(url.pathname)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ title: "Permission Denied", message: "No" }));
      return;
    }
    if (failing.has(url.pathname)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ title: "Invalid Argument", message: "Bad" }));
      return;
    }
    const object = objects.get(url.pathname);
    if (!object) {
      res.statusCode = 404;
      res.end(JSON.stringify({ title: "Resource Not Found" }));
      return;
    }
    res.end(JSON.stringify({ resource: object }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // Calendly's objects, as its REST API serves them.
  const dataset = local(buildDataset());
  for (const route of ["/scheduled_events", "/event_types"]) {
    for (const row of dataset.lists[route]) {
      objects.set(new URL(row.uri).pathname, row);
    }
  }
});

after(async () => {
  await new Promise(resolve => server?.close(resolve));
});

const outcomesOf = (result: RunResult): any[] =>
  result.messages.filter(m => m.type === "WEBHOOK").map(m => m.webhook);

/** The folder's schemas, by entity. */
const schemas: Record<string, { fields: Record<string, unknown> }> = {};

/** REST columns of an entity, as the folder's schema lists them. */
const restColumns = (entity: string) =>
  Object.keys(schemas[entity].fields).filter(
    f => f !== "id" && !(f in MAKO_SYSTEM_FIELDS),
  );
const FILLED = (entity: string): string[] | undefined =>
  entity === "scheduled_events" || entity === "event_types"
    ? restColumns(entity)
    : undefined;

/** The golden mapping of the fixture events, before any fill. */
const goldenOutcomes = async (): Promise<any[]> => {
  const { GOLDEN_DIR } =
    await import("../../../connectors/calendly/fixtures/golden.mjs");
  return local(
    JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, "webhooks.json"), "utf8")),
  ).outcomes;
};

const runBatch = async (events: unknown[]) => {
  const result = await connector().runWebhookBatch({ events } as never, {
    timeoutMs: 60_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return outcomesOf(result);
};

void test("partial rows are filled from their object; everything else is the golden mapping", async () => {
  const events = local(buildWebhookEvents()).map((e: any) => ({
    ...e,
    receivedAt: "2026-11-16T11:00:00.000Z",
  }));
  // The webhook's own values win over the object's.
  const typePath = new URL(events[3].rawPayload.payload.uri).pathname;
  objects.set(typePath, {
    ...objects.get(typePath),
    name: "From GET, must not win",
  });

  handed.length = 0;
  requests.length = 0;
  const outcomes = await runBatch(events);

  // The box got the connection's credential and the events, nothing else.
  assert.equal(handed[0].command, "webhook");
  assert.deepEqual(Object.keys(handed[0].options.batch), ["events"]);
  assert.equal(handed[0].options.config.access_token, TOKEN);

  assert.deepEqual(
    outcomes.map(o => o.outcome),
    [
      "records",
      "records",
      "records",
      "records",
      "records",
      "records",
      "unmapped",
      "extract_failed",
      "extract_failed",
    ],
  );

  const mapped = await goldenOutcomes();
  let filledColumns = 0;
  let nullsAvoided = 0;
  for (const i of events.keys()) {
    if (outcomes[i].outcome !== "records") continue;
    const extracted = mapped[i].records;
    assert.equal(outcomes[i].records.length, extracted.length);
    for (const [k, record] of extracted.entries()) {
      const got = outcomes[i].records[k];
      assert.equal(got.entity, record.entity);
      assert.equal(got.recordId, record.recordId);
      assert.equal(got.operation, record.operation);
      assert.equal(got.changeId, record.changeId);
      assert.equal(got.sourceTs, record.sourceTs);
      const expected: Record<string, unknown> = { ...record.payload };
      const columns = FILLED(record.entity);
      if (columns) {
        const object =
          objects.get(new URL(String(record.payload?.uri)).pathname) ?? {};
        for (const column of columns) {
          if (expected[column] == null) {
            expected[column] = object[column] ?? null;
            filledColumns++;
            if (object[column] != null) nullsAvoided++;
          }
        }
        // No column the object holds is left null.
        for (const column of columns) {
          if (object[column] != null) {
            assert.notEqual(got.payload[column], null, column);
          }
        }
      }
      assert.deepEqual(got.payload, JSON.parse(JSON.stringify(expected)));
    }
  }
  assert.ok(filledColumns > 0 && nullsAvoided > 0);
  // The event type kept the webhook's own name.
  assert.equal(
    outcomes[3].records[0].payload.name,
    events[3].rawPayload.payload.name,
  );
  assert.ok(outcomes[3].records[0].payload.slug);
  assert.ok(outcomes[3].records[0].payload.profile);

  // Exactly one GET per partial record: 3 scheduled events and 2 event
  // types. Invitees cost none.
  const pathOf = (uri: string) => new URL(uri).pathname;
  assert.deepEqual(requests, [
    `GET ${pathOf(events[0].rawPayload.payload.scheduled_event.uri)}`,
    `GET ${pathOf(events[1].rawPayload.payload.scheduled_event.uri)}`,
    `GET ${pathOf(events[2].rawPayload.payload.scheduled_event.uri)}`,
    `GET ${pathOf(events[3].rawPayload.payload.uri)}`,
    `GET ${pathOf(events[4].rawPayload.payload.uri)}`,
  ]);
});

void test("a 404 drops the record: an event type alone is skipped, an invitee keeps its row", async () => {
  const [created] = local(buildWebhookEvents());
  const goneEvent = structuredClone(created);
  goneEvent.eventId = "ev_gone_event";
  goneEvent.rawPayload.payload.scheduled_event.uri = `${baseUrl}/scheduled_events/EVGONE`;
  const goneType = {
    eventId: "ev_gone_type",
    eventType: "event_type.updated",
    rawPayload: storedEvent({
      event: "event_type.updated",
      created_at: "2026-11-10T10:00:00.000000Z",
      payload: {
        ...local(webhookEventType(buildDataset().lists["/event_types"][0])),
        uri: `${baseUrl}/event_types/ETGONE`,
      },
    }),
  };
  requests.length = 0;
  const outcomes = await runBatch([goneEvent, goneType]);
  assert.equal(outcomes[0].outcome, "records");
  assert.deepEqual(
    outcomes[0].records.map((r: any) => r.entity),
    ["invitees"],
  );
  assert.equal(outcomes[1].outcome, "skipped");
  assert.match(outcomes[1].reason, /404/);
  assert.deepEqual(requests, [
    "GET /scheduled_events/EVGONE",
    "GET /event_types/ETGONE",
  ]);
});

void test("a read that fails holds the whole event back, for a retry, never unfilled", async () => {
  const [created] = local(buildWebhookEvents());
  const eventPath = new URL(created.rawPayload.payload.scheduled_event.uri)
    .pathname;
  failing.add(eventPath);
  try {
    const outcomes = await runBatch([created]);
    assert.equal(outcomes[0].outcome, "extract_failed");
    assert.match(outcomes[0].reason, /HTTP 400/);
  } finally {
    failing.delete(eventPath);
  }
});

void test("a 403 fill read lands the record without the keys it could not read", async () => {
  const [created] = local(buildWebhookEvents());
  const eventPath = new URL(created.rawPayload.payload.scheduled_event.uri)
    .pathname;
  forbidden.add(eventPath);
  try {
    const outcomes = await runBatch([created]);
    assert.equal(outcomes[0].outcome, "records");
    const scheduled = (outcomes[0] as any).records.find(
      (r: any) => r.entity === "scheduled_events",
    );
    assert.ok(scheduled, "the scheduled event still lands");
    assert.equal("calendar_event" in scheduled.payload, false);
    for (const [key, value] of Object.entries(scheduled.payload)) {
      assert.notEqual(value, null, `${key} is never written null`);
    }
    assert.ok(
      (outcomes[0] as any).records.some((r: any) => r.entity === "invitees"),
      "the invitee still lands",
    );
  } finally {
    forbidden.delete(eventPath);
  }
});

void test("a 401 fill read fails the event loudly, never a partial row", async () => {
  const [created] = local(buildWebhookEvents());
  const eventPath = new URL(created.rawPayload.payload.scheduled_event.uri)
    .pathname;
  unauthorized.add(eventPath);
  try {
    const outcomes = await runBatch([created]);
    assert.equal(outcomes[0].outcome, "extract_failed");
    assert.match(outcomes[0].reason, /HTTP 401/);
  } finally {
    unauthorized.delete(eventPath);
  }
});

void test("a rate-limited fill read is deferred after one attempt, never slept into the box timeout", async () => {
  const [created] = local(buildWebhookEvents());
  const eventPath = new URL(created.rawPayload.payload.scheduled_event.uri)
    .pathname;
  limited.add(eventPath);
  requests.length = 0;
  const started = Date.now();
  try {
    const outcomes = await runBatch([created]);
    assert.equal(outcomes[0].outcome, "deferred");
    assert.match(outcomes[0].reason, /429/);
  } finally {
    limited.delete(eventPath);
  }
  // One request, no 60 s Retry-After sleep.
  assert.deepEqual(
    requests.filter(r => r.startsWith(`GET ${eventPath}`)),
    [`GET ${eventPath}`],
  );
  assert.ok(Date.now() - started < 30_000);
});

void test("parallel reads share a wall-clock backoff budget, not a sum of their sleeps", async () => {
  const { createCalendlyClient } = await import(
    pathToFileURL(path.join(FOLDER, "client.ts")).href
  );
  const paths = Array.from({ length: 8 }, (_, i) => `/limited/${i}`);
  for (const p of paths) limited.add(p);
  const slept: number[] = [];
  let release = () => {};
  const arrived = new Promise<void>(resolve => (release = resolve));
  const client = createCalendlyClient({
    token: TOKEN,
    baseUrl,
    log: () => {},
    // Every path gets its 429 before any sleep ends; then Calendly answers
    // (404 here, so each get throws). A request that gives up instead of
    // sleeping never arrives, and the wait ends after 2 s.
    sleep: (ms: number) => {
      slept.push(ms);
      if (slept.length === paths.length) {
        for (const p of paths) limited.delete(p);
        release();
      }
      return Promise.race([
        arrived,
        new Promise<void>(resolve => setTimeout(resolve, 2_000)),
      ]).then(() => {
        for (const p of paths) limited.delete(p);
      });
    },
  });
  try {
    const results = await Promise.allSettled(paths.map(p => client.get(p)));
    // All 8 waited their 60 s side by side and were retried: none gave the
    // chunk back for a budget that only a sum of sleeps (480 s) would pass.
    assert.equal(slept.length, 8);
    assert.ok(slept.every(ms => ms === 60_000));
    for (const r of results) {
      assert.equal(r.status, "rejected");
      assert.match(String((r as PromiseRejectedResult).reason), /404/);
    }
  } finally {
    for (const p of paths) limited.delete(p);
  }
});

void test("past the fill budget, events are deferred, never answered unfilled", async () => {
  const folder = await import(
    pathToFileURL(path.join(FOLDER, "webhooks.ts")).href
  );
  const events = local(buildWebhookEvents());
  let clock = 0;
  const gets: string[] = [];
  const api = {
    baseUrl,
    async get(endpoint: string) {
      gets.push(endpoint);
      clock += 600;
      return { resource: {} };
    },
  };
  const outcomes = await folder.handleCalendlyWebhookBatch(
    { api, log: () => {}, budgetMs: 1_000, now: () => clock },
    events.slice(0, 6),
  );
  assert.deepEqual(
    outcomes.map((o: any) => o.outcome),
    ["records", "records", "deferred", "deferred", "deferred", "records"],
  );
  assert.equal(gets.length, 2);
});

void test("a URI that is not this Calendly's object is refused before any request", async () => {
  const [created] = local(buildWebhookEvents());
  const bad = [
    "https://attacker.example/scheduled_events/EV1",
    `${baseUrl}/scheduled_events/../users/me`,
    `${baseUrl}/scheduled_events/EV1?x=1`,
    `${baseUrl}/event_types/ET1`,
  ].map((uri, i) => {
    const event = structuredClone(created);
    event.eventId = `ev_bad_${i}`;
    event.rawPayload.payload.scheduled_event.uri = uri;
    return event;
  });
  requests.length = 0;
  const outcomes = await runBatch(bad);
  assert.deepEqual(
    outcomes.map(o => o.outcome),
    ["extract_failed", "extract_failed", "extract_failed", "extract_failed"],
  );
  assert.deepEqual(requests, []);
});
