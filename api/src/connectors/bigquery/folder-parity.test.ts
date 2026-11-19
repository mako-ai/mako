/**
 * Parity between this in-process BigQuery connector and its port to a
 * connector folder (`connectors/bigquery/`, RFC connector-runtime
 * iteration 5).
 *
 * Both run against the same recorded BigQuery responses, served locally,
 * with a service-account key generated for the run. Each of 4 queries
 * (every mapped type with RECORD and REPEATED, a job that needs a poll,
 * legacy SQL, an empty result) is read in 6 scenarios: one page per chunk,
 * two-row pages, the default chunk, a configured location, an ignored
 * `since`, and a 429 then a 503 that fail the chunk and are retried by the
 * engine. Each run compares row count, keys, order, columns, a checksum per
 * row, the chunk positions, the exact requests (the token exchange and the
 * job labels included) and each row's source timestamp. The entity list,
 * the credential form, incremental capabilities and `check` are compared
 * too.
 *
 * The credential test proves the folder authenticates with the
 * connection's service account only: a decoy GOOGLE_APPLICATION_CREDENTIALS
 * in its environment is never read, and the folder's source reads no
 * environment at all.
 *
 * The harness lives with the folder: connectors/bigquery/fixtures/harness.mjs.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BigQueryConnector } from "./connector";
import { SandboxedConnector } from "../workspace/SandboxedConnector";
import type { LoadedConnector } from "../workspace/resolver";
import type { ConnectorCommand, RunResult } from "../workspace/sync-box";
import { parseConnectorFile } from "../workspace/connector-file";
import { specToForm } from "../workspace/spec-translation";
import { LocalSessionTransport } from "../workspace/test-support/local-session";
import { resolveEntitySchema } from "../../sync/sync-orchestrator";
import {
  CASSETTE_DIR,
  CONNECTION_ID,
  CONNECTION_QUERIES,
  FOLDER,
  RUNNER,
  WORKSPACE_ID,
  checkParity,
  compareForm,
  ensureFolderInstalled,
  formatReport,
  runFolderCommand,
  runParity,
  serviceAccountJson,
  startReplayServer,
  testConfig,
  type BigQueryTestConfig,
  type Comparison,
  type ReplayServer,
} from "../../../../connectors/bigquery/fixtures/harness.mjs";

// The harness signs against a local token server. The key validator accepts a
// loopback token_uri only under NODE_ENV=test (src/connections/google-service-account.ts).
process.env.NODE_ENV = "test";

const makeInProcess = (config: Record<string, unknown>) =>
  new BigQueryConnector({
    _id: CONNECTION_ID,
    name: "BigQuery parity",
    type: "bigquery",
    workspaceId: WORKSPACE_ID,
    config,
  } as any);

class BoxlessBigQuery extends SandboxedConnector {
  static spec: Record<string, any> | undefined;
  /** Every config a command was given, to prove what reaches a box. */
  static configs: Array<Record<string, unknown>> = [];

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "bigquery",
      runtime: "node",
      entry: "connector.ts",
      sha: "parity",
      sourceSha: "parity",
      spec: BoxlessBigQuery.spec,
      entities: Object.keys(BoxlessBigQuery.spec?.mako?.entities ?? {}),
      status: "indexed",
    } as LoadedConnector;
    return this.loaded;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    if (options?.config) BoxlessBigQuery.configs.push(options.config);
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

const boxed = <T extends BoxlessBigQuery>(
  Kind: new (source: any) => T,
  config: Record<string, unknown>,
) =>
  new Kind({
    _id: CONNECTION_ID,
    name: "BigQuery parity",
    type: "ws:bigquery",
    workspaceId: WORKSPACE_ID,
    config,
  } as any);
const makeBoxed = (config: BigQueryTestConfig) =>
  boxed(BoxlessBigQuery, config as unknown as Record<string, unknown>);

class SessionBigQuery extends BoxlessBigQuery {
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
      SessionBigQuery.transports.push(this.transport);
    }
    return this.transport;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    if (command === "read") SessionBigQuery.chunkReads++;
    return super.run(command, options);
  }
}

