/**
 * Parity between this in-process PandaDoc connector and its port to a
 * connector folder (`connectors/pandadoc/`, RFC connector-runtime
 * iteration 5).
 *
 * Both run against the same recorded PandaDoc responses, served locally.
 * Every entity is read in 6 scenarios (one page per chunk, two-row pages,
 * the default chunk, ten-row pages with the 2-page hydration cap,
 * incremental `since`, hydration off) and 2 in a seventh where every
 * request is first answered 429. Runs are compared on row count, keys,
 * order, columns, a checksum per row, each row's source timestamp, the
 * chunk positions and the requests sent. Schemas, the credential form,
 * `check`, layouts, incremental modes, webhook verification, event
 * identity and the change records of every webhook are compared too.
 *
 * The folder runs through `SandboxedConnector`, the adapter the box path
 * uses, with only the box replaced by a local process. Nothing here starts
 * a box or calls PandaDoc. The harness lives with the folder:
 * connectors/pandadoc/fixtures/harness.mjs. Re-record or print the table
 * with connectors/pandadoc/fixtures/parity.mjs.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PandaDocConnector } from "./connector";
import { resolvePandaDocEntitySchema } from "./schema";
import { MAKO_SYSTEM_FIELDS } from "../base/BaseConnector";
import { parseConnectorFile } from "../workspace/connector-file";
import { SandboxedConnector } from "../workspace/SandboxedConnector";
import type { LoadedConnector } from "../workspace/resolver";
import type { ConnectorCommand, RunResult } from "../workspace/sync-box";
import {
  connectionSpecificationToForm,
  jsonSchemaToEntitySchema,
} from "../workspace/spec-translation";
import {
  declaredWebhookIdentity,
  declaredWebhookVerification,
} from "../workspace/webhook-verification";
import { LocalSessionTransport } from "../workspace/test-support/local-session";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
} from "../../sync-cdc/normalization";
import {
  CASSETTE_DIR,
  ENTITIES,
  FOLDER,
  RATE_LIMIT_ENTITIES,
  RATE_LIMIT_SCENARIO,
  RUNNER,
  SCENARIOS,
  canonicalJson,
  checkParity,
  compareEntitySchema,
  compareForm,
  compareRuns,
  ensureFolderInstalled,
  formatReport,
  freezeClock,
  inProcessFactory,
  loadCassettes,
  readInProcess,
  runFolderCommand,
  runParity,
  startReplayServer,
  type ReplayServer,
} from "../../../../connectors/pandadoc/fixtures/harness.mjs";
import {
  TEST_SHARED_KEY,
  WEBHOOK_OMITS,
  buildWebhookDeliveries,
  sign,
} from "../../../../connectors/pandadoc/fixtures/webhook-events.mjs";

process.env.CONNECTOR_WEBHOOK_BATCHES = "true";

const makeInProcess = inProcessFactory(PandaDocConnector);

class BoxlessPandaDoc extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "pandadoc",
      runtime: "node",
      entry: "connector.ts",
      sha: "parity",
      sourceSha: "parity",
      spec: BoxlessPandaDoc.spec,
      entities: Object.keys(BoxlessPandaDoc.spec?.mako?.entities ?? {}),
      status: "indexed",
    } as LoadedConnector;
    return this.loaded;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    const result = await runFolderCommand(command, options as any);
    return {
      exitCode: result.code ?? 1,
      messages: result.messages as RunResult["messages"],
      malformed: [],
      stderr: result.stderr,
      timedOut: false,
    };
  }
}

const makeBoxed = (config: Record<string, unknown>) =>
  new BoxlessPandaDoc({
    id: "ds_parity",
    name: "PandaDoc parity",
    type: "ws:pandadoc",
    workspaceId: "ws_parity",
    config,
  } as any);

/** The same folder through a read session: one runner per entity read. */
class SessionPandaDoc extends BoxlessPandaDoc {
  static transports: LocalSessionTransport[] = [];
  static chunkReads = 0;
  private transport: LocalSessionTransport | null = null;

