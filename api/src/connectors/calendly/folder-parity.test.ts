/**
 * Parity between this in-process Calendly connector and its port to a
 * connector folder (`connectors/calendly/`, RFC connector-runtime
 * iteration 5).
 *
 * Both run against the same recorded Calendly responses, served locally.
 * Every entity is read in four scenarios (one page per chunk, two rows a
 * page, the default chunk, incremental `since`) and three in a fifth where
 * every request is first answered 429. Runs are compared on row count,
 * keys, order, columns, a checksum per row, each row's source timestamp,
 * the chunk positions and the requests sent (exact order, except invitees,
 * whose concurrent waves are compared as sorted lists). Schemas, layouts,
 * incremental modes, the credential form, `check` and the webhook mapping
 * are compared too.
 *
 * The folder runs through `SandboxedConnector`, the adapter the box path
 * uses, with only the box replaced by a local process (`BoxlessCalendly`).
 * Nothing here starts a box or calls Calendly. The harness lives with the
 * folder: connectors/calendly/fixtures/harness.mjs. Re-record or print the
 * tables with connectors/calendly/fixtures/parity.mjs.
 *
 * Run: node --import tsx src/connectors/calendly/folder-parity.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CalendlyConnector } from "./connector";
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
  normalizePayloadKeys,
  resolveSourceTimestamp,
} from "../../sync-cdc/normalization";
import {
  CASSETTE_DIR,
  FOLDER,
  RATE_LIMIT_ENTITIES,
  RATE_LIMIT_SCENARIO,
  checkParity,
  compareEntitySchema,
  compareForm,
  compareRuns,
  ensureFolderInstalled,
  formatReport,
  inProcessFactory,
  runFolderCommand,
  runParity,
  startReplayServer,
  webhookParity,
  type ReplayServer,
} from "../../../../connectors/calendly/fixtures/harness.mjs";
import { buildWebhookEvents } from "../../../../connectors/calendly/fixtures/webhook-events.mjs";

const makeInProcess = inProcessFactory({ CalendlyConnector });
const ENTITIES: string[] = makeInProcess({
  access_token: "cal_test_list",
}).getAvailableEntities();

/**
 * The Calendly folder as a workspace connector, with the box swapped for a
 * local process running the same SDK runner on the same files. Everything
 * else is `SandboxedConnector` as production runs it: `since` in
 * `state.mako`, the page size and rate limit in the config, the chunk byte
 * budget, the schema translation and the source timestamp.
 */
class BoxlessCalendly extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "calendly",
      runtime: "node",
      entry: "connector.ts",
      sha: "parity",
      sourceSha: "parity",
      spec: BoxlessCalendly.spec,
      entities: Object.keys(BoxlessCalendly.spec?.mako?.entities ?? {}),
      status: "indexed",
    } as LoadedConnector;
    return this.loaded;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    const result = await runFolderCommand(command, options);
    return {
      exitCode: result.code ?? 1,
      messages: result.messages as RunResult["messages"],
      malformed: [],
      stderr: result.stderr,
      timedOut: false,
    };
  }
}

const makeBoxed = (config: { access_token: string; api_base_url: string }) =>
  new BoxlessCalendly({
    id: "ds_parity",
    name: "Calendly parity",
    type: "ws:calendly",
    workspaceId: "ws_parity",
    config,
  } as any);

let boxed: BoxlessCalendly;
const sourceTs = {
  inProcess: (row: Record<string, unknown>, entity: string) => [
    resolveSourceTimestamp(normalizePayloadKeys(row)).toISOString(),
    makeInProcess({ access_token: "cal_test_ts" })
      .normalizeBackfillRecord(entity, row)
      ?.sourceTs.toISOString(),
  ],
  folder: (row: Record<string, unknown>, entity: string) => [
    resolveSourceTimestamp(normalizePayloadKeys(row)).toISOString(),
    boxed.normalizeBackfillRecord(entity, row)?.sourceTs.toISOString(),
  ],
};

let server: ReplayServer;
let streams: Array<Record<string, any>> = [];
let spec: Record<string, any> | undefined;

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  const discover = await runFolderCommand("discover", {
    config: { access_token: "cal_test_schema" },
  });
  streams =
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  BoxlessCalendly.spec = spec;
  boxed = makeBoxed({
    access_token: "cal_test_schema",
    api_base_url: server.url,
  });
  await boxed.resolveSchema("invitees");
});

