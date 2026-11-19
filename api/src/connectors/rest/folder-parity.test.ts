/**
 * Parity between this in-process REST connector and its port to a connector
 * folder (`connectors/rest/`, RFC connector-runtime).
 *
 * Both run against the same recorded HTTP responses, served locally. Each of
 * 7 entities (page numbers with a total, offsets with a has-more flag, an
 * opaque cursor, a POST search with a body, a bare array, a wrapped array
 * with no data path, a static `updatedAfter`) is read in 6 scenarios: one
 * request per chunk, two-row pages, the default chunk, incremental `since`,
 * an `X-API-Key` header, and the connection's `sync_batch_size`. Each run
 * compares row count, keys, order, columns, a checksum per row, the chunk
 * positions, the exact requests sent (query string, body, credential header
 * and content type) and each row's source timestamp. The entity list, the
 * config form with its encrypted fields, incremental capabilities, `check`
 * and a failing read are compared too.
 *
 * The folder runs through `SandboxedConnector`, with only the box replaced
 * by a local process (`BoxlessRest`), and again through a read session.
 *
 * The harness lives with the folder: connectors/rest/fixtures/harness.mjs.
 * Re-record or print the table with connectors/rest/fixtures/parity.mjs.
 *
 * Run: node --import tsx src/connectors/rest/folder-parity.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { RestConnector } from "./connector";
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
  ENTITIES,
  FOLDER,
  RUNNER,
  WORKSPACE_ID,
  checkParity,
  compareForm,
  compareRuns,
  ensureFolderInstalled,
  errorParity,
  formatReport,
  liftSsrfGuard,
  readFolder,
  readInProcess,
  runFolderCommand,
  runParity,
  startReplayServer,
  testConfig,
  type Comparison,
  type ReplayServer,
  type RestTestConfig,
  type Scenario,
} from "../../../../connectors/rest/fixtures/harness.mjs";

const settingsFor = (scenario?: Scenario) =>
  scenario?.settingsBatch ? { sync_batch_size: scenario.settingsBatch } : {};

const makeInProcess = (config: Record<string, unknown>, scenario?: Scenario) =>
  liftSsrfGuard(
    new RestConnector({
      _id: CONNECTION_ID,
      name: "REST parity",
      type: "rest",
      workspaceId: WORKSPACE_ID,
      config,
      settings: settingsFor(scenario),
    } as any),
  );

/** The folder as a workspace connector; only the box is a local process. */
class BoxlessRest extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "rest",
      runtime: "node",
      entry: "connector.ts",
      sha: "parity",
      sourceSha: "parity",
      spec: BoxlessRest.spec,
      entities: Object.keys(BoxlessRest.spec?.mako?.entities ?? {}),
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

const boxed = <T extends BoxlessRest>(
  Kind: new (source: any) => T,
  config: Record<string, unknown>,
  scenario?: Scenario,
) => {
  const connector = new Kind({
    _id: CONNECTION_ID,
    name: "REST parity",
    type: "ws:rest",
    workspaceId: WORKSPACE_ID,
    config,
    settings: settingsFor(scenario),
  } as any);
  // As the registry hands one out: the index row loaded.
  void connector.loadDefinition();
  return connector;
};
const makeBoxed = (config: RestTestConfig, scenario?: Scenario) =>
  boxed(BoxlessRest, config as unknown as Record<string, unknown>, scenario);

/** Through a read session; a `read` reaching a chunk process is counted. */
class SessionRest extends BoxlessRest {
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
      SessionRest.transports.push(this.transport);
    }
    return this.transport;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    if (command === "read") SessionRest.chunkReads++;
    return super.run(command, options);
  }
}

const BASE = "https://api.example.test/api/";
const CONFIG = {
  api_base_url: BASE,
  headers: "{}",
  entities: ENTITIES,
};
const NAMES = ENTITIES.map(e => e.name);

let server: ReplayServer;
let spec: Record<string, any> | undefined;

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  BoxlessRest.spec = spec;
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

