/**
 * Parity between this in-process PostHog connector and its port to a
 * connector folder (`connectors/posthog/`, RFC connector-runtime iteration 5).
 *
 * Both run against the same recorded PostHog responses, served locally.
 * Every entity is read in 6 scenarios (one request per chunk, two-row
 * pages, the default chunk, incremental `since`, the posthog_crm flow's
 * settings, a project API key) and compared on row count, keys, order,
 * columns, a checksum per row, the chunk positions, the exact requests sent
 * and each row's source timestamp. The schemas (system columns included),
 * the table layout, incremental capabilities, the credential form and
 * `check` are compared too.
 *
 * The folder runs through `SandboxedConnector`, the adapter the box path
 * uses, with only the box replaced by a local process (`BoxlessPosthog`).
 *
 * Source timestamps match row for row. A survey response has no update or
 * creation field, so both sides give it "now"; every other row has its own.
 *
 * The harness lives with the folder: connectors/posthog/fixtures/harness.mjs.
 * Re-record or print the table with connectors/posthog/fixtures/parity.mjs.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PosthogConnector } from "./connector";
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
  type Comparison,
  type ReplayServer,
  type PosthogTestConfig,
} from "../../../../connectors/posthog/fixtures/harness.mjs";

const makeInProcess = (config: PosthogTestConfig) =>
  new PosthogConnector({
    id: "ds_parity",
    name: "PostHog parity",
    type: "posthog",
    config,
  } as any);

/**
 * The PostHog folder as a workspace connector, with the box swapped for a
 * local process running the same SDK runner on the same files. Everything
 * else is `SandboxedConnector` as production runs it.
 */
class BoxlessPosthog extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "posthog",
      runtime: "node",
      entry: "connector.ts",
      sha: "parity",
      sourceSha: "parity",
      spec: BoxlessPosthog.spec,
      entities: Object.keys(BoxlessPosthog.spec?.mako?.entities ?? {}),
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

const makeBoxed = (config: PosthogTestConfig) =>
  new BoxlessPosthog({
    id: "ds_parity",
    name: "PostHog parity",
    type: "ws:posthog",
    workspaceId: "ws_parity",
    config,
  } as any);

/**
 * The same folder through a read session (CONNECTOR_SESSION_READS): one
 * runner process per entity read. Any `read` that reaches a chunk process
 * is counted: there must be none.
 */
class SessionPosthog extends BoxlessPosthog {
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
      SessionPosthog.transports.push(this.transport);
    }
    return this.transport;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    if (command === "read") SessionPosthog.chunkReads++;
    return super.run(command, options);
  }
}

const makeSession = (config: PosthogTestConfig) =>
  new SessionPosthog({
    id: "ds_parity",
    name: "PostHog parity",
    type: "ws:posthog",
    workspaceId: "ws_parity",
    config,
  } as any);

const LIST_CONFIG: PosthogTestConfig = {
  api_key: "phx_test_list",
  api_base_url: "",
  project_id: "41234",
};

const ENTITIES = makeInProcess(LIST_CONFIG).getAvailableEntities();

let server: ReplayServer;
let streams: Array<Record<string, any>> = [];
let spec: Record<string, any> | undefined;

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  const discover = await runFolderCommand("discover", {
    config: { api_key: "phx_test_schema", project_id: "41234" },
  });
  streams =
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  BoxlessPosthog.spec = spec;
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

void test("same entities, labels and credential form", () => {
  assert.deepEqual(
    streams.map(s => s.name),
    ENTITIES,
  );
  const metadata = makeInProcess(LIST_CONFIG).getEntityMetadata();
  for (const { name, label, description } of metadata) {
    assert.equal(spec?.mako?.entities?.[name]?.label, label, name);
    assert.equal(spec?.mako?.entities?.[name]?.description, description, name);
  }
  const form = compareForm(
    PosthogConnector.getConfigSchema().fields,
    connectionSpecificationToForm(spec?.connectionSpecification).fields,
  );
  assert.ok(form.ok, JSON.stringify(form, null, 2));
});

void test("same schema for every entity, the 8 system columns included", async () => {
  const system = new Set(Object.keys(MAKO_SYSTEM_FIELDS));
  const connector = makeInProcess(LIST_CONFIG);
  const boxed = makeBoxed({ ...LIST_CONFIG, api_key: "phx_test_schema" });
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
  const inProcess = makeInProcess(LIST_CONFIG);
  const boxed = makeBoxed(LIST_CONFIG);
  await boxed.loadDefinition();
  const layouts = (c: { getEntityMetadata(): any[] }) =>
    Object.fromEntries(
      c.getEntityMetadata().map(e => [e.name, e.layoutSuggestion ?? null]),
    );
  assert.deepEqual(layouts(boxed), layouts(inProcess));

  const effective = (
    caps: ReturnType<PosthogConnector["getIncrementalCapabilities"]>,
    entity: string,
  ) => caps.perEntity?.[entity]?.mode ?? caps.mode;
  const inCaps = inProcess.getIncrementalCapabilities();
  const boxCaps = boxed.getIncrementalCapabilities();
  assert.equal(boxCaps.supported, inCaps.supported);
  for (const entity of ENTITIES) {
    assert.equal(effective(boxCaps, entity), effective(inCaps, entity), entity);
  }
  assert.equal(effective(boxCaps, "survey_responses"), "native");
  assert.equal(effective(boxCaps, "surveys"), "created-anchor");
});

