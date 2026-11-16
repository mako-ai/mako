/**
 * Parity between this in-process Close connector and its port to a connector
 * folder (`connectors/close/`, RFC connector-runtime iteration 5).
 *
 * Both run against the same recorded Close responses, served locally. Every
 * entity is read in four scenarios (one page per chunk, two rows a page, the
 * default chunk, incremental `since`) and three in a fifth where every
 * request is first answered 429. Runs are compared on row count, keys,
 * order, columns, a checksum per row, each row's source timestamp, the chunk
 * positions and the exact requests sent. Schemas, the credential form,
 * `check` and the webhook mapping are compared too.
 *
 * The folder runs through `SandboxedConnector`, the adapter the box path
 * uses, with only the box replaced by a local process (`BoxlessClose`).
 * Nothing here starts a box or calls Close. The harness lives with the
 * folder: connectors/close/fixtures/harness.mjs. Re-record or print the
 * tables with connectors/close/fixtures/parity.mjs.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CloseConnector } from "./connector";
import { createCloseClient } from "./client";
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
  freezeClock,
  inProcessFactory,
  runFolderCommand,
  runParity,
  startReplayServer,
  webhookParity,
  type ReplayServer,
} from "../../../../connectors/close/fixtures/harness.mjs";
import {
  buildDeliveries,
  buildWebhookEvents,
} from "../../../../connectors/close/fixtures/webhook-events.mjs";

const makeInProcess = inProcessFactory({ CloseConnector, createCloseClient });
const ENTITIES: string[] = makeInProcess({
  api_key: "api_test_list",
}).getAvailableEntities();

/**
 * The Close folder as a workspace connector, with the box swapped for a
 * local process running the same SDK runner on the same files. Everything
 * else is `SandboxedConnector` as production runs it: `since` in
 * `state.mako`, the page size and rate limit in the config, the 16 MiB chunk
 * budget, the schema translation and the source timestamp.
 */
class BoxlessClose extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "close",
      runtime: "node",
      entry: "connector.ts",
      sha: "parity",
      sourceSha: "parity",
      spec: BoxlessClose.spec,
      entities: Object.keys(BoxlessClose.spec?.mako?.entities ?? {}),
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

const makeBoxed = (config: { api_key: string; __base_url: string }) =>
  new BoxlessClose({
    id: "ds_parity",
    name: "Close parity",
    type: "ws:close",
    workspaceId: "ws_parity",
    config,
  } as any);

/** A boxed connector with its catalog loaded, for the timestamp resolver. */
let boxed: BoxlessClose;
const sourceTs = {
  inProcess: (row: Record<string, unknown>) => [
    resolveSourceTimestamp(normalizePayloadKeys(row)).toISOString(),
    makeInProcess({ api_key: "api_test_ts" })
      .normalizeBackfillRecord("leads", row)
      ?.sourceTs.toISOString(),
  ],
  folder: (row: Record<string, unknown>) => [
    resolveSourceTimestamp(normalizePayloadKeys(row)).toISOString(),
    boxed.normalizeBackfillRecord("leads", row)?.sourceTs.toISOString(),
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
    config: { api_key: "api_test_schema", __base_url: server.url },
  });
  streams =
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  BoxlessClose.spec = spec;
  boxed = makeBoxed({ api_key: "api_test_schema", __base_url: server.url });
  await boxed.resolveSchema("leads");
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

void test("same 22 entities in the same order, labels and credential form", () => {
  assert.equal(ENTITIES.length, 22);
  assert.deepEqual(
    streams.map(s => s.name),
    ENTITIES,
  );
  const metadata = makeInProcess({
    api_key: "api_test_list",
  }).getEntityMetadata() as Array<{
    name: string;
    label: string;
    subEntities?: Array<{ name: string; label: string }>;
  }>;
  for (const { name, label, subEntities } of metadata) {
    if (subEntities) {
      for (const sub of subEntities) {
        assert.equal(
          spec?.mako?.entities?.[`${name}:${sub.name}`]?.label,
          sub.label,
        );
      }
    } else {
      assert.equal(spec?.mako?.entities?.[name]?.label, label, name);
    }
  }
  const form = compareForm(
    CloseConnector.getConfigSchema().fields,
    connectionSpecificationToForm(spec?.connectionSpecification).fields,
  );
  assert.ok(form.ok, JSON.stringify(form, null, 2));
});

