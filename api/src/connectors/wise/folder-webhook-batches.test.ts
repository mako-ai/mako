/**
 * The Wise folder's webhook handler, run as Mako runs it: a `webhook`
 * command through `SandboxedConnector.runWebhookBatch`, with only the box
 * swapped for a local process running the same SDK runner on the same
 * files. Wise is the fixture emulator over the synthetic dataset, so every
 * request the handler makes is seen. No real data, no network.
 *
 * A Wise event carries a state change, not the object. The in-process
 * connector writes it as is, and the CDC writer replaces the whole row, so
 * every column the event lacks goes NULL (RealAdvisor: 5 of 5
 * webhook-written transfers have `targetValue`, `sourceCurrency`, `created`
 * and `user` NULL). The folder fills such a record with one GET of the
 * object, shaped as `read` emits it: every key the event lacks or has null
 * for comes from the object, and the event's non-null values win. This
 * test proves, for every event of the fixture set:
 *
 * - the filled row is the in-process extraction, with every absent or null
 *   key taken from the row a backfill reads for the same id;
 * - no column a backfill has a value for is null;
 * - exactly one GET per partial record, and none for a webhook-only
 *   `balance_updates` line, a test ping or an unmapped type;
 * - a 404 drops the record, a 400 fails the event for a retry, a spent
 *   budget defers it, an id that is not a Wise id is refused unsent.
 *
 * Run: TZ=UTC node --import tsx src/connectors/wise/folder-webhook-batches.test.ts
 */
process.env.TZ = "UTC";

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SandboxedConnector } from "../workspace/SandboxedConnector";
import type { LoadedConnector } from "../workspace/resolver";
import type { ConnectorCommand, RunResult } from "../workspace/sync-box";
import {
  FOLDER,
  canonicalJson,
  ensureFolderInstalled,
  freezeClock,
  inProcessFactory,
  inProcessWebhookOutcomes,
  readInProcess,
  runFolderCommand,
  startRecordingServer,
  testConfig,
  type FixtureServer,
} from "../../../../connectors/wise/fixtures/harness.mjs";
import { buildDataset } from "../../../../connectors/wise/fixtures/dataset.mjs";
import {
  buildWebhookEvents,
  storedEvent,
} from "../../../../connectors/wise/fixtures/webhook-events.mjs";
import { WiseConnector } from "./connector";

process.env.CONNECTOR_WEBHOOK_BATCHES = "true";

const TOKEN = "wise_test_webhooks";
const makeInProcess = inProcessFactory({ WiseConnector });
let spec: Record<string, any>;
let server: FixtureServer & { recorded: Map<string, unknown> };
let restoreClock: () => void;
/** Backfill rows by entity and id, as the in-process `read` emits them. */
const backfill = new Map<string, Map<string, Record<string, unknown>>>();

