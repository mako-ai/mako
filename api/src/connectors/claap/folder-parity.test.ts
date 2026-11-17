/**
 * Parity between this in-process Claap connector and its port to a
 * connector folder (`connectors/claap/`, RFC connector-runtime
 * iteration 5).
 *
 * Both run against the same recorded Claap responses, served locally,
 * signed transcript links included. Every entity is read in 5 scenarios
 * (one page per chunk, two-row pages, the default chunk, incremental
 * `since`, `since` with a 3-day re-read window), 2 in a sixth where every
 * request is first answered 429, and `recordings` in a seventh where the
 * daily quota runs out mid-page. Runs are compared on row count, keys,
 * order, columns, a checksum per row (download times masked), each row's
 * source timestamp, the chunk positions, the requests sent and the error a
 * run ends with. Schemas, the credential form, `check`, layouts,
 * incremental modes, webhook verification, event identity and the change
 * records of every webhook, transcripts included, are compared too.
 *
 * The folder runs through `SandboxedConnector`, the adapter the box path
 * uses, with only the box replaced by a local process. Nothing here starts
 * a box or calls Claap. The harness lives with the folder:
 * connectors/claap/fixtures/harness.mjs. Re-record or print the table with
 * connectors/claap/fixtures/parity.mjs.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ClaapConnector } from "./connector";
import { resolveClaapEntitySchema } from "./schema";
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
  QUOTA_SCENARIO,
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
  masked,
  runFolderCommand,
  runParity,
  startReplayServer,
  type ReplayServer,
} from "../../../../connectors/claap/fixtures/harness.mjs";
import {
  TEST_SECRET,
  buildWebhookDeliveries,
} from "../../../../connectors/claap/fixtures/webhook-events.mjs";

process.env.CONNECTOR_WEBHOOK_BATCHES = "true";

const makeInProcess = inProcessFactory(ClaapConnector);

class BoxlessClaap extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "claap",
      runtime: "node",
      entry: "connector.ts",
      sha: "parity",
      sourceSha: "parity",
      spec: BoxlessClaap.spec,
      entities: Object.keys(BoxlessClaap.spec?.mako?.entities ?? {}),
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
  new BoxlessClaap({
    id: "ds_parity",
    name: "Claap parity",
    type: "ws:claap",
    workspaceId: "ws_parity",
    config,
  } as any);

/** The same folder through a read session: one runner per entity read. */
class SessionClaap extends BoxlessClaap {
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
      SessionClaap.transports.push(this.transport);
    }
    return this.transport;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    if (command === "read") SessionClaap.chunkReads++;
    return super.run(command, options);
  }
}