  protected async sessionTransport() {
    if (!this.transport) {
      this.transport = new LocalSessionTransport({
        runner: RUNNER,
        connector: path.join(FOLDER, "connector.ts"),
        cwd: FOLDER,
      });
      SessionPandaDoc.transports.push(this.transport);
    }
    return this.transport;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    if (command === "read") SessionPandaDoc.chunkReads++;
    return super.run(command, options);
  }
}

const makeSession = (config: Record<string, unknown>) =>
  new SessionPandaDoc({
    id: "ds_parity",
    name: "PandaDoc parity",
    type: "ws:pandadoc",
    workspaceId: "ws_parity",
    config,
  } as any);

const realNow = () => new Date().getTime();
/** A row with no time of its own gets "now" on both sides. */
const tsOrFallback = (date: Date | undefined) =>
  !date
    ? null
    : Math.abs(date.getTime() - realNow()) < 60_000
      ? "now"
      : date.toISOString();

let boxed: BoxlessPandaDoc;
const sourceTs = {
  inProcess: (row: Record<string, unknown>, entity: string) => [
    tsOrFallback(resolveSourceTimestamp(normalizePayloadKeys(row))),
    tsOrFallback(
      makeInProcess({ api_key: "api_test_ts" }).normalizeBackfillRecord(
        entity,
        row,
      )?.sourceTs,
    ),
  ],
  folder: (row: Record<string, unknown>, entity: string) => [
    tsOrFallback(resolveSourceTimestamp(normalizePayloadKeys(row))),
    tsOrFallback(boxed.normalizeBackfillRecord(entity, row)?.sourceTs),
  ],
};

let server: ReplayServer;
let restoreClock: () => void;
let streams: Array<Record<string, any>> = [];
let spec: Record<string, any> | undefined;

before(async () => {
  restoreClock = freezeClock();
  ensureFolderInstalled();
  server = await startReplayServer();
  const discover = await runFolderCommand("discover", {
    config: { api_key: "api_test_schema", api_base_url: server.url },
  });
  streams =
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  BoxlessPandaDoc.spec = spec;
  boxed = makeBoxed({ api_key: "api_test_schema", api_base_url: server.url });
  await boxed.resolveSchema("documents");
});

after(async () => {
  await server?.close();
  restoreClock?.();
});

