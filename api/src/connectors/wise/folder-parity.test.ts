/**
 * Parity between this in-process Wise connector and its port to a connector
 * folder (`connectors/wise/`, RFC connector-runtime iteration 5).
 *
 * Both run against the same recorded Wise responses, served locally. Every
 * entity is read in four scenarios (one page per chunk, two rows a page, the
 * default chunk, incremental `since`) and three in a fifth where every
 * request is first answered 429. Runs are compared on row count, keys,
 * order, columns, a checksum per row, each row's source timestamp, the chunk
 * positions and the exact requests sent, SCA challenges included. Schemas,
 * the credential form, `check` and the webhook mapping are compared too.
 *
 * The folder runs through `SandboxedConnector`, the adapter the box path
 * uses, with only the box replaced by a local process (`BoxlessWise`).
 * Nothing here starts a box or calls Wise. The harness lives with the
 * folder: connectors/wise/fixtures/harness.mjs. Re-record or print the
 * tables with connectors/wise/fixtures/parity.mjs.
 *
 * Run: TZ=UTC node --import tsx src/connectors/wise/folder-parity.test.ts
 */
// The box path reads a transfer's zone-less `created` in the process's
// local zone; in-process reads it as UTC. Production runs in UTC. See the
// README's "What differs".
process.env.TZ = "UTC";

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WiseConnector } from "./connector";
import { verifyWiseWebhook } from "./webhooks";
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
  CASSETTE_DIR,
  FOLDER,
  RATE_LIMIT_ENTITIES,
  RATE_LIMIT_SCENARIO,
  SCA_TEST_KEYS,
  checkParity,
  compareEntitySchema,
  compareForm,
  compareRuns,
  ensureFolderInstalled,
  formatReport,
  freezeClock,
  inProcessFactory,
  readInProcess,
  runFolderCommand,
  runParity,
  startReplayServer,
  testConfig,
  webhookParity,
  type ReplayServer,
  type WiseTestConfig,
} from "../../../../connectors/wise/fixtures/harness.mjs";
import {
  TEST_WEBHOOK_KEYS,
  buildDeliveries,
  buildWebhookEvents,
} from "../../../../connectors/wise/fixtures/webhook-events.mjs";

const makeInProcess = inProcessFactory({ WiseConnector });
const ENTITIES: string[] = makeInProcess({
  api_key: "wise_test_list",
  api_base_url: "http://127.0.0.1:1",
}).getAvailableEntities();

/**
 * The Wise folder as a workspace connector, with the box swapped for a
 * local process running the same SDK runner on the same files. Everything
 * else is `SandboxedConnector` as production runs it: `since` in
 * `state.mako`, the page size and rate limit in the config, the chunk
 * budget, the schema translation and the source timestamp.
 */
class BoxlessWise extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "wise",
      runtime: "node",
      entry: "connector.ts",
      sha: "parity",
      sourceSha: "parity",
      spec: BoxlessWise.spec,
      entities: Object.keys(BoxlessWise.spec?.mako?.entities ?? {}),
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

const makeBoxed = (config: WiseTestConfig) =>
  new BoxlessWise({
    id: "ds_parity",
    name: "Wise parity",
    type: "ws:wise",
    workspaceId: "ws_parity",
    config,
  } as any);

/** A boxed connector with its catalog loaded, for the timestamp resolver. */
let boxed: BoxlessWise;
const iso = (record: { sourceTs?: Date } | null | undefined) =>
  record?.sourceTs?.toISOString();
const sourceTs = {
  inProcess: (entity: string, row: Record<string, unknown>) =>
    iso(
      makeInProcess({
        api_key: "wise_test_ts",
        api_base_url: "http://127.0.0.1:1",
      }).normalizeBackfillRecord(entity, row),
    ),
  folder: (entity: string, row: Record<string, unknown>) =>
    iso(boxed.normalizeBackfillRecord(entity, row)),
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
    config: { api_key: "wise_test_schema" },
  });
  streams =
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  BoxlessWise.spec = spec;
  boxed = makeBoxed(testConfig("wise_test_schema", server));
  await boxed.resolveSchema("transfers");
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