void test("one entity per configured entity, in the connection's order, labelled as in-process", async () => {
  const inProcess = makeInProcess(CONFIG);
  const box = makeBoxed(CONFIG as unknown as RestTestConfig);
  await box.loadDefinition();
  assert.deepEqual(
    box.getAvailableEntities(),
    inProcess.getAvailableEntities(),
  );
  assert.deepEqual(box.getAvailableEntities(), NAMES);
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(
    plain(box.getEntityMetadata()),
    plain(inProcess.getEntityMetadata()),
  );
  // A connection with no entity offers none, on both sides.
  const bare = boxed(BoxlessRest, { api_base_url: BASE });
  await bare.loadDefinition();
  assert.deepEqual(bare.getAvailableEntities(), []);
  assert.deepEqual(
    makeInProcess({ api_base_url: BASE }).getAvailableEntities(),
    [],
  );
  // The spec declares no fixed entity: the list lives in `config.entities`.
  assert.deepEqual(spec?.mako?.entities, {});
  assert.equal(spec?.mako?.queryEntities?.source, "connection");
  assert.equal(spec?.mako?.queryEntities?.key, "entities");
});

/** Every `encrypted` field, as a path: `headers`, `entities.0.x`. */
function encryptedPaths(
  fields: Array<Record<string, any>> | undefined,
  prefix = "",
): string[] {
  return (fields ?? []).flatMap(field => [
    ...(field.encrypted ? [`${prefix}${field.name}`] : []),
    ...encryptedPaths(field.itemFields, `${prefix}${field.name}.`),
  ]);
}

void test("same config schema: names, types, required flags and the encrypted set", () => {
  const inProcess = RestConnector.getConfigSchema();
  const folder = specToForm(spec);
  const form = compareForm(inProcess.fields, folder.fields);
  assert.ok(form.ok, JSON.stringify(form, null, 2));
  // The three fields, in order, and the item fields of an entity.
  assert.deepEqual(
    folder.fields.map(f => [f.name, f.type, Boolean(f.required)]),
    inProcess.fields.map(f => [f.name, f.type, Boolean(f.required)]),
  );
  assert.deepEqual(
    folder.fields
      .find(f => f.name === "entities")
      ?.itemFields?.map(f => [f.name, f.type, Boolean(f.required)]),
    inProcess.fields
      .find(f => f.name === "entities")
      ?.itemFields?.map(f => [f.name, f.type, Boolean(f.required)]),
  );
  // Secrets: the same set. Stored connections keep their headers encrypted.
  assert.deepEqual(encryptedPaths(folder.fields), ["headers"]);
  assert.deepEqual(
    encryptedPaths(folder.fields),
    encryptedPaths(inProcess.fields),
  );
  const headers = folder.fields.find(f => f.name === "headers");
  assert.equal(headers?.type, "textarea");
  assert.equal(headers?.encrypted, true);
  // The body field shows for POST only, as in-process.
  const body = folder.fields
    .find(f => f.name === "entities")
    ?.itemFields?.find(f => f.name === "body");
  assert.deepEqual(body?.showIf, { field: "method", equals: ["POST"] });
  // Entities are the connection's, not a flow's.
  assert.equal(folder.transferQueries, undefined);
  assert.equal("transferQueries" in inProcess, false);
});

void test("same incremental capability: a client filter, before any entity exists", async () => {
  const bare = boxed(BoxlessRest, { api_base_url: BASE });
  await bare.loadDefinition();
  const inCaps = makeInProcess({
    api_base_url: BASE,
  }).getIncrementalCapabilities();
  assert.equal(bare.getIncrementalCapabilities().supported, inCaps.supported);
  assert.equal(bare.getIncrementalCapabilities().mode, inCaps.mode);
  const box = makeBoxed(CONFIG as unknown as RestTestConfig);
  await box.loadDefinition();
  for (const entity of NAMES) {
    assert.equal(
      box.getIncrementalCapabilities().perEntity?.[entity]?.mode,
      "client-filter",
    );
  }
});