void test("check agrees on a valid key, a key without survey scope and a revoked one", async () => {
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
      // One survey, and nothing else.
      ["valid", true, true, 1, true],
      // A 403 on surveys, then the HogQL probe.
      ["nosurveys", true, true, 2, true],
      // A 401 on surveys, then a 401 on the probe.
      ["revoked", false, false, 2, true],
    ],
  );
});

/**
 * Source timestamps match row for row. Responses fall back to "now" on both
 * sides (no update or creation field); every other row has its own time.
 */
function assertTimestamps(results: Comparison[]) {
  const checked = results.reduce((n, r) => n + r.timestampsChecked, 0);
  const rowsRead = results.reduce((n, r) => n + r.rows[0], 0);
  assert.equal(checked, rowsRead);
  assert.ok(checked > 0);
  for (const r of results) {
    const where = `${r.scenario}/${r.entity}`;
    assert.deepEqual(r.timestampMismatches, [], where);
    const now = r.entity === "survey_responses" ? r.rows[0] : 0;
    assert.deepEqual(r.timestampsFellBackToNow, [now, now], where);
  }
}

void test("every entity reads the same rows, chunks and requests", async () => {
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
  // The fixtures cross pages, chunk boundaries and the survey walk.
  const run = (scenario: string, entity: string) =>
    results.find(r => r.scenario === scenario && r.entity === entity);
  assert.equal(run("default", "survey_responses")?.rows[0], 286);
  assert.equal(run("chunked", "survey_responses")?.chunks[0], 15);
  assert.equal(run("chunked", "annotations")?.chunks[0], 2);
  assert.equal(run("default", "annotations")?.rows[0], 105);
  // `since` narrows every entity, and the flow's 2000-row pages read the same.
  for (const entity of ENTITIES) {
    const since = run("since", entity)?.rows[0] ?? -1;
    const all = run("default", entity)?.rows[0] ?? -1;
    assert.ok(since >= 0 && since < all, entity);
    assert.equal(run("flow", entity)?.rows[0], since, entity);
  }
  // Two rows a page: every entity with 3 rows or more resumes from an offset.
  for (const r of results.filter(r => r.scenario === "small-pages")) {
    if (r.rows[0] >= 3) {
      assert.ok(r.chunks[0] >= 2, `${r.entity} never resumed`);
    }
  }
  // A project key travels in POSTHOG-API-TOKEN on both sides.
  for (const entity of ENTITIES) {
    assert.equal(run("project-key", entity)?.ok, true, entity);
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
    assert.equal(results.length, ENTITIES.length * 6);
    assert.deepEqual(
      results.filter(r => !r.ok).map(r => `${r.scenario}/${r.entity}`),
      [],
      report,
    );
    assert.deepEqual(own.misses, []);
    assertTimestamps(results);
    // Every read went through a session, one per entity read, and every
    // session was closed at the end of its read.
    assert.equal(SessionPosthog.chunkReads, 0);
    const calls = SessionPosthog.transports.flatMap(t => t.calls);
    assert.equal(calls.filter(c => c === "start").length, ENTITIES.length * 6);
    assert.equal(calls.filter(c => c === "close").length, ENTITIES.length * 6);
    assert.ok(calls.filter(c => c.startsWith("pull")).length > 0);
    assert.deepEqual(
      SessionPosthog.transports.map(t => t.open()),
      SessionPosthog.transports.map(() => 0),
    );
    const run = (scenario: string, entity: string) =>
      results.find(r => r.scenario === scenario && r.entity === entity);
    assert.equal(run("chunked", "survey_responses")?.chunks[1], 15);
    assert.equal(run("default", "survey_responses")?.rows[1], 286);
  } finally {
    await own.close();
  }
});

void test("the comparison catches a changed field, a lost row, a moved offset and another request", () => {
  const rows = [
    { id: "a", answers: { q: 1 } },
    { id: "b", answers: { q: 2 } },
  ];
  const base = {
    rows,
    chunks: [{ offset: 0, hasMore: false }],
    requests: ["GET /api/projects/1/surveys/?limit=100&offset=0 (bearer)"],
  };
  assert.ok(compareRuns(base, structuredClone(base)).ok);

  const changed = structuredClone(base);
  changed.rows[1].answers.q = 3;
  assert.deepEqual(compareRuns(base, changed).checksumMismatches, ["b"]);

  const lost = { ...structuredClone(base), rows: [rows[0]] };
  assert.equal(compareRuns(base, lost).keys, false);

  const moved = {
    ...structuredClone(base),
    chunks: [{ offset: 100, hasMore: false }],
  };
  assert.equal(compareRuns(base, moved).chunkStates, false);

  const other = {
    ...structuredClone(base),
    requests: [
      "GET /api/projects/1/surveys/?limit=100&offset=0 (project-token)",
    ],
  };
  assert.equal(compareRuns(base, other).requestsEqual, false);
});

void test("HogQL query entities stay in-process only", () => {
  // The SDK declares entities statically; a flow's `queries` add entities
  // in-process only. posthog_crm has none.
  const withQueries = makeInProcess({
    ...LIST_CONFIG,
    queries: [{ name: "events_7d", query: "SELECT 1" }],
  } as PosthogTestConfig);
  assert.deepEqual(withQueries.getAvailableEntities(), [
    ...ENTITIES,
    "events_7d",
  ]);
  assert.deepEqual(Object.keys(spec?.mako?.entities ?? {}), ENTITIES);
});

void test("the cassettes hold no key", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /\bph[xc]_/, file);
  }
});