class BoxlessWise extends SandboxedConnector {
  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "wise",
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
    const result = await runFolderCommand(command, {
      config: options.config,
      batch: (options as { batch?: unknown }).batch,
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

const connector = (token = TOKEN) =>
  new BoxlessWise({
    _id: "665f000000000000000000d1",
    workspaceId: "ws_webhooks",
    name: "Wise shadow",
    type: "ws:wise",
    config: testConfig(token, server),
  } as never);

const outcomesOf = (result: RunResult): any[] =>
  result.messages
    .filter(m => m.type === "WEBHOOK")
    .map(m => (m as unknown as { webhook: unknown }).webhook);

before(async () => {
  restoreClock = freezeClock();
  ensureFolderInstalled();
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  server = await startRecordingServer(buildDataset());
  for (const entity of ["transfers", "balances", "profiles", "recipients"]) {
    const run = await readInProcess(
      () => makeInProcess(testConfig(`wise_test_backfill_${entity}`, server)),
      { entity, maxIterations: 100 },
    );
    backfill.set(entity, new Map(run.rows.map(row => [String(row.id), row])));
  }
});

after(async () => {
  await server?.close();
  restoreClock?.();
});

void test("the folder declares Wise's RSA scheme, its test ping and the delivery id", () => {
  const webhooks = spec.mako.webhooks;
  assert.equal(webhooks.verification.scheme, "rsa-sha256");
  assert.equal(webhooks.verification.publicKeys.length, 2);
  assert.match(webhooks.verification.publicKeys[0], /BEGIN PUBLIC KEY/);
  assert.equal(webhooks.verification.signatureHeader, "x-signature-sha256");
  assert.equal(webhooks.verification.signatureEncoding, "base64");
  assert.deepEqual(webhooks.verification.testNotification, {
    header: "x-test-notification",
    value: "true",
    eventType: "wise#test-notification",
  });
  assert.equal(webhooks.eventIdHeader, "x-delivery-id");
  assert.equal(webhooks.eventTypePath, "event_type");
  assert.equal(webhooks.events.length, 8);
});

void test("partial records are filled to the backfill row; whole ones pass as in-process", async () => {
  const events = buildWebhookEvents();
  const before = server.requests(TOKEN).length;
  const result = await connector().runWebhookBatch(
    { events },
    { timeoutMs: 60_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const outcomes = outcomesOf(result);
  const inProcess = inProcessWebhookOutcomes(
    makeInProcess(testConfig("wise_test_list", server)),
    events,
  );
  assert.equal(outcomes.length, events.length);

  let filled = 0;
  let passed = 0;
  for (const [i, outcome] of outcomes.entries()) {
    const expected = inProcess[i];
    if (expected.outcome !== "records") {
      assert.deepEqual(outcome, expected, events[i].eventType);
      passed++;
      continue;
    }
    const record = expected.records[0];
    const row = backfill.get(record.entity)?.get(record.recordId);
    if (record.entity !== "balance_updates" && !row) {
      // The transfer the dataset does not have: Wise answers 404.
      assert.equal(outcome.outcome, "skipped", events[i].eventId);
      assert.match(outcome.reason, /404/);
      continue;
    }
    assert.equal(outcome.outcome, "records", events[i].eventId);
    const got = outcome.records[0];
    // Everything but the payload is the in-process record's.
    const { payload: gotPayload, ...gotRest } = got;
    const { payload: inPayload, ...inRest } = record;
    assert.deepEqual(gotRest, inRest, events[i].eventId);
    if (!row) {
      // balance_updates: webhook-only, never filled.
      assert.deepEqual(gotPayload, inPayload, events[i].eventId);
      passed++;
      continue;
    }
    const want: Record<string, unknown> = {};
    for (const key of new Set([
      ...Object.keys(inPayload),
      ...Object.keys(row),
    ])) {
      want[key] = inPayload[key] ?? row[key] ?? null;
    }
    // Columns neither has stay null, never absent.
    for (const [key, value] of Object.entries(gotPayload)) {
      if (!(key in want)) {
        assert.equal(value, null, `${events[i].eventId} ${key}`);
        want[key] = null;
      }
    }
    assert.equal(
      canonicalJson(gotPayload),
      canonicalJson(want),
      events[i].eventId,
    );
    for (const [key, value] of Object.entries(row)) {
      if (value != null) {
        assert.notEqual(gotPayload[key], null, `${events[i].eventId} ${key}`);
      }
    }
    // The webhook's own non-null values win over the object's.
    for (const [key, value] of Object.entries(inPayload)) {
      if (value != null) assert.deepEqual(gotPayload[key], value, key);
    }
    filled++;
  }
  // 10 records filled (6 transfers, 1 balance, 1 profile, 2 recipients), 1
  // transfer gone (404), 2 balance_updates passed through, 4 events with no
  // record (test ping, unmapped type, 2 empty payloads).
  assert.deepEqual([filled, passed], [10, 6]);

  // One GET per partial record, in event order; none for the ledger lines,
  // the test ping, the unmapped type or the empty payloads.
  assert.deepEqual(server.requests(TOKEN).slice(before), [
    "GET /v1/transfers/51000000",
    "GET /v1/transfers/52000001",
    "GET /v1/transfers/51000003",
    "GET /v1/transfers/51000004",
    "GET /v1/transfers/51000005",
    "GET /v1/transfers/59999999",
    "GET /v4/profiles/11111111/balances/302",
    "GET /v2/profiles/22222222",
    "GET /v2/accounts/70000007",
    "GET /v2/accounts/70001002",
    "GET /v1/transfers/51000006",
  ]);
});

void test("the transfers RealAdvisor saw NULLed come out whole", async () => {
  const [event] = buildWebhookEvents();
  const result = await connector().runWebhookBatch(
    { events: [event] },
    { timeoutMs: 60_000 },
  );
  const payload = outcomesOf(result)[0].records[0].payload;
  const row = backfill.get("transfers")?.get("51000000");
  assert.ok(row);
  for (const column of ["targetValue", "sourceCurrency", "created", "user"]) {
    assert.notEqual(payload[column], null, column);
    assert.deepEqual(payload[column], row[column], column);
  }
  // The event's state wins over the object's status.
  assert.equal(payload.status, "outgoing_payment_sent");
  assert.equal(payload.current_state, "outgoing_payment_sent");
});

void test("a read that fails holds the event back for a retry, never unfilled", async () => {
  const event = storedEvent(
    {
      event_type: "transfers#state-change",
      schema_version: "2.0.0",
      sent_at: "2026-11-16T10:00:01Z",
      data: {
        resource: { type: "transfer", id: 59_000_400, profile_id: 1 },
        current_state: "processing",
      },
    },
    "d-bad",
  );
  const result = await connector().runWebhookBatch(
    { events: [event] },
    { timeoutMs: 60_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const [outcome] = outcomesOf(result);
  assert.equal(outcome.outcome, "extract_failed");
  assert.match(outcome.reason, /59000400.*HTTP 400/);
});

void test("a rate-limited fill read is deferred after one attempt, never retried into the box timeout", async () => {
  const token = "wise_test_webhooks_ratelimit";
  const event = storedEvent(
    {
      event_type: "transfers#state-change",
      schema_version: "2.0.0",
      sent_at: "2026-11-16T10:00:01Z",
      data: {
        resource: { type: "transfer", id: 59_000_401, profile_id: 1 },
        current_state: "processing",
      },
    },
    "d-limited",
  );
  const result = await connector(token).runWebhookBatch(
    { events: [event] },
    { timeoutMs: 60_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const [outcome] = outcomesOf(result);
  assert.equal(outcome.outcome, "deferred");
  assert.match(outcome.reason, /429/);
  // One attempt: the client's retry policy does not run inside a fill.
  assert.equal(server.requests(token).length, 1);
});

void test("an id that is not a Wise id is refused before any request", async () => {
  const token = "wise_test_badids";
  const transfer = (id: string, n: number) =>
    storedEvent(
      {
        event_type: "transfers#state-change",
        data: { resource: { type: "transfer", id, profile_id: 1 } },
      },
      `d-badid-${n}`,
    );
  const balance = storedEvent(
    {
      event_type: "balances#account-state-change",
      data: { resource: { id: 302, profile_id: "../me" } },
    },
    "d-badid-profile",
  );
  const events = [
    transfer("..", 0),
    transfer("1/../2", 1),
    transfer("12?x=1", 2),
    balance,
  ];
  const result = await connector(token).runWebhookBatch(
    { events },
    { timeoutMs: 60_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(
    outcomesOf(result).map(o => o.outcome),
    ["extract_failed", "extract_failed", "extract_failed", "extract_failed"],
  );
  assert.deepEqual(server.requests(token), []);
});

void test("past the fill budget, events are deferred, never answered unfilled", async () => {
  const folder = await import(
    pathToFileURL(path.join(FOLDER, "webhook-handler.ts")).href
  );
  let clock = 0;
  const gets: string[] = [];
  const api = {
    baseUrl: "http://wise.local",
    async get(endpoint: string) {
      gets.push(endpoint);
      clock += 600;
      return { user: 1 };
    },
  };
  const events = buildWebhookEvents();
  const transfers = events.filter(
    e => e.eventType === "transfers#state-change",
  );
  const ledger = events.find(e => e.eventType === "balances#update");
  assert.ok(ledger);
  const outcomes = await folder.handleWiseWebhookBatch(
    { api, log: () => {}, budgetMs: 1_000, now: () => clock },
    [transfers[0], transfers[1], transfers[2], ledger],
  );
  assert.deepEqual(
    outcomes.map((o: any) => o.outcome),
    ["records", "records", "deferred", "records"],
  );
  assert.equal(gets.length, 2);
});