void test("no schema on either side: rows land as they come, typed by the destination", async () => {
  const box = makeBoxed(CONFIG as unknown as RestTestConfig);
  await box.loadDefinition();
  for (const entity of NAMES) {
    assert.equal(await makeInProcess(CONFIG).resolveSchema(entity), null);
    assert.equal(await box.resolveSchema(entity), null, entity);
    assert.equal(await box.declaresUntypedSchema(entity), true, entity);
    assert.equal(
      await resolveEntitySchema({
        entity,
        workspaceId: WORKSPACE_ID,
        connector: box,
        sourceConnection: { type: "ws:rest" },
        context: "parity",
      }),
      null,
    );
  }
});

void test("check agrees on a valid API, a 401, a 404, a redirect, bad headers, no entity and no base URL", async () => {
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
      ["revoked", false, false, 1, true],
      ["notfound", false, false, 1, true],
      ["redirect_ok", true, true, 2, true],
      ["bad-headers", false, false, 0, true],
      ["no-entities", false, false, 0, true],
      ["no-base-url", false, false, 0, true],
    ],
  );
  // The folder says why, in the words in-process uses.
  const message = (variant: string) =>
    outcomes.find(o => o.variant === variant)?.folderMessage ?? "";
  assert.match(message("revoked"), /Request failed with status code 401/);
  assert.match(message("notfound"), /Request failed with status code 404/);
  assert.match(message("bad-headers"), /Headers must be valid JSON/);
  assert.match(
    message("no-entities"),
    /At least one entity must be configured/,
  );
  assert.match(message("no-base-url"), /API base URL is required/);
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

void test("every entity reads the same rows, chunks, requests and timestamps", async () => {
  const results = await runParity({
    entities: NAMES,
    makeInProcess,
    makeBoxed,
    server,
  });
  const report = formatReport(results);
  assert.equal(results.length, NAMES.length * 6);
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
  // Page, offset and cursor pagination cross chunk boundaries.
  assert.equal(run("default", "listings").rows[0], 70);
  assert.equal(run("chunked", "listings").chunks[0], 3);
  assert.equal(run("chunked", "events").chunks[0], 4);
  assert.equal(run("chunked", "orders").chunks[0], 4);
  assert.equal(run("small-pages", "events").chunks[0], 12);
  // `since` narrows on updated_at; rows without it are dropped, as in-process.
  assert.equal(run("since", "orders").rows[0], 20);
  assert.equal(run("since", "listings").rows[0], 25);
  assert.equal(run("since", "search").rows[0], 15);
  // The connection's batch size applies to an entity with none of its own.
  assert.equal(run("settings-batch", "plain").requests[0], 4);
  assert.equal(run("default", "plain").requests[0], 1);
  // A 2-row page is not what this server answers: both stop after one page.
  assert.equal(run("small-pages", "wrapped").rows[0], 6);
});

void test("a read session reads the same rows, chunks, requests and timestamps", async () => {
  const own = await startReplayServer();
  try {
    const results = await runParity({
      entities: NAMES,
      makeInProcess,
      makeBoxed: (config, scenario) =>
        boxed(
          SessionRest,
          config as unknown as Record<string, unknown>,
          scenario,
        ),
      server: own,
    });
    assert.deepEqual(
      results.filter(r => !r.ok).map(r => `${r.scenario}/${r.entity}`),
      [],
      formatReport(results),
    );
    assert.deepEqual(own.misses, []);
    assertTimestamps(results);
    assert.equal(SessionRest.chunkReads, 0);
    const calls = SessionRest.transports.flatMap(t => t.calls);
    assert.equal(calls.filter(c => c === "start").length, NAMES.length * 6);
    assert.equal(calls.filter(c => c === "close").length, NAMES.length * 6);
  } finally {
    await own.close();
  }
});

void test("a failing API fails the read the same way, after the same requests", async () => {
  const failed = await errorParity({
    makeInProcess,
    server,
    entity: "listings",
  });
  assert.equal(failed.inProcessMessage, "Request failed with status code 500");
  assert.match(failed.folderMessage, /Request failed with status code 500/);
  // The count preview fails and is ignored, then the first page fails.
  assert.equal(failed.requests, 2);
  assert.ok(failed.requestsEqual);
});