const CONFIG = {
  project_id: "parity-project",
  service_account_json: "{}",
  queries: CONNECTION_QUERIES,
};
const ENTITIES = CONNECTION_QUERIES.map(q => q.name);

let server: ReplayServer;
let spec: Record<string, any> | undefined;

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  BoxlessBigQuery.spec = spec;
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

void test("one entity per connection query, in order, labelled as in-process", async () => {
  const box = makeBoxed(CONFIG as unknown as BigQueryTestConfig);
  await box.loadDefinition();
  const inProcess = makeInProcess(CONFIG);
  assert.deepEqual(
    box.getAvailableEntities(),
    inProcess.getAvailableEntities(),
  );
  assert.deepEqual(box.getAvailableEntities(), ENTITIES);
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(
    plain(box.getEntityMetadata()),
    plain(inProcess.getEntityMetadata()),
  );
  assert.deepEqual(spec?.mako?.entities, {});
  assert.equal(spec?.mako?.queryEntities?.source, "connection");
});

void test("same credential form, but for the legacy-SQL checkbox's type", () => {
  const form = compareForm(
    BigQueryConnector.getConfigSchema().fields,
    specToForm(spec).fields,
  );
  // In-process says `checkbox`, which the app's form does not render; the
  // folder's `boolean` renders as a checkbox.
  assert.deepEqual(form.diffs, [
    'queries.use_legacy_sql.type: "checkbox" vs "boolean"',
  ]);
  const fields = specToForm(spec).fields;
  const sa = fields.find(f => f.name === "service_account_json");
  assert.equal(sa?.type, "textarea");
  assert.equal(sa?.encrypted, true);
  assert.equal(fields.find(f => f.name === "queries")?.type, "object_array");
  assert.equal(specToForm(spec).transferQueries, undefined);
});

void test("no incremental on either side", async () => {
  const box = makeBoxed(CONFIG as unknown as BigQueryTestConfig);
  await box.loadDefinition();
  const inCaps = makeInProcess(CONFIG).getIncrementalCapabilities();
  const boxCaps = box.getIncrementalCapabilities();
  assert.equal(boxCaps.supported, inCaps.supported);
  assert.equal(boxCaps.mode, inCaps.mode);
});

void test("no schema on either side: rows land as they come", async () => {
  const box = makeBoxed(CONFIG as unknown as BigQueryTestConfig);
  await box.loadDefinition();
  for (const entity of ENTITIES) {
    assert.equal(await makeInProcess(CONFIG).resolveSchema(entity), null);
    assert.equal(await box.resolveSchema(entity), null, entity);
    assert.equal(
      await resolveEntitySchema({
        entity,
        workspaceId: WORKSPACE_ID,
        connector: box,
        sourceConnection: { type: "ws:bigquery" },
        context: "parity",
      }),
      null,
    );
  }
});

void test("check agrees on a valid, revoked and denied key, bad JSON and no query", async () => {
  const outcomes = await checkParity({ makeInProcess, server });
  assert.deepEqual(
    outcomes.map(o => [
      o.variant,
      o.inProcess,
      o.folder,
      o.requests,
      o.requestsEqual,
    ]),
    [
      ["valid", true, true, 2, true],
      ["revoked", false, false, 1, true],
      ["denied", false, false, 2, true],
      ["bad-json", false, false, 0, true],
      ["no-queries", false, false, 0, true],
    ],
  );
});

