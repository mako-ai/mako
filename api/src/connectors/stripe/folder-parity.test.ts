/**
 * Parity between this in-process Stripe connector and its port to a connector
 * folder (`connectors/stripe/`, RFC connector-runtime iteration 4).
 *
 * Both run against the same recorded Stripe responses, served locally, with
 * the real `stripe` package on each side. Every entity is read in four
 * scenarios (one page per chunk, two-row pages, the default chunk,
 * incremental `since`) and compared on row count, keys, order, columns, a
 * checksum per row, the chunk states, the exact requests sent and each row's
 * source timestamp. The schemas (system columns included), the table layout,
 * incremental capabilities, the credential form and `check` are compared too.
 *
 * The folder runs through `SandboxedConnector`, the adapter the box path
 * uses, with only the box replaced by a local process (`BoxlessStripe`).
 * `since`, the page size, the rate limit and the source timestamp therefore
 * cross the same code a production box run does.
 *
 * The harness lives with the folder: connectors/stripe/fixtures/harness.mjs.
 * Re-record or print the table with connectors/stripe/fixtures/parity.mjs.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { StripeConnector } from "./connector";
import { MAKO_SYSTEM_FIELDS } from "../base/BaseConnector";
import { SandboxedConnector } from "../workspace/SandboxedConnector";
import type { LoadedConnector } from "../workspace/resolver";
import type { ConnectorCommand, RunResult } from "../workspace/sync-box";
import { parseConnectorFile } from "../workspace/connector-file";
import {
  connectionSpecificationToForm,
  jsonSchemaToEntitySchema,
} from "../workspace/spec-translation";
import { LocalSessionTransport } from "../workspace/test-support/local-session";
import {
  CASSETTE_DIR,
  FOLDER,
  RUNNER,
  checkParity,
  compareEntitySchema,
  compareForm,
  compareRuns,
  ensureFolderInstalled,
  formatReport,
  runFolderCommand,
  runParity,
  startReplayServer,
  type ReplayServer,
  type StripeTestConfig,
} from "../../../../connectors/stripe/fixtures/harness.mjs";

const makeInProcess = (config: StripeTestConfig) =>
  new StripeConnector({
    id: "ds_parity",
    name: "Stripe parity",
    type: "stripe",
    config,
  } as any);

/**
 * The Stripe folder as a workspace connector, with the box swapped for a
 * local process running the same SDK runner on the same files. Everything
 * else is `SandboxedConnector` as production runs it.
 */
class BoxlessStripe extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "stripe",
      runtime: "node",
      entry: "connector.ts",
      sha: "parity",
      sourceSha: "parity",
      spec: BoxlessStripe.spec,
      entities: Object.keys(BoxlessStripe.spec?.mako?.entities ?? {}),
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

const makeBoxed = (config: StripeTestConfig) =>
  new BoxlessStripe({
    id: "ds_parity",
    name: "Stripe parity",
    type: "ws:stripe",
    workspaceId: "ws_parity",
    config,
  } as any);

/**
 * The same folder through a read session (CONNECTOR_SESSION_READS): one
 * runner process per entity read, cut into batches by the real session
 * supervisor. Any `read` that reaches a chunk process is counted: there
 * must be none.
 */
class SessionStripe extends BoxlessStripe {
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
      SessionStripe.transports.push(this.transport);
    }
    return this.transport;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    if (command === "read") SessionStripe.chunkReads++;
    return super.run(command, options);
  }
}

const makeSession = (config: StripeTestConfig) =>
  new SessionStripe({
    id: "ds_parity",
    name: "Stripe parity",
    type: "ws:stripe",
    workspaceId: "ws_parity",
    config,
  } as any);

const ENTITIES = makeInProcess({
  api_key: "sk_test_list",
  api_base_url: "",
}).getAvailableEntities();

let server: ReplayServer;
let streams: Array<Record<string, any>> = [];
let spec: Record<string, any> | undefined;

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  const discover = await runFolderCommand("discover", {
    config: { api_key: "sk_test_schema" },
  });
  streams =
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  BoxlessStripe.spec = spec;
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

