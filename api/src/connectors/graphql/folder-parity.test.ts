/**
 * Parity between this in-process GraphQL connector and its port to a
 * connector folder (`connectors/graphql/`, RFC connector-runtime iteration
 * 5).
 *
 * Both run against the same recorded GraphQL responses, served locally.
 * Each of 5 flow queries (Hasura aggregates with an Int and a timestamptz
 * cursor, an offset list with `$since`, a Relay connection, an Expo Observe
 * time series) is read in 6 scenarios: one request per chunk, two-row
 * pages, the default chunk, incremental `since`, Hasura's admin-secret
 * header, and a 429 then a 503 before the first page. Each run compares row
 * count, keys, order, columns, a checksum per row, the chunk positions, the
 * exact requests sent (retries included) and each row's source timestamp.
 * The entity list, the credential form, the flow's query form, incremental
 * capabilities and `check` are compared too.
 *
 * The folder runs through `SandboxedConnector`, with only the box replaced
 * by a local process (`BoxlessGraphql`), and again through a read session.
 *
 * The harness lives with the folder: connectors/graphql/fixtures/harness.mjs.
 * Re-record or print the table with connectors/graphql/fixtures/parity.mjs.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GraphQLConnector } from "./connector";
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
  FLOW_QUERIES,
  FOLDER,
  RUNNER,
  WORKSPACE_ID,
  checkParity,
  compareForm,
  compareRuns,
  ensureFolderInstalled,
  formatReport,
  liftSsrfGuard,
  runFolderCommand,
  runParity,
  startReplayServer,
  type Comparison,
  type GraphqlTestConfig,
  type ReplayServer,
} from "../../../../connectors/graphql/fixtures/harness.mjs";

const makeInProcess = (config: Record<string, unknown>) =>
  liftSsrfGuard(
    new GraphQLConnector({
      _id: CONNECTION_ID,
      name: "GraphQL parity",
      type: "graphql",
      workspaceId: WORKSPACE_ID,
      config,
    } as any),
  );

/** The folder as a workspace connector; only the box is a local process. */
class BoxlessGraphql extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "graphql",
      runtime: "node",
      entry: "connector.ts",
      sha: "parity",
      sourceSha: "parity",
      spec: BoxlessGraphql.spec,
      entities: Object.keys(BoxlessGraphql.spec?.mako?.entities ?? {}),
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

const boxed = <T extends BoxlessGraphql>(
  Kind: new (source: any) => T,
  config: Record<string, unknown>,
) => {
  const connector = new Kind({
    _id: CONNECTION_ID,
    name: "GraphQL parity",
    type: "ws:graphql",
    workspaceId: WORKSPACE_ID,
    config,
  } as any);
  // As the registry hands one out: the index row loaded.
  void connector.loadDefinition();
  return connector;
};
const makeBoxed = (config: GraphqlTestConfig) =>
  boxed(BoxlessGraphql, config as unknown as Record<string, unknown>);

/** Through a read session; a `read` reaching a chunk process is counted. */
class SessionGraphql extends BoxlessGraphql {
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
      SessionGraphql.transports.push(this.transport);
    }
    return this.transport;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    if (command === "read") SessionGraphql.chunkReads++;
    return super.run(command, options);
  }
}

const CONFIG = {
  endpoint: "https://api.example.test/graphql",
  headers: "{}",
  queries: FLOW_QUERIES,
};
const ENTITIES = FLOW_QUERIES.map(q => q.name);

let server: ReplayServer;
let spec: Record<string, any> | undefined;

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  BoxlessGraphql.spec = spec;
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

void test("one entity per flow query, in the flow's order, labelled as in-process", async () => {
  const inProcess = makeInProcess(CONFIG);
  const box = makeBoxed(CONFIG as GraphqlTestConfig);
  await box.loadDefinition();
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
  // A connection with no flow queries offers no entity, on both sides.
  const bare = boxed(BoxlessGraphql, { endpoint: CONFIG.endpoint });
  await bare.loadDefinition();
  assert.deepEqual(bare.getAvailableEntities(), []);
  assert.deepEqual(
    makeInProcess({ endpoint: CONFIG.endpoint }).getAvailableEntities(),
    [],
  );
  // The spec declares no fixed entity: the index holds none.
  assert.deepEqual(spec?.mako?.entities, {});
  assert.equal(spec?.mako?.queryEntities?.source, "flow");
});

void test("same credential form and the same flow query form", () => {
  const inProcess = GraphQLConnector.getConfigSchema();
  const folder = specToForm(spec);
  const form = compareForm(inProcess.fields, folder.fields);
  assert.ok(form.ok, JSON.stringify(form, null, 2));
  const headers = folder.fields.find(f => f.name === "headers");
  assert.equal(headers?.type, "textarea");
  assert.equal(headers?.encrypted, true);
  assert.equal(folder.transferQueries?.label, inProcess.transferQueries.label);
  assert.equal(
    folder.transferQueries?.required,
    inProcess.transferQueries.required,
  );
  const queries = compareForm(
    inProcess.transferQueries.fields,
    folder.transferQueries?.fields,
  );
  assert.ok(queries.ok, JSON.stringify(queries, null, 2));
});