void test("same 7 entities in the same order, labels, descriptions and credential form", () => {
  assert.equal(ENTITIES.length, 7);
  assert.deepEqual(
    streams.map(s => s.name),
    ENTITIES,
  );
  const metadata = makeInProcess({
    api_key: "wise_test_list",
    api_base_url: "http://127.0.0.1:1",
  }).getEntityMetadata();
  for (const { name, label, description } of metadata) {
    assert.equal(spec?.mako?.entities?.[name]?.label, label, name);
    assert.equal(spec?.mako?.entities?.[name]?.description, description, name);
  }
  const folderForm = connectionSpecificationToForm(
    spec?.connectionSpecification,
  ).fields;
  const form = compareForm(WiseConnector.getConfigSchema().fields, folderForm);
  assert.ok(form.ok, JSON.stringify(form, null, 2));
  // The one known difference: the SCA key is encrypted on both sides, but
  // the folder's form renders it as a password field, not a textarea.
  const key = folderForm.find(f => f.name === "sca_private_key");
  assert.equal(key?.type, "password");
  assert.equal(key?.encrypted, true);
});

void test("same columns, types, nullability and key for every entity", async () => {
  const system = new Set(Object.keys(MAKO_SYSTEM_FIELDS));
  for (const entity of ENTITIES) {
    const inProcess = await makeInProcess({
      api_key: "wise_test_schema",
      api_base_url: server.url,
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
  const inProcess = makeInProcess({
    api_key: "wise_test_list",
    api_base_url: "http://127.0.0.1:1",
  });
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
  // `/v1/me` then `/v2/profiles`; a revoked token stops at the first.
  assert.deepEqual(
    outcomes.map(o => o.requests),
    [2, 1],
  );
});

void test("the token is never sent to a host other than Wise or loopback", async () => {
  for (const [baseUrl, message] of [
    ["https://attacker.example", /must be https:\/\/api\.wise\.com/],
    ["http://api.wise.com", /must be https:\/\/api\.wise\.com/],
    ["not a url", /not a URL/],
  ] as const) {
    const run = await runFolderCommand("check", {
      config: { api_key: "wise_test_host", api_base_url: baseUrl },
    });
    const status = run.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    assert.equal(status?.status, "FAILED", baseUrl);
    assert.match(String(status?.message), message, baseUrl);
  }
  assert.deepEqual(server.requests("wise_test_host"), []);
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
  // 203 + 4 transfers, in pages of 100: 3 + 1 requests, 4 one-page chunks.
  assert.deepEqual(find("chunked", "transfers").rows, [207, 207]);
  assert.equal(find("chunked", "transfers").chunks[0], 4);
  // Two rows a page: 102 + 2 transfer pages, plus the profile list.
  assert.equal(find("small-pages", "transfers").chunks[0], 105);
  // `createdDateStart` narrows the transfers.
  assert.ok(
    find("since", "transfers").rows[0] < find("default", "transfers").rows[0],
  );
  // Recipients: Wise caps a page at 20, below the 100 asked for.
  assert.equal(find("default", "recipients").rows[0], 48);
  // Activities: the business profile's echoed cursor ends its walk.
  assert.equal(find("default", "activities").rows[0], 180);
  // Statements: 4 balances with a window, 1 created after now and skipped;
  // the business profile's statements answer an SCA challenge first.
  const statements = find("default", "balance_statements");
  assert.equal(statements.rows[0], 65);
  // Every request was answered 429 once and retried, on both sides.
  assert.equal(
    find("rate-limited", "transfers").requests[0],
    2 * find("default", "transfers").requests[0],
  );
  // Recipients have no time field: both sides fall back to the sync time.
  assert.equal(find("default", "recipients").timestampFallbacks, 48);
});

void test("statements: the signed SCA retry is sent, and refused the same without a key", async () => {
  const keys = (token: string) => server.requests(token);
  const challenge = (requests: string[]) =>
    requests.filter(r => r.includes("[x-2fa-approval ott-")).length;
  const results = await runParity({
    entities: ["balance_statements"],
    makeInProcess,
    makeBoxed,
    server,
    sourceTs,
    scenarios: [{ name: "sca", maxIterations: 10 }],
  });
  assert.ok(results[0].ok, formatReport(results));
  // One signed retry per business-profile window (2 balances with windows).
  assert.ok(challenge(keys("wise_test_inprocess_sca_balance_statements")) > 0);
  assert.equal(
    challenge(keys("wise_test_folder_sca_balance_statements")),
    challenge(keys("wise_test_inprocess_sca_balance_statements")),
  );

  // Without a key both refuse with the same message, after the same requests.
  const noKey = (token: string) => ({
    ...testConfig(token, server),
    sca_private_key: "",
  });
  const inProcess = await readInProcess(
    () => makeInProcess(noKey("wise_test_inprocess_nokey")),
    { entity: "balance_statements", maxIterations: 10 },
  ).catch((error: Error) => error);
  const folder = await readInProcess(
    () => makeBoxed(noKey("wise_test_folder_nokey")),
    { entity: "balance_statements", maxIterations: 10 },
  ).catch((error: Error) => error);
  assert.ok(inProcess instanceof Error && folder instanceof Error);
  assert.match(inProcess.message, /strong customer authentication/);
  assert.ok(
    folder.message.includes(inProcess.message),
    `${folder.message}\nvs\n${inProcess.message}`,
  );
  assert.deepEqual(
    server.requests("wise_test_folder_nokey"),
    server.requests("wise_test_inprocess_nokey"),
  );
  assert.ok(SCA_TEST_KEYS.publicKey.includes("PUBLIC KEY"));
});

void test("webhooks: same events, signature checks and change records", async () => {
  const connector = makeInProcess({
    api_key: "wise_test_list",
    api_base_url: "http://127.0.0.1:1",
  });
  const events = buildWebhookEvents();
  const result = await webhookParity({
    connector,
    events,
    deliveries: buildDeliveries(),
    publicKeys: [TEST_WEBHOOK_KEYS.publicKey],
    inProcessVerify: delivery =>
      verifyWiseWebhook(delivery, () => [TEST_WEBHOOK_KEYS.publicKey]),
  });
  assert.ok(result.eventsSame);
  assert.equal(result.eventCount, 8);
  assert.ok(result.forEntities.every(f => f.same));
  assert.deepEqual(
    result.outcomes.filter(o => !o.same).map(o => o.eventType),
    [],
  );
  assert.deepEqual(
    result.verify.map(v => [v.name, v.inProcess, v.same]),
    [
      ["valid", true, true],
      ["valid, no delivery id", true, true],
      ["tampered body", false, true],
      ["wrong key", false, true],
      ["no signature header", false, true],
      ["signature not base64", false, true],
      ["test notification, unsigned", true, true],
      ["test notification, badly signed, odd case", true, true],
      ["test notification header false, unsigned", false, true],
    ],
  );
  const counts = result.outcomes.reduce<Record<string, number>>(
    (acc, o) => ({ ...acc, [o.outcome]: (acc[o.outcome] ?? 0) + 1 }),
    {},
  );
  assert.deepEqual(counts, { records: 13, unmapped: 2, extract_failed: 2 });
});

void test("the comparison catches a changed field, a lost row and another request", () => {
  const rows = [
    { id: "a", created: "2026-01-01 00:00:00", n: 1 },
    { id: "b", created: "2026-01-02 00:00:00", n: 2 },
  ];
  const base = {
    rows,
    chunks: [{ position: { profileIndex: 1 }, hasMore: false }],
    requests: ["GET /v1/transfers?limit=100&offset=0&profile=1"],
  };
  const ts = {
    inProcess: (_entity: string, row: Record<string, unknown>) => row.created,
    folder: (_entity: string, row: Record<string, unknown>) => row.created,
  };
  assert.ok(compareRuns(base, structuredClone(base), ts, "transfers").ok);

  const changed = structuredClone(base);
  changed.rows[1].n = 3;
  assert.deepEqual(
    compareRuns(base, changed, ts, "transfers").checksumMismatches,
    ["b"],
  );

  const lost = { ...structuredClone(base), rows: [rows[0]] };
  assert.equal(compareRuns(base, lost, ts, "transfers").keys, false);

  const other = {
    ...structuredClone(base),
    requests: ["GET /v1/transfers?limit=100&offset=100&profile=1"],
  };
  assert.equal(compareRuns(base, other, ts, "transfers").requestsEqual, false);

  const moved = structuredClone(base);
  moved.chunks[0].position = { profileIndex: 0 };
  assert.equal(compareRuns(base, moved, ts, "transfers").chunkStates, false);
});

void test("the cassettes hold no token, no key and no real address", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /PRIVATE KEY|Bearer /, file);
    for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) {
      assert.match(email, /@example\.com$/, `${file}: ${email}`);
    }
  }
});