after(async () => {
  await server?.close();
});

void test("connector.yaml is a node folder with its entry", () => {
  const parsed = parseConnectorFile(
    fs.readFileSync(path.join(FOLDER, "connector.yaml"), "utf8"),
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.equal(parsed.value.runtime, "node");
  assert.equal(parsed.value.entry, "connector.ts");
});

void test("same 7 entities in the same order, labels, descriptions and credential form", () => {
  assert.equal(ENTITIES.length, 7);
  assert.deepEqual(
    streams.map(s => s.name),
    ENTITIES,
  );
  const metadata = makeInProcess({
    access_token: "cal_test_list",
  }).getEntityMetadata();
  for (const { name, label, description } of metadata) {
    assert.equal(spec?.mako?.entities?.[name]?.label, label, name);
    assert.equal(spec?.mako?.entities?.[name]?.description, description, name);
  }
  const form = compareForm(
    CalendlyConnector.getConfigSchema().fields,
    connectionSpecificationToForm(spec?.connectionSpecification).fields,
  );
  assert.ok(form.ok, JSON.stringify(form, null, 2));
});

void test("same columns, types, nullability and key for every entity", async () => {
  const system = new Set(Object.keys(MAKO_SYSTEM_FIELDS));
  for (const entity of ENTITIES) {
    const inProcess = await makeInProcess({
      access_token: "cal_test_list",
    }).resolveSchema(entity);
    const result = compareEntitySchema(
      inProcess,
      jsonSchemaToEntitySchema(
        entity,
        streams.find(s => s.name === entity),
      ),
      system,
    );
    assert.ok(result.ok, `${entity}: ${JSON.stringify(result)}`);
    // And through the adapter the engine calls, system columns included.
    const viaBox = compareEntitySchema(
      inProcess,
      await boxed.resolveSchema(entity),
    );
    assert.ok(viaBox.ok, `${entity} via the box: ${JSON.stringify(viaBox)}`);
  }
});

void test("same table layout and incremental mode for every entity", async () => {
  const inProcess = makeInProcess({ access_token: "cal_test_list" });
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

void test("check agrees on a valid token and on a revoked one", async () => {
  const outcomes = await checkParity({ makeInProcess, server });
  assert.deepEqual(
    outcomes.map(o => [o.variant, o.inProcess, o.folder, o.requestsEqual]),
    [
      ["valid", true, true, true],
      ["revoked", false, false, true],
    ],
  );
});

void test("the token is never sent to a host other than Calendly or loopback", async () => {
  for (const [baseUrl, message] of [
    ["https://attacker.example", /must be https:\/\/api\.calendly\.com/],
    ["http://api.calendly.com", /must be https:\/\/api\.calendly\.com/],
    ["not a url", /not a URL/],
  ] as const) {
    const run = await runFolderCommand("check", {
      config: { access_token: "cal_test_host", api_base_url: baseUrl },
    });
    const status = run.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    assert.equal(status?.status, "FAILED", baseUrl);
    assert.match(String(status?.message), message, baseUrl);
  }
  assert.deepEqual(server.requests("cal_test_host"), []);
});

void test("every entity reads the same rows, timestamps, chunks and requests", async () => {
  const results = await runParity({
    entities: ENTITIES,
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
  assert.equal(all.length, ENTITIES.length * 4 + RATE_LIMIT_ENTITIES.length);
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
  // 210 events, 3 pages of 100: invitees walk the start-time keyset across
  // a page boundary that 7 events share, and read no invitee twice.
  const invitees = find("default", "invitees");
  assert.deepEqual(invitees.rows, [477, 477]);
  assert.deepEqual(invitees.duplicates, [0, 0]);
  assert.equal(invitees.requestOrder, "sorted");
  // One page per chunk: every events page and every wave ends a chunk.
  assert.equal(find("chunked", "invitees").chunks[0], 28);
  // Two rows a page: 105 one-page chunks of scheduled events.
  assert.deepEqual(find("small-pages", "scheduled_events").chunks, [105, 105]);
  // Incremental reads fewer rows, and drops undated rows where it filters.
  assert.ok(find("since", "invitees").rows[0] < invitees.rows[0]);
  assert.deepEqual(find("since", "groups").rows, [1, 1]);
  assert.deepEqual(find("since", "contacts").rows, [3, 3]);
  // Every request was answered 429 once and retried, on both sides.
  const rateLimited = find("rate-limited", "users");
  assert.equal(
    rateLimited.requests[0],
    2 * find("default", "users").requests[0],
  );
});

void test("webhooks: same events, entity selections and change records", async () => {
  const connector = makeInProcess({ access_token: "cal_test_list" });
  const result = await webhookParity({
    connector,
    events: buildWebhookEvents(),
  });
  assert.ok(result.eventsSame);
  assert.equal(result.eventCount, 5);
  assert.ok(result.perEntity.every(p => p.same));
  assert.deepEqual(
    result.outcomes.filter(o => !o.same).map(o => o.eventType),
    [],
  );
  const counts = result.outcomes.reduce<Record<string, number>>(
    (acc, o) => ({ ...acc, [o.outcome]: (acc[o.outcome] ?? 0) + 1 }),
    {},
  );
  assert.deepEqual(counts, { records: 6, unmapped: 1, extract_failed: 2 });
  // Invitee events carry their scheduled event: 4 invitees, 3 events, 2 types.
  assert.equal(
    result.outcomes.reduce((sum, o) => sum + o.records, 0),
    9,
  );
});

void test("the folder declares Calendly's signature scheme and delivery ids", () => {
  assert.deepEqual(spec?.mako?.webhooks, {
    verification: {
      scheme: "hmac-sha256",
      secretEncoding: "utf8",
      signedPayload: ["param:t", "literal:.", "body"],
      signatureHeader: "calendly-webhook-signature",
      signatureEncoding: "hex",
      signatureParam: "v1",
      timestampParam: "t",
      toleranceSeconds: 180,
    },
    delivery: { idFields: ["created_at", "payload.uri"], typeField: "event" },
    events: makeInProcess({
      access_token: "cal_test_list",
    }).getSupportedWebhookEvents(),
  });
});

void test("the comparison catches a changed field, a lost row and another request", () => {
  const rows = [
    { id: "a", updated_at: "2026-01-01T00:00:00Z", n: 1 },
    { id: "b", updated_at: "2026-01-02T00:00:00Z", n: 2 },
  ];
  const base = {
    rows,
    chunks: [{ position: { cursor: null }, hasMore: false }],
    requests: ["GET /groups?count=100"],
  };
  const ts = {
    inProcess: (row: Record<string, unknown>) => row.updated_at,
    folder: (row: Record<string, unknown>) => row.updated_at,
  };
  assert.ok(compareRuns(base, structuredClone(base), ts, "groups").ok);

  const changed = structuredClone(base);
  changed.rows[1].n = 3;
  assert.deepEqual(
    compareRuns(base, changed, ts, "groups").checksumMismatches,
    ["b"],
  );

  const moved = structuredClone(base);
  moved.rows[1].updated_at = "2026-01-03T00:00:00Z";
  assert.deepEqual(compareRuns(base, moved, ts, "groups").timestampMismatches, [
    "b",
  ]);

  const lost = { ...structuredClone(base), rows: [rows[0]] };
  assert.equal(compareRuns(base, lost, ts, "groups").keys, false);

  const other = {
    ...structuredClone(base),
    requests: ["GET /groups?count=20"],
  };
  assert.equal(compareRuns(base, other, ts, "groups").requestsEqual, false);
  // Sorted for invitees, but still the same requests and count.
  const twice = {
    ...structuredClone(base),
    requests: ["GET /groups?count=100", "GET /groups?count=100"],
  };
  assert.equal(compareRuns(base, twice, ts, "invitees").requestsEqual, false);
});

void test("the cassettes walk the error path: an event whose invitees answer 404", () => {
  const read = (file: string) =>
    fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
  assert.match(read("invitees.json"), /"status":404/);
});

void test("the cassettes hold no token and no real address", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /cal_test_|Bearer|signing_key/, file);
    for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) {
      assert.match(email, /@example\.com$/, `${file}: ${email}`);
    }
  }
});