const makeSession = (config: Record<string, unknown>) =>
  new SessionClaap({
    id: "ds_parity",
    name: "Claap parity",
    type: "ws:claap",
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

let boxed: BoxlessClaap;
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
  BoxlessClaap.spec = spec;
  boxed = makeBoxed({ api_key: "api_test_schema", api_base_url: server.url });
  await boxed.resolveSchema("recordings");
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

void test("same 3 entities in the same order, labels and credential form", () => {
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
    ClaapConnector.getConfigSchema().fields,
    connectionSpecificationToForm(spec?.connectionSpecification).fields,
  );
  assert.ok(form.ok, JSON.stringify(form, null, 2));
});

void test("same columns, types and keys for every entity, system columns included", async () => {
  const system = new Set(Object.keys(MAKO_SYSTEM_FIELDS));
  for (const entity of ENTITIES) {
    const inProcess = resolveClaapEntitySchema(entity);
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
  const extra = [
    ...(await runParity({
      entities: RATE_LIMIT_ENTITIES,
      makeInProcess,
      makeBoxed,
      server,
      sourceTs,
      scenarios: [RATE_LIMIT_SCENARIO],
    })),
    ...(await runParity({
      entities: ["recordings"],
      makeInProcess,
      makeBoxed,
      server,
      sourceTs,
      scenarios: [QUOTA_SCENARIO],
    })),
  ];
  const all = [...results, ...extra];
  assert.equal(all.length, ENTITIES.length * SCENARIOS.length + 3);
  assert.deepEqual(
    all.filter(r => !r.ok).map(r => `${r.scenario}/${r.entity}`),
    [],
    `${formatReport(results)}\n${formatReport(extra)}`,
  );
  assert.deepEqual(server.misses, []);

  const find = (scenario: string, entity: string) => {
    const result = all.find(
      r => r.scenario === scenario && r.entity === entity,
    );
    assert.ok(result, `${scenario}/${entity} did not run`);
    return result;
  };
  // 23 recordings, 2 skipped (a 404 and a Ready one without aiFields).
  assert.deepEqual(find("default", "recordings").rows, [21, 21]);
  // 1 list page and 23 detail reads.
  assert.deepEqual(find("default", "recordings").requests, [24, 24]);
  // 29 transcripts of 23 recordings: signed links, 2 API fallbacks, 1 failure.
  assert.deepEqual(find("default", "recording_transcripts").rows, [29, 29]);
  // Two a page, one page a chunk: 12 chunks.
  assert.deepEqual(find("small-pages", "recordings").chunks, [12, 12]);
  // A 3-day re-read window reads 1 more recording than `since` alone.
  assert.deepEqual(find("since", "recordings").rows, [12, 12]);
  assert.deepEqual(find("lookback", "recordings").rows, [13, 13]);
  // Every request was answered 429 once and retried, on both sides.
  // 5 list pages of 5 and 23 detail reads, each sent twice.
  assert.deepEqual(find("rate-limited", "recordings").requests, [56, 56]);
  // The quota: a checkpoint mid-page, then the same error on both sides.
  const quota = find("quota", "recordings");
  assert.deepEqual(quota.chunks, [1, 1]);
  assert.deepEqual(quota.rows, [17, 17]);
  assert.match(String(quota.endError), /daily API quota nearly used up/);
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
      ["small-pages", "since"].includes(s.name),
    );
    // Recordings and the workspace: a session runner has no fixture
    // preload, so signed transcript links would leave the machine.
    const results = await runParity({
      entities: ["recordings", "workspace"],
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
    assert.equal(SessionClaap.chunkReads, 0);
    const calls = SessionClaap.transports.flatMap(t => t.calls);
    assert.equal(calls.filter(c => c === "start").length, 4);
    assert.equal(calls.filter(c => c === "close").length, 4);
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
  assert.deepEqual(declaredWebhookVerification(spec), {
    scheme: "shared-secret",
    secretHeader: "x-claap-webhook-secret",
  });
  assert.deepEqual(declaredWebhookIdentity(spec), {
    eventIdPath: "eventId",
    eventTypePath: "event.type",
  });
});

void test("webhooks: the API's check of the declaration agrees with the in-process check", async () => {
  const inProcess = makeInProcess({ api_key: "api_test_verify" });
  const payload = deliveries[0].raw;
  const header = (value: string) => ({ "X-Claap-Webhook-Secret": value });
  const cases = [
    {
      name: "valid",
      payload,
      headers: header(TEST_SECRET),
      secret: TEST_SECRET,
    },
    {
      name: "wrong secret",
      payload,
      headers: header(`${TEST_SECRET}x`),
      secret: TEST_SECRET,
    },
    { name: "no header", payload, headers: {}, secret: TEST_SECRET },
    { name: "no secret", payload, headers: header(TEST_SECRET) },
    {
      name: "not JSON",
      payload: "{",
      headers: header(TEST_SECRET),
      secret: TEST_SECRET,
    },
  ];
  const outcomes: Array<[string, boolean, boolean]> = [];
  for (const c of cases) {
    const a = await inProcess.verifyWebhook({ ...c, query: {} });
    const b = await boxed.verifyWebhook({ ...c, query: {} });
    outcomes.push([c.name, a.valid, b.valid]);
    if (a.valid && b.valid) {
      const identity = boxed.webhookEventIdentity(b.event, c.payload);
      assert.equal(identity.eventId, a.event.id, c.name);
      assert.equal(identity.eventType, a.event.type, c.name);
    }
  }
  assert.deepEqual(outcomes, [
    ["valid", true, true],
    ["wrong secret", false, false],
    ["no header", false, false],
    ["no secret", false, false],
    ["not JSON", false, false],
  ]);
  // One difference on purpose: the API refuses a secret under 16 bytes,
  // which the in-process check accepts.
  const short = {
    payload,
    headers: header("short-8"),
    secret: "short-8",
    query: {},
  };
  assert.equal((await inProcess.verifyWebhook(short)).valid, true);
  assert.equal((await boxed.verifyWebhook(short)).valid, false);
});

/** The in-process records of a delivery: extraction, then enrichment. */
async function inProcessRecords(
  delivery: Record<string, any>,
  key: string,
  transcripts: boolean,
) {
  const inProcess = makeInProcess({ api_key: key, api_base_url: server.url });
  const verified = await inProcess.verifyWebhook({
    payload: delivery.raw,
    headers: { "x-claap-webhook-secret": TEST_SECRET },
    secret: TEST_SECRET,
    query: {},
  });
  assert.ok(verified.valid);
  const extracted = inProcess.extractWebhookCdcRecords(
    verified.event,
    verified.event.type,
  );
  const enriched =
    extracted.length > 0
      ? await inProcess.enrichWebhookCdcRecords(extracted, {
          isEntityEnabled: (e: string) =>
            transcripts || e !== "recording_transcripts",
        })
      : extracted;
  const shape = (records: any[]) =>
    records.map(({ source: _source, ...r }: any) => ({
      ...r,
      sourceTs: r.sourceTs.toISOString(),
    }));
  return {
    mapped: Boolean(inProcess.getWebhookEventMapping(verified.event.type)),
    extracted: shape(extracted),
    enriched: shape(enriched),
  };
}

/**
 * Records with a time that fell back to "now" made comparable: each side
 * reads its own clock, a few ms apart. Download times are masked too.
 */
function withoutNow<T>(records: T): T {
  const now = realNow();
  const text = JSON.stringify(records).replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
    iso => (Math.abs(Date.parse(iso) - now) < 60_000 ? "<now>" : iso),
  );
  return JSON.parse(text, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? masked(value)
      : value,
  );
}

void test("webhooks: the folder extracts the in-process change records from every delivery", async () => {
  const { claapWebhookRecords } = await folderWebhooks();
  for (const delivery of deliveries) {
    const expected = await inProcessRecords(
      delivery,
      "api_test_extract",
      false,
    );
    const folder = claapWebhookRecords(
      delivery.event.rawPayload,
      delivery.event.eventType,
    );
    assert.equal(
      canonicalJson(withoutNow(folder)),
      canonicalJson(withoutNow(expected.extracted)),
      delivery.name,
    );
  }
});

for (const transcripts of [true, false]) {
  void test(`webhooks: a box batch fills partial recordings${transcripts ? " and downloads transcripts" : ", transcripts off"}`, async () => {
    const cassettes = loadCassettes() as Map<
      string,
      { status: number; body: any }
    >;
    const fillFields = Object.keys(
      resolveClaapEntitySchema("recordings")!.fields,
    ).filter(
      f => !["id", "crmInfo", "deal"].includes(f) && !(f in MAKO_SYSTEM_FIELDS),
    );
    const folderKey = `api_test_webhook_batch_${transcripts}`;
    const inKey = `api_test_webhook_inprocess_${transcripts}`;
    const connection = makeBoxed({
      api_key: folderKey,
      api_base_url: server.url,
    });
    const run = await connection.runWebhookBatch(
      {
        events: deliveries.map(d => d.event),
        enabledEntities: transcripts
          ? ENTITIES
          : ENTITIES.filter(e => e !== "recording_transcripts"),
      },
      { timeoutMs: 60_000 },
    );
    assert.equal(run.exitCode, 0, run.stderr);
    const outcomes = run.messages
      .filter(m => m.type === "WEBHOOK")
      .map(m => (m as any).webhook);
    assert.equal(outcomes.length, deliveries.length);

    const fillRequests: string[] = [];
    /** Recordings whose event the folder holds back: no download for them. */
    const heldBack: string[] = [];
    const summary: Record<string, number> = {};
    for (const [i, delivery] of deliveries.entries()) {
      const outcome = outcomes[i];
      assert.equal(outcome.eventId, delivery.event.eventId);
      summary[outcome.outcome] = (summary[outcome.outcome] ?? 0) + 1;
      const expected = await inProcessRecords(delivery, inKey, transcripts);
      if (!expected.mapped) {
        assert.equal(outcome.outcome, "unmapped", delivery.name);
        continue;
      }
      if (expected.extracted.length === 0) {
        assert.equal(outcome.outcome, "extract_failed", delivery.name);
        continue;
      }
      // The in-process records, the recording filled from its detail.
      const [recording, ...rows] = expected.enriched;
      const missing = fillFields.filter(f => !(f in recording.payload));
      let want = "records";
      let filled = recording;
      if (missing.length > 0) {
        const key = `GET /v1/recordings/${recording.recordId}?returnAiFields=true`;
        fillRequests.push(key);
        const answer = cassettes.get(key);
        const detail = answer?.body?.result?.recording;
        if (answer?.status === 404) want = "skipped";
        else if (
          !detail ||
          (detail.state === "Ready" && !Array.isArray(detail.aiFields))
        ) {
          want = "extract_failed";
        } else {
          const payload = { ...recording.payload };
          for (const f of missing) payload[f] = f in detail ? detail[f] : null;
          filled = { ...recording, payload };
          // A filled recording holds what a backfill holds, column for column.
          for (const f of fillFields) {
            if (f in delivery.body.event.recording) continue;
            assert.equal(
              canonicalJson(payload[f] ?? null),
              canonicalJson(detail[f] ?? null),
              f,
            );
          }
        }
      }
      assert.equal(outcome.outcome, want, delivery.name);
      if (want !== "records") {
        heldBack.push(recording.recordId);
        continue;
      }
      assert.equal(
        canonicalJson(withoutNow(outcome.records)),
        canonicalJson(withoutNow([filled, ...rows])),
        delivery.name,
      );
      assert.equal(
        outcome.records.filter((r: any) => r.entity === "recording_transcripts")
          .length,
        transcripts ? rows.length : 0,
      );
    }
    assert.deepEqual(summary, {
      records: 6,
      skipped: 1,
      extract_failed: 2,
      unmapped: 1,
    });
    // The folder sent the fills, plus exactly the in-process downloads.
    const inRequests = server
      .requests(inKey)
      .filter(r => !heldBack.some(id => r.includes(`/${id}/`)));
    assert.deepEqual(
      server.requests(folderKey).sort(),
      [...fillRequests, ...inRequests].sort(),
    );
    assert.equal(
      inRequests.some(r => r.startsWith("GET /signed/")),
      transcripts,
    );
  });
}

void test("webhooks: past its budget a read is deferred, never answered unfilled", async () => {
  const { handleClaapWebhookBatch } = await folderWebhooks();
  let clock = 0;
  const partial = deliveries.find(d => d.name === "partial: no source")!;
  const events = [partial.event, partial.event, partial.event].map((e, i) => ({
    ...e,
    eventId: `${e.eventId}_${i}`,
  }));
  const detail = partial.body.event.recording;
  const outcomes = await handleClaapWebhookBatch(
    {
      api: {
        get: async () => {
          clock += 30_000;
          return {
            data: { result: { recording: { ...detail, source: "upload" } } },
            headers: new Headers(),
          };
        },
      },
      sleep: async () => {},
      log: () => {},
      transcripts: {} as never,
      now: () => clock,
    },
    events,
    { enabledEntities: ["recordings"] },
  );
  assert.deepEqual(
    outcomes.map((o: any) => o.outcome),
    ["records", "records", "deferred"],
  );
});

void test("the comparison catches a changed field, a lost row and another request", () => {
  const rows = [
    { id: "a", date_modified: "2026-01-01T00:00:00Z", n: 1 },
    { id: "b", date_modified: "2026-01-02T00:00:00Z", n: 2 },
  ];
  const base = {
    rows,
    chunks: [{ position: { page: 1, totalProcessed: 2 }, hasMore: false }],
    requests: ["GET /v1/workspaces/mine"],
  };
  assert.ok(compareRuns(base, structuredClone(base)).ok);
  const changed = structuredClone(base);
  changed.rows[1].n = 3;
  assert.deepEqual(compareRuns(base, changed).checksumMismatches, ["b"]);
  const lost = { ...structuredClone(base), rows: [rows[0]] };
  assert.equal(compareRuns(base, lost).keys, false);
  const other = {
    ...structuredClone(base),
    requests: ["GET /v1/recordings?limit=50"],
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
  assert.match(all, /rec_gone\?returnAiFields=true","status":404/);
  assert.match(all, /rec_0005\/fr\.json\?sig=fixture5","status":403/);
  assert.match(all, /rec_0008\/transcript\?format=json&lang=de","status":404/);
  assert.doesNotMatch(all, /@(?!example\.test)[a-z0-9-]+\.[a-z]/i);
});