void test("connector.yaml is a node folder with its entry", () => {
  const parsed = parseConnectorFile(
    fs.readFileSync(path.join(FOLDER, "connector.yaml"), "utf8"),
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.equal(parsed.value.runtime, "node");
  assert.equal(parsed.value.entry, "connector.ts");
});

void test("same 4 entities in the same order, labels and credential form", () => {
  const inProcess = makeInProcess({ api_key: "api_test_list" });
  assert.deepEqual(inProcess.getAvailableEntities(), ENTITIES);
  assert.deepEqual(
    streams.map(s => s.name),
    ENTITIES,
  );
  for (const { name, label, description } of inProcess.getEntityMetadata()) {
    assert.equal(spec?.mako?.entities?.[name]?.label, label, name);
    assert.equal(spec?.mako?.entities?.[name]?.description, description);
  }
  const form = compareForm(
    PandaDocConnector.getConfigSchema().fields,
    connectionSpecificationToForm(spec?.connectionSpecification).fields,
  );
  assert.ok(form.ok, JSON.stringify(form, null, 2));
});

void test("same columns, types and keys for every entity, system columns included", async () => {
  const system = new Set(Object.keys(MAKO_SYSTEM_FIELDS));
  for (const entity of ENTITIES) {
    const inProcess = resolvePandaDocEntitySchema(entity);
    const result = compareEntitySchema(
      inProcess,
      jsonSchemaToEntitySchema(
        entity,
        streams.find(s => s.name === entity),
      ),
      system,
    );
    assert.ok(result.ok, `${entity}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.systemDiffs, [], entity);
    const viaBox = compareEntitySchema(
      inProcess,
      await boxed.resolveSchema(entity),
    );
    assert.ok(viaBox.ok, `${entity} via the box: ${JSON.stringify(viaBox)}`);
  }
});

void test("same table layout and incremental mode for every entity", async () => {
  const inProcess = makeInProcess({ api_key: "api_test_list" });
  await boxed.loadDefinition();
  const layouts = (c: { getEntityMetadata(): any[] }) =>
    Object.fromEntries(
      c.getEntityMetadata().map(e => [e.name, e.layoutSuggestion ?? null]),
    );
  assert.deepEqual(layouts(boxed), layouts(inProcess));
  const effective = (caps: any, entity: string) =>
    caps.perEntity?.[entity]?.mode ?? caps.mode;
  const inCaps = inProcess.getIncrementalCapabilities();
  const boxCaps = boxed.getIncrementalCapabilities();
  assert.equal(boxCaps.supported, inCaps.supported);
  for (const entity of ENTITIES) {
    assert.equal(effective(boxCaps, entity), effective(inCaps, entity), entity);
  }
});

void test("check agrees on a valid key and on a revoked one", async () => {
  const outcomes = await checkParity({ makeInProcess, server });
  assert.deepEqual(
    outcomes.map(o => [o.variant, o.inProcess, o.folder, o.requestsEqual]),
    [
      ["valid", true, true, true],
      ["revoked", false, false, true],
    ],
  );
});

void test("every entity reads the same rows, timestamps, chunks and requests", async () => {
  const results = await runParity({
    makeInProcess,
    makeBoxed,
    server,
    sourceTs,
  });
  const limited = await runParity({
    entities: RATE_LIMIT_ENTITIES,
    makeInProcess,
    makeBoxed,
    server,
    sourceTs,
    scenarios: [RATE_LIMIT_SCENARIO],
  });
  const all = [...results, ...limited];
  assert.equal(all.length, ENTITIES.length * SCENARIOS.length + 2);
  assert.deepEqual(
    all.filter(r => !r.ok).map(r => `${r.scenario}/${r.entity}`),
    [],
    `${formatReport(results)}\n${formatReport(limited)}`,
  );
  assert.deepEqual(server.misses, []);

  const find = (scenario: string, entity: string) => {
    const result = all.find(
      r => r.scenario === scenario && r.entity === entity,
    );
    assert.ok(result, `${scenario}/${entity} did not run`);
    return result;
  };
  // 25 documents: 1 list page and 25 detail reads (2 refused, kept as listed).
  assert.deepEqual(find("default", "documents").requests, [26, 26]);
  // Ten a page: hydration ends the first chunk at 2 pages, as in-process.
  assert.deepEqual(find("paged", "documents").chunks, [2, 2]);
  // Two a page, one page a chunk: 13 chunks.
  assert.deepEqual(find("small-pages", "documents").chunks, [13, 13]);
  // `modified_from` on documents, `date_modified` kept on templates/members.
  assert.deepEqual(find("since", "documents").rows, [11, 11]);
  assert.deepEqual(find("since", "templates").rows, [7, 7]);
  assert.deepEqual(find("since", "members").rows, [2, 2]);
  // Hydration off: the list projection, 3 list pages, no detail read.
  assert.deepEqual(find("no-details", "documents").requests, [3, 3]);
  // Every request was answered 429 once and retried, on both sides.
  assert.equal(
    find("rate-limited", "documents").requests[0],
    2 * find("paged", "documents").requests[0],
  );
});

void test("a read session reads the same rows, chunks and requests", async () => {
  const previous = process.env.CONNECTOR_SESSION_READS;
  process.env.CONNECTOR_SESSION_READS = "true";
  // The session supervisor's deadline is `Date.now()` plus an hour, read
  // here and checked on its own clock: the frozen fixture clock would put
  // it a day in the past.
  restoreClock();
  const own = await startReplayServer();
  try {
    const scenarios = SCENARIOS.filter(s =>
      ["small-pages", "paged", "since"].includes(s.name),
    );
    const results = await runParity({
      entities: ["documents", "templates"],
      makeInProcess,
      makeBoxed: makeSession,
      server: own,
      sourceTs,
      scenarios,
    });
    assert.deepEqual(
      results.filter(r => !r.ok).map(r => `${r.scenario}/${r.entity}`),
      [],
      formatReport(results),
    );
    assert.equal(SessionPandaDoc.chunkReads, 0);
    const calls = SessionPandaDoc.transports.flatMap(t => t.calls);
    assert.equal(calls.filter(c => c === "start").length, 6);
    assert.equal(calls.filter(c => c === "close").length, 6);
    // The hydration cap ends a session batch at 2 pages, as a chunk.
    const paged = results.find(
      r => r.scenario === "paged" && r.entity === "documents",
    );
    assert.deepEqual(paged?.chunks, [2, 2]);
  } finally {
    await own.close();
    restoreClock = freezeClock();
    if (previous === undefined) delete process.env.CONNECTOR_SESSION_READS;
    else process.env.CONNECTOR_SESSION_READS = previous;
  }
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const deliveries = buildWebhookDeliveries();
const folderWebhooks = () =>
  import(pathToFileURL(path.join(FOLDER, "webhooks.ts")).href);

void test("webhooks: the same events and a verification Mako can run", () => {
  const inProcess = makeInProcess({ api_key: "api_test_list" });
  assert.deepEqual(
    spec?.mako?.webhooks?.events,
    inProcess.getSupportedWebhookEvents(),
  );
  assert.ok(declaredWebhookVerification(spec));
  assert.deepEqual(declaredWebhookIdentity(spec), { eventTypePath: "0.event" });
});

void test("webhooks: the API's check of the declaration agrees with the in-process check", async () => {
  const inProcess = makeInProcess({ api_key: "api_test_verify" });
  const body = deliveries[0].body;
  const signature = sign(body);
  const cases: Array<{
    name: string;
    payload: string;
    headers: Record<string, string>;
    query: Record<string, string>;
    secret?: string;
  }> = [
    {
      name: "query",
      payload: body,
      headers: {},
      query: { signature },
      secret: TEST_SHARED_KEY,
    },
    {
      name: "header",
      payload: body,
      headers: { signature },
      query: {},
      secret: TEST_SHARED_KEY,
    },
    {
      name: "upper-case hex",
      payload: body,
      headers: {},
      query: { signature: signature.toUpperCase() },
      secret: TEST_SHARED_KEY,
    },
    {
      name: "tampered body",
      payload: body.replace("Mandate", "Mandat"),
      headers: {},
      query: { signature },
      secret: TEST_SHARED_KEY,
    },
    {
      name: "wrong key",
      payload: body,
      headers: {},
      query: { signature: sign(body, "another-fixture-key-000000000") },
      secret: TEST_SHARED_KEY,
    },
    {
      name: "no signature",
      payload: body,
      headers: {},
      query: {},
      secret: TEST_SHARED_KEY,
    },
    { name: "no secret", payload: body, headers: {}, query: { signature } },
  ];
  const outcomes: Array<[string, boolean, boolean]> = [];
  for (const c of cases) {
    const a = await inProcess.verifyWebhook(c);
    const b = await boxed.verifyWebhook(c);
    outcomes.push([c.name, a.valid, b.valid]);
    if (a.valid && b.valid) {
      // The stored event's id and type: SHA-1 of the body, first trigger.
      const identity = boxed.webhookEventIdentity(b.event, c.payload);
      assert.equal(identity.eventId, a.event.id, c.name);
      assert.equal(identity.eventType, a.event.type, c.name);
    }
  }
  assert.deepEqual(outcomes, [
    ["query", true, true],
    ["header", true, true],
    ["upper-case hex", true, true],
    ["tampered body", false, false],
    ["wrong key", false, false],
    ["no signature", false, false],
    ["no secret", false, false],
  ]);
});

/**
 * Records with a time that fell back to "now" made comparable: each side
 * reads its own clock, a few ms apart.
 */
function withoutNow<T>(records: T): T {
  const now = realNow();
  return JSON.parse(
    JSON.stringify(records).replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
      iso => (Math.abs(Date.parse(iso) - now) < 60_000 ? "<now>" : iso),
    ),
  );
}

/** The in-process records of a delivery, as the inline cron extracts them. */
async function inProcessRecords(delivery: Record<string, any>) {
  const inProcess = makeInProcess({ api_key: "api_test_extract" });
  const verified = await inProcess.verifyWebhook({
    payload: delivery.body,
    headers: {},
    query: { signature: sign(delivery.body) },
    secret: TEST_SHARED_KEY,
  });
  assert.ok(verified.valid);
  return {
    eventType: verified.event.type as string,
    mapped: Boolean(inProcess.getWebhookEventMapping(verified.event.type)),
    records: inProcess
      .extractWebhookCdcRecords(verified.event, verified.event.type)
      .map(({ source: _source, ...r }: any) => ({
        ...r,
        sourceTs: r.sourceTs.toISOString(),
      })),
  };
}

void test("webhooks: the folder extracts the in-process change records from every delivery", async () => {
  const { pandaDocWebhookRecords } = await folderWebhooks();
  for (const delivery of deliveries) {
    const expected = await inProcessRecords(delivery);
    const folder = pandaDocWebhookRecords(
      delivery.event.rawPayload,
      delivery.event.eventType,
    );
    assert.equal(
      canonicalJson(withoutNow(folder)),
      canonicalJson(withoutNow(expected.records)),
      delivery.name,
    );
  }
});

void test("webhooks: a box batch fills partial rows from their details, and only those", async () => {
  const cassettes = loadCassettes() as Map<
    string,
    { status: number; body: any }
  >;
  const fillFields = (entity: string) =>
    Object.keys(resolvePandaDocEntitySchema(entity)!.fields).filter(
      f => f !== "id" && !(f in MAKO_SYSTEM_FIELDS),
    );
  const detailsPath = (entity: string, id: string) =>
    `GET /public/v1/${entity}/${id}/details`;

  // The in-process backfill rows, to hold filled documents to.
  const backfill = await readInProcess(
    () =>
      makeInProcess({ api_key: "api_test_backfill", api_base_url: server.url }),
    { entity: "documents", maxIterations: 10 },
  );
  const backfillRow = new Map(
    backfill.rows.map((r: Record<string, any>) => [String(r.id), r]),
  );

  const connection = makeBoxed({
    api_key: "api_test_webhook_batch",
    api_base_url: server.url,
  });
  const run = await connection.runWebhookBatch(
    { events: deliveries.map(d => d.event), enabledEntities: ENTITIES },
    { timeoutMs: 60_000 },
  );
  assert.equal(run.exitCode, 0, run.stderr);
  const outcomes = run.messages
    .filter(m => m.type === "WEBHOOK")
    .map(m => (m as any).webhook);
  assert.equal(outcomes.length, deliveries.length);

  const expectedRequests: string[] = [];
  const summary: Record<string, string> = {};
  let filledDocuments = 0;
  for (const [i, delivery] of deliveries.entries()) {
    const outcome = outcomes[i];
    assert.equal(outcome.eventId, delivery.event.eventId);
    const expected = await inProcessRecords(delivery);
    summary[delivery.name] = outcome.outcome;
    if (!expected.mapped) {
      assert.equal(outcome.outcome, "unmapped", delivery.name);
      continue;
    }
    if (expected.records.length === 0) {
      assert.equal(outcome.outcome, "extract_failed", delivery.name);
      continue;
    }
    // In-process records, each partial upsert filled from its details.
    const filled: any[] = [];
    let verdict: string | null = null;
    for (const record of expected.records) {
      const missing =
        record.operation === "upsert"
          ? fillFields(record.entity).filter(f => !(f in record.payload))
          : [];
      if (missing.length === 0) {
        filled.push(record);
        continue;
      }
      const key = detailsPath(record.entity, record.recordId);
      expectedRequests.push(key);
      const answer = cassettes.get(key);
      if (answer?.status === 404) continue;
      if (!answer || answer.status >= 300) {
        verdict = "extract_failed";
        break;
      }
      const payload = { ...record.payload };
      for (const f of missing) {
        payload[f] = f in answer.body ? answer.body[f] : null;
      }
      filled.push({ ...record, payload });
      if (record.entity === "documents") {
        // A filled document holds what a backfill holds, column for column.
        filledDocuments++;
        const row = backfillRow.get(record.recordId);
        assert.ok(row, record.recordId);
        for (const f of fillFields("documents")) {
          assert.equal(
            canonicalJson(payload[f] ?? null),
            canonicalJson(row![f] ?? null),
            `${delivery.name}: ${f}`,
          );
        }
      }
    }
    const want = verdict ?? (filled.length > 0 ? "records" : "skipped");
    assert.equal(outcome.outcome, want, delivery.name);
    if (want === "records") {
      assert.equal(
        canonicalJson(withoutNow(outcome.records)),
        canonicalJson(withoutNow(filled)),
        delivery.name,
      );
      // No record leaves with a schema column missing.
      for (const r of outcome.records) {
        if (r.operation !== "upsert") continue;
        for (const f of fillFields(r.entity)) assert.ok(f in r.payload, f);
      }
    }
  }
  assert.ok(filledDocuments >= 8, String(filledDocuments));
  assert.deepEqual(
    server.requests("api_test_webhook_batch").sort(),
    expectedRequests.sort(),
  );
  assert.deepEqual(
    Object.values(summary).reduce<Record<string, number>>(
      (acc, o) => ({ ...acc, [o]: (acc[o] ?? 0) + 1 }),
      {},
    ),
    { records: 13, skipped: 1, extract_failed: 2, unmapped: 1 },
  );
  // Real deliveries leave these out; every filled document has them back.
  assert.deepEqual(WEBHOOK_OMITS.length, 5);
});

void test("webhooks: past its budget a fill is deferred, never answered unfilled", async () => {
  const { handlePandaDocWebhookBatch } = await folderWebhooks();
  let clock = 0;
  const reads: string[] = [];
  const outcomes = await handlePandaDocWebhookBatch(
    {
      api: {
        get: async (p: string) => {
          reads.push(p);
          clock += 30_000;
          return { id: "x", date_completed: null };
        },
      },
      pauseMs: 0,
      sleep: async () => {},
      log: () => {},
      now: () => clock,
    },
    deliveries.slice(0, 3).map(d => d.event),
  );
  assert.deepEqual(
    outcomes.map((o: any) => o.outcome),
    ["records", "records", "deferred"],
  );
  assert.equal(reads.length, 2);
});

void test("the comparison catches a changed field, a lost row and another request", () => {
  const rows = [
    { id: "a", date_modified: "2026-01-01T00:00:00Z", n: 1 },
    { id: "b", date_modified: "2026-01-02T00:00:00Z", n: 2 },
  ];
  const base = {
    rows,
    chunks: [{ position: { page: 1, totalProcessed: 2 }, hasMore: false }],
    requests: ["GET /public/v1/templates?count=100&page=1"],
  };
  assert.ok(compareRuns(base, structuredClone(base)).ok);
  const changed = structuredClone(base);
  changed.rows[1].n = 3;
  assert.deepEqual(compareRuns(base, changed).checksumMismatches, ["b"]);
  const lost = { ...structuredClone(base), rows: [rows[0]] };
  assert.equal(compareRuns(base, lost).keys, false);
  const other = {
    ...structuredClone(base),
    requests: ["GET /public/v1/templates?count=100&page=2"],
  };
  assert.equal(compareRuns(base, other).requestsEqual, false);
  const moved = structuredClone(base);
  moved.chunks[0].position.page = 2;
  assert.equal(compareRuns(base, moved).chunkStates, false);
});

void test("the cassettes hold no real key and walk the error paths", () => {
  const all = fs
    .readdirSync(CASSETTE_DIR)
    .map(f => fs.readFileSync(path.join(CASSETTE_DIR, f), "utf8"))
    .join("\n");
  assert.doesNotMatch(all, /API-Key [^a]/);
  assert.match(all, /doc_nodetail_404\/details","status":404/);
  assert.match(all, /doc_nodetail_400\/details","status":400/);
  assert.doesNotMatch(all, /@(?!example\.test)[a-z0-9-]+\.[a-z]/i);
});