void test("same vendor and custom-field columns for every entity", async () => {
  const system = new Set(Object.keys(MAKO_SYSTEM_FIELDS));
  for (const entity of ENTITIES) {
    const inProcess = await makeInProcess({
      api_key: `api_test_schema_${entity.replace(/[^a-zA-Z0-9_]/g, "-")}`,
      baseUrl: server.url,
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
  // The custom fields come from the account on both sides.
  const leads = jsonSchemaToEntitySchema(
    "leads",
    streams.find(s => s.name === "leads"),
  );
  assert.equal(
    Object.keys(leads.fields).filter(f => f.startsWith("custom_cf_")).length,
    70,
  );
});

void test("same table layout and incremental mode for every entity", async () => {
  const inProcess = makeInProcess({ api_key: "api_test_list" });
  await boxed.loadDefinition();
  const layouts = (c: { getEntityMetadata(): any[] }) => {
    const out: Record<string, unknown> = {};
    for (const e of c.getEntityMetadata()) {
      out[e.name] = e.layoutSuggestion ?? null;
      for (const sub of e.subEntities ?? []) {
        out[`${e.name}:${sub.name}`] = e.layoutSuggestion ?? null;
      }
    }
    return out;
  };
  const inLayouts = layouts(inProcess);
  const boxLayouts = layouts(boxed);
  for (const entity of ENTITIES) {
    assert.deepEqual(boxLayouts[entity], inLayouts[entity], entity);
  }
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

void test("the key is never sent to a host other than Close or loopback", async () => {
  for (const [baseUrl, message] of [
    ["https://attacker.example/api/v1", /must be https:\/\/api\.close\.com/],
    ["http://api.close.com/api/v1", /must be https:\/\/api\.close\.com/],
    ["not a url", /not a URL/],
  ] as const) {
    const run = await runFolderCommand("check", {
      config: { api_key: "api_test_host", __base_url: baseUrl },
    });
    const status = run.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    assert.equal(status?.status, "FAILED", baseUrl);
    assert.match(String(status?.message), message, baseUrl);
  }
  assert.deepEqual(server.requests("api_test_host"), []);
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
  // A 7-day window spans 2 Search pages.
  assert.ok(find("chunked", "leads").stats.maxChunkRows === 200);
  // The cursor limit was hit: the restart re-reads the row it stopped on.
  assert.equal(find("default", "activities:Call").rows[0], 231);
  // The incremental walk reads fewer rows than the full one.
  assert.ok(find("since", "leads").rows[0] < find("default", "leads").rows[0]);
  // Every request was answered 429 once and retried, on both sides.
  const rateLimited = find("rate-limited", "users");
  assert.equal(
    rateLimited.requests[0],
    2 * find("default", "users").requests[0],
  );
  // Two rows a page: the offset lists resume from an offset.
  assert.equal(find("small-pages", "users").chunks[0], 4);
  // Rows without a time field fall back to the sync time on both sides.
  assert.equal(find("default", "lead_statuses").timestampFallbacks, 6);
});

void test("webhooks: same events, signatures and change records", async () => {
  const connector = makeInProcess({ api_key: "api_test_list" });
  const events = buildWebhookEvents(connector.getSupportedWebhookEvents());
  const result = await webhookParity({
    connector,
    events,
    deliveries: buildDeliveries(events[0].rawPayload),
  });
  assert.ok(result.eventsSame);
  assert.equal(result.eventCount, 86);
  assert.deepEqual(
    result.outcomes.filter(o => !o.same).map(o => o.eventType),
    [],
  );
  assert.deepEqual(
    result.verify.map(v => [v.name, v.inProcess, v.same]),
    [
      ["valid", true, true],
      ["tampered body", false, true],
      ["wrong key", false, true],
      ["no hash header", false, true],
      ["no timestamp header", false, true],
      ["no secret", false, true],
    ],
  );
  const counts = result.outcomes.reduce<Record<string, number>>(
    (acc, o) => ({ ...acc, [o.outcome]: (acc[o.outcome] ?? 0) + 1 }),
    {},
  );
  assert.deepEqual(counts, { records: 93, extract_failed: 1, unmapped: 1 });
});

void test("the comparison catches a changed field, a lost row and another request", () => {
  const rows = [
    { id: "a", date_updated: "2026-01-01T00:00:00Z", n: 1 },
    { id: "b", date_updated: "2026-01-02T00:00:00Z", n: 2 },
  ];
  const base = {
    rows,
    chunks: [{ position: { offset: 0 }, hasMore: false }],
    requests: ["GET /user/?_limit=100&_skip=0"],
  };
  const ts = {
    inProcess: (row: Record<string, unknown>) => row.date_updated,
    folder: (row: Record<string, unknown>) => row.date_updated,
  };
  assert.ok(compareRuns(base, structuredClone(base), ts).ok);

  const changed = structuredClone(base);
  changed.rows[1].n = 3;
  assert.deepEqual(compareRuns(base, changed, ts).checksumMismatches, ["b"]);

  const moved = structuredClone(base);
  moved.rows[1].date_updated = "2026-01-03T00:00:00Z";
  assert.deepEqual(compareRuns(base, moved, ts).timestampMismatches, ["b"]);

  const lost = { ...structuredClone(base), rows: [rows[0]] };
  assert.equal(compareRuns(base, lost, ts).keys, false);

  const other = {
    ...structuredClone(base),
    requests: ["GET /user/?_limit=100&_order_by=id&_skip=0"],
  };
  assert.equal(compareRuns(base, other, ts).requestsEqual, false);
});

void test("the cassettes walk the error paths: a cursor limit and a refused selection", () => {
  const read = (file: string) =>
    fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
  assert.match(read("activities_Call.json"), /"field-errors":\{"cursor"/);
  assert.match(read("leads.json"), /"field-errors":\{"_fields"/);
});

void test("the cassettes hold no key, no signing key and no real address", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /api_[A-Za-z0-9]{20,}|signature_key/, file);
    for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) {
      assert.match(email, /@example\.com$/, `${file}: ${email}`);
    }
  }
});