void test("the comparison catches a changed field, a lost row and another request", () => {
  const base = {
    rows: [
      { id: 1, n: 1 },
      { id: 2, n: 2 },
    ],
    chunks: [
      {
        page: 1,
        offset: 0,
        cursor: null,
        totalProcessed: 2,
        totalCount: null,
        hasMore: false,
      },
    ],
    requests: ["GET /api/v1/x?limit=2 (bearer; application/json)"],
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
    requests: ["GET /api/v1/x?limit=2 (api-key; application/json)"],
  };
  assert.equal(compareRuns(base, other).requestsEqual, false);
});

void test("the cassettes hold no credential", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /rest_test_|Bearer |x-api-key/i, file);
  }
});

void test("query strings serialise as axios does, for every shape a static param can take", () => {
  const params: Array<Record<string, unknown>> = [
    { a: 1, b: "x y", c: true, d: 0, e: "" },
    { tags: ["a", "b c"], ids: [1, 2, 3] },
    { sort: { by: "id", dir: "asc" }, deep: { a: { b: { c: 1 } } } },
    { skip: null, gone: undefined, kept: "yes" },
    { mixed: [{ a: 1 }, [2, 3]], list: [null, 3] },
    { special: "é&=/?:$,+#%[]", "odd key": "v" },
    { when: new Date(0), nothing: [], none: {} },
  ];
  const bases: Array<[string | undefined, string]> = [
    ["https://h.test/api/", "/v1/x"],
    ["https://h.test/api//", "v1/x"],
    ["https://h.test", "/"],
    ["https://h.test/v1", ""],
    ["https://h.test/v1", "https://other.test/abs?k=1"],
    ["https://h.test/v1", "/p?fixed=1#frag"],
  ];
  const script = `
    import { buildUrl } from ${JSON.stringify(path.join(FOLDER, "client.ts"))};
    const cases = JSON.parse(process.argv[1]);
    const dated = cases.map(c => c.params.when ? { ...c, params: { ...c.params, when: new Date(0) } } : c);
    console.log(JSON.stringify(dated.map(c => buildUrl(c.base, c.path, c.params))));
  `;
  const cases = bases.flatMap(([base, p]) =>
    params.map(query => ({ base, path: p, params: query })),
  );
  const out = JSON.parse(
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script, JSON.stringify(cases)],
      { encoding: "utf8" },
    ),
  ) as string[];
  cases.forEach((c, i) => {
    const params = c.params.when
      ? { ...c.params, when: new Date(0) }
      : c.params;
    const expected = axios.getUri({
      baseURL: c.base,
      url: c.path,
      params,
    });
    assert.equal(out[i], expected, JSON.stringify(c));
  });
});

void test("the address check refuses metadata names and private IPs in any spelling", async () => {
  // Through `check`, as a box runs it: the refusal comes before any request.
  const status = async (api_base_url: string) =>
    (
      await runFolderCommand("check", {
        config: { api_base_url, entities: [{ name: "x", path: "/" }] },
      })
    ).messages.find(m => m.type === "CONNECTION_STATUS")?.connectionStatus;
  for (const url of [
    "http://metadata.google.internal/",
    "http://metadata.google.internal./",
    "http://169.254.169.254/",
    "http://10.0.0.1/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[fd00::1]/",
  ]) {
    const result = await status(url);
    assert.equal(result?.status, "FAILED", url);
    assert.match(result?.message ?? "", /private or metadata address/, url);
  }
  const open = await status("http://[2001:db8::1]:9/api");
  assert.doesNotMatch(open?.message ?? "", /private or metadata address/);
});