void test("only the connection's service account reaches Google", async () => {
  // A decoy ambient credential: a service account of another identity.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-bq-ambient-"));
  const decoy = path.join(dir, "adc.json");
  fs.writeFileSync(
    decoy,
    serviceAccountJson("ambient-decoy", server).replace(
      "parity-project.iam",
      "other-project.iam",
    ),
  );
  try {
    const run = "folder-ambient-check";
    const result = await runFolderCommand("check", {
      config: {
        ...testConfig(run, server),
        __connection_id: CONNECTION_ID,
        __workspace_id: WORKSPACE_ID,
      },
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: decoy,
        GCE_METADATA_HOST: new URL(server.url).host,
        CLOUDSDK_CONFIG: dir,
      },
    });
    const status = result.messages.find(m => m.type === "CONNECTION_STATUS");
    assert.equal(status?.connectionStatus?.status, "SUCCEEDED");
    const requests = server.requests(run);
    assert.equal(requests.length, 2);
    assert.match(
      requests[0],
      /^POST \/token jwt iss=folder-ambient-check@parity-project\.iam\.gserviceaccount\.com scope=https:\/\/www\.googleapis\.com\/auth\/bigquery\.readonly /,
    );
    assert.deepEqual(server.requests("ambient-decoy"), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The folder reads no environment and no Google client library.
  for (const file of ["connector.ts", "client.ts"]) {
    const source = fs.readFileSync(path.join(FOLDER, file), "utf8");
    assert.doesNotMatch(source, /process\.env|google-auth|@google-cloud/, file);
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.join(FOLDER, "package.json"), "utf8"),
  );
  assert.equal(pkg.dependencies, undefined);
});

void test("a box gets the connection's config and its ids, nothing else", async () => {
  BoxlessBigQuery.configs = [];
  const box = makeBoxed(testConfig("folder-config-keys", server));
  await box.testConnection();
  await box.fetchEntityChunk({
    entity: "empty",
    maxIterations: 1,
    onBatch: async () => {},
  } as any);
  const keys = new Set(BoxlessBigQuery.configs.flatMap(c => Object.keys(c)));
  assert.deepEqual([...keys].sort(), [
    "__connection_id",
    "__workspace_id",
    "api_base_url",
    "project_id",
    "queries",
    "service_account_json",
  ]);
});

function assertTimestamps(results: Comparison[]) {
  const checked = results.reduce((n, r) => n + r.timestampsChecked, 0);
  const rowsRead = results.reduce((n, r) => n + r.rows[0], 0);
  assert.equal(checked, rowsRead);
  assert.ok(checked > 0);
  for (const r of results) {
    assert.deepEqual(r.timestampMismatches, [], `${r.scenario}/${r.entity}`);
  }
}

void test("every query reads the same rows, chunks, requests and timestamps", async () => {
  const results = await runParity({
    entities: ENTITIES,
    makeInProcess,
    makeBoxed,
    server,
  });
  const report = formatReport(results);
  assert.equal(results.length, ENTITIES.length * 6);
  assert.deepEqual(
    results.filter(r => !r.ok).map(r => `${r.scenario}/${r.entity}`),
    [],
    report,
  );
  assert.deepEqual(server.misses, []);
  assertTimestamps(results);
  const run = (scenario: string, entity: string): Comparison => {
    const found = results.find(
      r => r.scenario === scenario && r.entity === entity,
    );
    assert.ok(found, `${scenario}/${entity}`);
    return found;
  };
  assert.equal(run("default", "events").rows[0], 25);
  assert.equal(run("chunked", "events").chunks[0], 3);
  assert.equal(run("small-pages", "slow_job").chunks[0], 3);
  assert.equal(run("chunked", "legacy_sessions").chunks[0], 3);
  // A failed chunk is run again from its state: more requests, same rows.
  for (const entity of ENTITIES) {
    assert.ok(
      run("rate-limited", entity).requests[0] >
        run("chunked", entity).requests[0],
      entity,
    );
  }
});

void test("a read session reads the same rows, chunks, requests and timestamps", async () => {
  const own = await startReplayServer();
  try {
    const results = await runParity({
      entities: ENTITIES,
      makeInProcess,
      makeBoxed: config =>
        boxed(SessionBigQuery, config as unknown as Record<string, unknown>),
      server: own,
    });
    assert.deepEqual(
      results.filter(r => !r.ok).map(r => `${r.scenario}/${r.entity}`),
      [],
      formatReport(results),
    );
    assert.deepEqual(own.misses, []);
    assertTimestamps(results);
    assert.equal(SessionBigQuery.chunkReads, 0);
  } finally {
    await own.close();
  }
});

void test("the cassettes hold no token and no key", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /ya29\.|PRIVATE KEY|assertion=/, file);
  }
});