void test("the folder pins the stripe package the API resolves", () => {
  const folderPackage = JSON.parse(
    fs.readFileSync(path.join(FOLDER, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(FOLDER, "package-lock.json"), "utf8"),
  );
  const apiStripe = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../../node_modules/stripe/package.json"),
      "utf8",
    ),
  ).version;
  assert.equal(folderPackage.dependencies.stripe, apiStripe);
  assert.equal(lock.packages["node_modules/stripe"].version, apiStripe);
});

void test("same entities, labels and credential form", () => {
  assert.deepEqual(
    streams.map(s => s.name),
    ENTITIES,
  );
  const metadata = makeInProcess({
    api_key: "sk_test_list",
    api_base_url: "",
  }).getEntityMetadata();
  for (const { name, label } of metadata) {
    assert.equal(spec?.mako?.entities?.[name]?.label, label, name);
  }
  const form = compareForm(
    StripeConnector.getConfigSchema().fields,
    connectionSpecificationToForm(spec?.connectionSpecification).fields,
  );
  assert.ok(form.ok, JSON.stringify(form, null, 2));
});

void test("same schema for every entity, the 8 system columns included", async () => {
  const system = new Set(Object.keys(MAKO_SYSTEM_FIELDS));
  const connector = makeInProcess({
    api_key: "sk_test_list",
    api_base_url: "",
  });
  const boxed = makeBoxed({ api_key: "sk_test_schema", api_base_url: "" });
  for (const entity of ENTITIES) {
    const inProcess = await connector.resolveSchema(entity);
    const result = compareEntitySchema(
      inProcess,
      jsonSchemaToEntitySchema(
        entity,
        streams.find(s => s.name === entity),
      ),
      system,
    );
    assert.ok(result.ok, `${entity}: ${JSON.stringify(result)}`);
    assert.equal(result.systemFields, system.size, entity);
    // Type, nullability, default and derivation of all 8, both sides.
    assert.deepEqual(result.systemDiffs, [], entity);
    // And through the adapter the engine calls, not only the translation.
    const viaBox = compareEntitySchema(
      inProcess,
      await boxed.resolveSchema(entity),
    );
    assert.ok(viaBox.ok, `${entity} via the box: ${JSON.stringify(viaBox)}`);
  }
});