void test("an unknown entity fails the read, even with no entity at all", async () => {
  // In-process throws "Entity configuration '<entity>' not found"; the box
  // must not answer 0 rows instead.
  for (const config of [
    { api_base_url: BASE },
    { ...CONFIG, entities: ENTITIES.slice(0, 1) },
  ]) {
    const box = boxed(BoxlessRest, config);
    await assert.rejects(
      box.fetchEntityChunk({
        entity: "no_such_entity",
        maxIterations: 1,
        singleChunk: true,
        onBatch: async () => {},
      } as any),
      /has no entity "no_such_entity"/,
    );
  }
});

void test("a redirect to a metadata address is refused on the hop", async () => {
  const token = "rest_test_folder_check_redirect_metadata";
  const { entities: _entities, ...connection } = testConfig(token, server);
  const result = await runFolderCommand("check", {
    config: { ...connection, entities: [{ name: "x", path: "/" }] },
  });
  const status = result.messages.find(m => m.type === "CONNECTION_STATUS");
  assert.equal(status?.connectionStatus?.status, "FAILED");
  assert.match(
    status?.connectionStatus?.message ?? "",
    /private or metadata address/,
  );
  assert.equal(server.requests(token).length, 1);
});

void test("a host name that resolves to a private address is refused before any request", () => {
  const script = `
    import { checkResolved } from ${JSON.stringify(path.join(FOLDER, "client.ts"))};
    const answers = {
      "internal.example.test": [{ address: "93.184.216.34" }, { address: "10.1.2.3" }],
      "mapped.example.test": [{ address: "::ffff:169.254.169.254" }],
      "public.example.test": [{ address: "93.184.216.34" }, { address: "2606:2800::1" }],
      "loopback.example.test": [{ address: "127.0.0.1" }],
      "localhost": [{ address: "::1" }, { address: "127.0.0.1" }],
    };
    const out = {};
    for (const host of Object.keys(answers)) {
      try {
        await checkResolved(new URL("https://" + host + "/api"), async h => answers[h]);
        out[host] = "allowed";
      } catch (error) {
        out[host] = error.message;
      }
    }
    console.log(JSON.stringify(out));
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    }),
  );
  assert.match(
    out["internal.example.test"],
    /resolves to a private.*10\.1\.2\.3/,
  );
  assert.match(out["mapped.example.test"], /resolves to a private/);
  assert.equal(out["public.example.test"], "allowed");
  assert.equal(out["loopback.example.test"], "allowed");
  assert.equal(out["localhost"], "allowed");
});

void test("a header value the runtime rejects is named, never quoted", async () => {
  const result = await runFolderCommand("check", {
    config: {
      api_base_url: BASE,
      headers: JSON.stringify({ "X-Key": "sec\nret-value" }),
      entities: [{ name: "x", path: "/" }],
    },
  });
  const status = result.messages.find(m => m.type === "CONNECTION_STATUS");
  assert.equal(status?.connectionStatus?.status, "FAILED");
  assert.equal(
    status?.connectionStatus?.message,
    'Invalid value for header "X-Key"',
  );
  assert.doesNotMatch(JSON.stringify(result), /ret-value/);
});

void test("the count preview runs for a GET entity only: a POST would run twice", async () => {
  // `search` with a total_count_path, which in-process previews with a
  // second POST. The folder sends the 3 pages and no preview.
  const counted = ENTITIES.map(e =>
    e.name === "search" ? { ...e, total_count_path: "total" } : e,
  );
  const token = "rest_test_inprocess_preview_search";
  const folderToken = "rest_test_folder_preview_search";
  const config = (t: string) => ({
    ...testConfig(t, server),
    entities: counted,
  });
  const read = (t: string) =>
    readInProcess(() => makeInProcess(config(t)), {
      entity: "search",
      maxIterations: 10,
    });
  const inRun = await read(token);
  assert.equal(inRun.rows.length, 30);
  const folderRun = await readFolder({
    entity: "search",
    maxIterations: 10,
    config: { ...config(folderToken), __rate_limit_delay_ms: 1 },
  });
  assert.equal(folderRun.rows.length, 30);
  assert.equal(server.requests(token).length, 4);
  assert.equal(server.requests(folderToken).length, 3);
  assert.deepEqual(server.misses, []);
});