void test("same incremental capability: a client filter, before any query exists", async () => {
  const bare = boxed(BoxlessGraphql, { endpoint: CONFIG.endpoint });
  await bare.loadDefinition();
  const inCaps = makeInProcess({
    endpoint: CONFIG.endpoint,
  }).getIncrementalCapabilities();
  assert.equal(bare.getIncrementalCapabilities().supported, inCaps.supported);
  assert.equal(bare.getIncrementalCapabilities().mode, inCaps.mode);
  const box = makeBoxed(CONFIG as GraphqlTestConfig);
  await box.loadDefinition();
  for (const entity of ENTITIES) {
    assert.equal(
      box.getIncrementalCapabilities().perEntity?.[entity]?.mode,
      "client-filter",
    );
  }
});

void test("no schema on either side: rows land as they come, typed by the destination", async () => {
  const box = makeBoxed(CONFIG as GraphqlTestConfig);
  await box.loadDefinition();
  for (const entity of ENTITIES) {
    assert.equal(await makeInProcess(CONFIG).resolveSchema(entity), null);
    assert.equal(await box.resolveSchema(entity), null, entity);
    assert.equal(await box.declaresUntypedSchema(entity), true, entity);
    // The engine accepts the null: the catalog says the stream is untyped.
    assert.equal(
      await resolveEntitySchema({
        entity,
        workspaceId: WORKSPACE_ID,
        connector: box,
        sourceConnection: { type: "ws:graphql" },
        context: "parity",
      }),
      null,
    );
  }
});

void test("check agrees on a valid endpoint, GraphQL errors, a 401 and bad headers", async () => {
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
      ["valid", true, true, 1, true],
      ["errors", false, false, 1, true],
      ["revoked", false, false, 1, true],
      ["bad-headers", false, false, 0, true],
    ],
  );
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
  // Cursor and offset pagination cross chunk boundaries.
  assert.equal(run("default", "online_listings").rows[0], 70);
  assert.equal(run("chunked", "online_listings").chunks[0], 4);
  assert.equal(run("small-pages", "items").chunks[0], 18);
  assert.equal(run("small-pages", "things").chunks[0], 12);
  // `since` narrows on updated_at; rows without it are dropped, as in-process.
  assert.equal(run("since", "items").rows[0], 20);
  assert.equal(run("since", "online_listings").rows[0], 25);
  assert.equal(run("since", "enquiries").rows[0], 0);
  // The 429 and the 503 are retried on both sides, request for request.
  for (const entity of ENTITIES) {
    const limited = run("rate-limited", entity);
    assert.ok(limited.ok, entity);
    assert.ok(limited.requests[0] > run("default", entity).requests[0], entity);
  }
});

void test("a read session reads the same rows, chunks, requests and timestamps", async () => {
  const own = await startReplayServer();
  try {
    const results = await runParity({
      entities: ENTITIES,
      makeInProcess,
      makeBoxed: config =>
        boxed(SessionGraphql, config as unknown as Record<string, unknown>),
      server: own,
    });
    assert.deepEqual(
      results.filter(r => !r.ok).map(r => `${r.scenario}/${r.entity}`),
      [],
      formatReport(results),
    );
    assert.deepEqual(own.misses, []);
    assertTimestamps(results);
    assert.equal(SessionGraphql.chunkReads, 0);
    const calls = SessionGraphql.transports.flatMap(t => t.calls);
    assert.equal(calls.filter(c => c === "start").length, ENTITIES.length * 6);
    assert.equal(calls.filter(c => c === "close").length, ENTITIES.length * 6);
  } finally {
    await own.close();
  }
});

void test("the comparison catches a changed field, a lost row and another request", () => {
  const base = {
    rows: [
      { id: 1, n: 1 },
      { id: 2, n: 2 },
    ],
    chunks: [
      {
        offset: 0,
        cursor: null,
        totalProcessed: 2,
        totalCount: null,
        hasMore: false,
      },
    ],
    requests: ['POST /graphql {"query":"q"} (bearer)'],
  };
  assert.ok(compareRuns(base, structuredClone(base)).ok);
  const changed = structuredClone(base);
  changed.rows[1].n = 3;
  assert.deepEqual(compareRuns(base, changed).checksumMismatches, ["2"]);
  assert.equal(
    compareRuns(base, { ...base, rows: [base.rows[0]] }).keys,
    false,
  );
  const other = {
    ...structuredClone(base),
    requests: ['POST /graphql {"query":"q"} (hasura)'],
  };
  assert.equal(compareRuns(base, other).requestsEqual, false);
});

void test("the cassettes hold no credential", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /gql_test_|Bearer |admin-secret/i, file);
  }
});