void test("same table layout and incremental mode for every entity", async () => {
  const inProcess = makeInProcess({
    api_key: "sk_test_list",
    api_base_url: "",
  });
  const boxed = makeBoxed({ api_key: "sk_test_list", api_base_url: "" });
  await boxed.loadDefinition();
  const layouts = (c: { getEntityMetadata(): any[] }) =>
    Object.fromEntries(
      c.getEntityMetadata().map(e => [e.name, e.layoutSuggestion ?? null]),
    );
  assert.deepEqual(layouts(boxed), layouts(inProcess));

  const effective = (
    caps: ReturnType<StripeConnector["getIncrementalCapabilities"]>,
    entity: string,
  ) => caps.perEntity?.[entity]?.mode ?? caps.mode;
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

void test("every entity reads the same rows, chunks and requests", async () => {
  const results = await runParity({
    entities: ENTITIES,
    makeInProcess,
    makeBoxed,
    server,
  });
  const report = formatReport(results);
  assert.equal(results.length, ENTITIES.length * 4);
  assert.deepEqual(
    results.filter(r => !r.ok).map(r => `${r.scenario}/${r.entity}`),
    [],
    report,
  );
  assert.deepEqual(server.misses, []);
  // Every row's source timestamp matches, and none of them is "now": the
  // boxed side reads Stripe's epoch `created` as the in-process one does.
  const checked = results.reduce((n, r) => n + r.timestampsChecked, 0);
  const rowsRead = results.reduce((n, r) => n + r.rows[0], 0);
  assert.equal(checked, rowsRead);
  assert.ok(checked > 0);
  for (const r of results) {
    assert.deepEqual(
      r.timestampsFellBackToNow,
      [0, 0],
      `${r.scenario}/${r.entity}`,
    );
  }
  // The fixtures exercise more than one page, chunk boundaries and child lists.
  const chunked = (entity: string) =>
    results.find(r => r.scenario === "chunked" && r.entity === entity);
  assert.equal(chunked("customers")?.chunks[0], 2);
  assert.equal(chunked("payout_balance_transactions")?.rows[0], 212);
  assert.equal(chunked("customer_balance_transactions")?.rows[0], 126);
  assert.equal(chunked("setup_intents")?.rows[0], 0);
  // Two rows a page: every entity with 3 rows or more resumes from a cursor.
  for (const r of results.filter(r => r.scenario === "small-pages")) {
    if (r.rows[0] >= 3) {
      assert.ok(r.chunks[0] >= 2, `${r.entity} never resumed`);
    }
  }
});

void test("a read session reads the same rows, chunks, requests and timestamps", async () => {
  // A server of its own: request logs are per key, and the keys repeat.
  const own = await startReplayServer();
  try {
    const results = await runParity({
      entities: ENTITIES,
      makeInProcess,
      makeBoxed: makeSession,
      server: own,
    });
    const report = formatReport(results);
    assert.equal(results.length, ENTITIES.length * 4);
    assert.deepEqual(
      results.filter(r => !r.ok).map(r => `${r.scenario}/${r.entity}`),
      [],
      report,
    );
    assert.deepEqual(own.misses, []);
    const checked = results.reduce((n, r) => n + r.timestampsChecked, 0);
    const rowsRead = results.reduce((n, r) => n + r.rows[0], 0);
    assert.equal(checked, rowsRead);
    for (const r of results) {
      assert.deepEqual(
        r.timestampsFellBackToNow,
        [0, 0],
        `${r.scenario}/${r.entity}`,
      );
    }
    // Every read went through a session, one per entity read, and every
    // session was closed at the end of its read.
    assert.equal(SessionStripe.chunkReads, 0);
    const calls = SessionStripe.transports.flatMap(t => t.calls);
    assert.equal(calls.filter(c => c === "start").length, ENTITIES.length * 4);
    assert.equal(calls.filter(c => c === "close").length, ENTITIES.length * 4);
    assert.ok(calls.filter(c => c.startsWith("pull")).length > 0);
    assert.deepEqual(
      SessionStripe.transports.map(t => t.open()),
      SessionStripe.transports.map(() => 0),
    );
    // Chunk boundaries are the same as chunk processes': small-pages resumes.
    const chunked = (entity: string) =>
      results.find(r => r.scenario === "chunked" && r.entity === entity);
    assert.equal(chunked("customers")?.chunks[1], 2);
    assert.equal(chunked("payout_balance_transactions")?.rows[1], 212);
  } finally {
    await own.close();
  }
});

void test("replay refuses a request made with another Stripe-Version", async () => {
  const response = await fetch(`${server.url}/v1/account`, {
    headers: {
      authorization: "Bearer sk_test_version_probe",
      "stripe-version": "2020-08-27",
    },
  });
  assert.equal(response.status, 404);
  assert.ok(
    server.misses.some(miss => miss.includes("recorded with 2023-10-16")),
    server.misses.join("\n"),
  );
  server.misses.length = 0;
});

void test("the comparison catches a changed field, a lost row and another request", () => {
  const rows = [
    { id: "a", amount: 1 },
    { id: "b", amount: 2 },
  ];
  const base = {
    rows,
    chunks: [{ cursor: "b", hasMore: false }],
    requests: ["GET /v1/x?limit=100"],
  };
  assert.ok(compareRuns(base, structuredClone(base)).ok);

  const changed = structuredClone(base);
  changed.rows[1].amount = 3;
  assert.deepEqual(compareRuns(base, changed).checksumMismatches, ["b"]);

  const lost = { ...structuredClone(base), rows: [rows[0]] };
  assert.equal(compareRuns(base, lost).keys, false);

  const other = {
    ...structuredClone(base),
    requests: ["GET /v1/x?limit=100&status=all"],
  };
  assert.equal(compareRuns(base, other).requestsEqual, false);
});

void test("the cassettes hold no key or signing secret", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /\b(sk|rk)_(live|test)_|whsec_/, file);
  }
});
