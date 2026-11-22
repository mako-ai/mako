/**
 * The REST connector folder (`connectors/rest/`), run as production runs
 * it: through `SandboxedConnector`, with only the box replaced by a local
 * process (`BoxlessRest`), and again through a read session.
 *
 * The in-process connector this folder was ported from is deleted. The
 * rows, chunk positions and requests it produced are the golden files in
 * `connectors/rest/fixtures/golden/` (compared byte for byte by
 * `workspace/rest-folder-golden.test.ts`). These tests read every entity in
 * 6 scenarios through the adapter and the session and compare each read
 * with the golden file. They also cover what the golden rows cannot: the
 * entity list, the config form with its encrypted fields, incremental
 * capabilities, `check`, a failing read, source timestamps, query string
 * serialisation and the address policy (a redirect, a rebound DNS name,
 * every spelling of a private address).
 *
 * The harness lives with the folder: connectors/rest/fixtures/harness.mjs.
 * Sits at the top of api/src/connectors, not in a rest/ folder, which the
 * connector family boundary guard would treat as a family.
 *
 * Run: node --import tsx --test src/connectors/rest-folder.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { SandboxedConnector } from "./workspace/SandboxedConnector";
import type { LoadedConnector } from "./workspace/resolver";
import type { ConnectorCommand, RunResult } from "./workspace/sync-box";
import { parseConnectorFile } from "./workspace/connector-file";
import { specToForm } from "./workspace/spec-translation";
import { LocalSessionTransport } from "./workspace/test-support/local-session";
import { resolveEntitySchema } from "../sync/sync-orchestrator";
import {
  CASSETTE_DIR,
  CONNECTION_ID,
  ENTITIES,
  FOLDER,
  RUNNER,
  SCENARIOS,
  WORKSPACE_ID,
  ensureFolderInstalled,
  readBoxed,
  readFolder,
  runFolderCommand,
  sourceTimestamps,
  startReplayServer,
  testConfig,
  tokenFor,
  type ReplayServer,
  type RestTestConfig,
  type Scenario,
} from "../../../connectors/rest/fixtures/harness.mjs";

const GOLDEN_DIR = path.join(FOLDER, "fixtures/golden");
const goldenFile = (scenario: string, entity: string) =>
  path.join(GOLDEN_DIR, scenario, `${entity}.json`);
const golden = (scenario: string, entity: string) =>
  JSON.parse(fs.readFileSync(goldenFile(scenario, entity), "utf8"));

/** Compare as JSON: the golden files are JSON, a row may carry `undefined`. */
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value));

const settingsFor = (scenario?: Scenario) =>
  scenario?.settingsBatch ? { sync_batch_size: scenario.settingsBatch } : {};

/** The folder as a workspace connector; only the box is a local process. */
class BoxlessRest extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "rest",
      runtime: "node",
      entry: "connector.ts",
      sha: "fixture",
      sourceSha: "fixture",
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
    name: "REST fixture",
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

void test("one entity per configured entity, in the connection's order", async () => {
  const box = makeBoxed(CONFIG as unknown as RestTestConfig);
  await box.loadDefinition();
  assert.deepEqual(box.getAvailableEntities(), NAMES);
  assert.equal(NAMES.length, 7);
  // A connection with no entity offers none.
  const bare = boxed(BoxlessRest, { api_base_url: BASE });
  await bare.loadDefinition();
  assert.deepEqual(bare.getAvailableEntities(), []);
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

void test("the config form: names, types, required flags and the encrypted set", () => {
  const folder = specToForm(spec);
  assert.deepEqual(
    folder.fields.map(f => [f.name, f.type, Boolean(f.required)]),
    [
      ["api_base_url", "string", false],
      ["headers", "textarea", false],
      ["entities", "object_array", false],
    ],
  );
  assert.deepEqual(
    folder.fields
      .find(f => f.name === "entities")
      ?.itemFields?.map(f => [f.name, f.type, Boolean(f.required)]),
    [
      ["name", "string", true],
      ["path", "string", true],
      ["method", "select", false],
      ["params", "textarea", false],
      ["body", "textarea", false],
      ["data_path", "string", false],
      ["total_count_path", "string", false],
      ["page_param", "string", false],
      ["limit_param", "string", false],
      ["offset_param", "string", false],
      ["cursor_param", "string", false],
      ["next_cursor_path", "string", false],
      ["has_more_path", "string", false],
      ["batch_size", "number", false],
    ],
  );
  // Secrets: stored connections keep their headers encrypted.
  assert.deepEqual(encryptedPaths(folder.fields), ["headers"]);
  const headers = folder.fields.find(f => f.name === "headers");
  assert.equal(headers?.type, "textarea");
  assert.equal(headers?.encrypted, true);
  // The body field shows for POST only.
  const body = folder.fields
    .find(f => f.name === "entities")
    ?.itemFields?.find(f => f.name === "body");
  assert.deepEqual(body?.showIf, { field: "method", equals: ["POST"] });
  // Entities are the connection's, not a flow's.
  assert.equal(folder.transferQueries, undefined);
});

void test("incremental capability: a client filter, before any entity exists", async () => {
  const bare = boxed(BoxlessRest, { api_base_url: BASE });
  await bare.loadDefinition();
  assert.equal(bare.getIncrementalCapabilities().supported, true);
  assert.equal(bare.getIncrementalCapabilities().mode, "client-filter");
  const box = makeBoxed(CONFIG as unknown as RestTestConfig);
  await box.loadDefinition();
  for (const entity of NAMES) {
    assert.equal(
      box.getIncrementalCapabilities().perEntity?.[entity]?.mode,
      "client-filter",
    );
  }
});

void test("no schema: rows land as they come, typed by the destination", async () => {
  const box = makeBoxed(CONFIG as unknown as RestTestConfig);
  await box.loadDefinition();
  for (const entity of NAMES) {
    assert.equal(await box.resolveSchema(entity), null, entity);
    assert.equal(await box.declaresUntypedSchema(entity), true, entity);
    assert.equal(
      await resolveEntitySchema({
        entity,
        workspaceId: WORKSPACE_ID,
        connector: box,
        sourceConnection: { type: "ws:rest" },
        context: "fixture",
      }),
      null,
    );
  }
});

void test("check on a valid API, a 401, a 404, a redirect, bad headers, no entity and no base URL", async () => {
  const outcome = async (variant: string) => {
    const suffix = ["revoked", "notfound", "redirect_ok"].includes(variant)
      ? `_${variant}`
      : "";
    const token = `rest_test_folder_check_${variant}${suffix}`;
    const connection: Record<string, unknown> = {
      ...testConfig(token, server),
    };
    if (variant === "bad-headers") connection.headers = "{not json";
    if (variant === "no-entities") connection.entities = [];
    if (variant === "no-base-url") connection.api_base_url = undefined;
    const run = await runFolderCommand("check", { config: connection });
    const status = run.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    return {
      row: [variant, status?.status, server.requests(token).length],
      message: String(status?.message ?? ""),
    };
  };
  const variants = [
    "valid",
    "revoked",
    "notfound",
    "redirect_ok",
    "bad-headers",
    "no-entities",
    "no-base-url",
  ];
  const outcomes = new Map<string, { row: unknown[]; message: string }>();
  for (const variant of variants) outcomes.set(variant, await outcome(variant));
  assert.deepEqual(
    variants.map(v => outcomes.get(v)?.row),
    [
      ["valid", "SUCCEEDED", 1],
      ["revoked", "FAILED", 1],
      ["notfound", "FAILED", 1],
      ["redirect_ok", "SUCCEEDED", 2],
      ["bad-headers", "FAILED", 0],
      ["no-entities", "FAILED", 0],
      ["no-base-url", "FAILED", 0],
    ],
  );
  // The folder says why, in the words the in-process connector used.
  const message = (variant: string) => outcomes.get(variant)?.message ?? "";
  assert.match(message("revoked"), /Request failed with status code 401/);
  assert.match(message("notfound"), /Request failed with status code 404/);
  assert.match(message("bad-headers"), /Headers must be valid JSON/);
  assert.match(
    message("no-entities"),
    /At least one entity must be configured/,
  );
  assert.match(message("no-base-url"), /API base URL is required/);
});

/**
 * Every entity in every scenario through `make`, against the golden rows,
 * chunk positions and requests. Each row's source timestamp is its
 * `updated_at` or `updatedAt`, else its `created_at`, else "now": a
 * `modified_at` (search) or `modifiedAt` (plain) is not one.
 */
async function readsMatchGolden(
  make: (config: RestTestConfig, scenario: Scenario) => BoxlessRest,
  own: ReplayServer,
) {
  let stamped = 0;
  for (const scenario of SCENARIOS) {
    for (const entity of NAMES) {
      const key = `${scenario.name}/${entity}`;
      const token = tokenFor("adapter", scenario, entity);
      const box = make(testConfig(token, own, scenario), scenario);
      const run = await readBoxed(box, {
        entity,
        since: scenario.since,
        maxIterations: scenario.maxIterations,
        pageSize: scenario.pageSize,
      });
      const expected = golden(scenario.name, entity);
      assert.deepEqual(asJson(run.rows), expected.rows, key);
      assert.deepEqual(asJson(run.chunks), expected.chunks, key);
      assert.deepEqual(own.requests(token), expected.requests, key);
      const { byId } = sourceTimestamps(box, entity, run.rows);
      for (const row of run.rows) {
        const ts = row.updated_at ?? row.updatedAt ?? row.created_at;
        const want = ts ? new Date(String(ts)).toISOString() : "now";
        if (want !== "now") stamped++;
        assert.equal(byId.get(String(row.id)), want, `${key} ${row.id}`);
      }
    }
  }
  assert.ok(stamped > 0);
  assert.deepEqual(own.misses, []);
}

void test("every entity reads the golden rows, chunks, requests and timestamps through the adapter", async () => {
  await readsMatchGolden(makeBoxed, server);
});

void test("a read session reads the golden rows, chunks, requests and timestamps", async () => {
  const own = await startReplayServer();
  try {
    await readsMatchGolden(
      (config, scenario) =>
        boxed(
          SessionRest,
          config as unknown as Record<string, unknown>,
          scenario,
        ),
      own,
    );
    assert.equal(SessionRest.chunkReads, 0);
    const calls = SessionRest.transports.flatMap(t => t.calls);
    assert.equal(calls.filter(c => c === "start").length, NAMES.length * 6);
    assert.equal(calls.filter(c => c === "close").length, NAMES.length * 6);
  } finally {
    await own.close();
  }
});

void test("a failing API fails the read after the count preview and the first page", async () => {
  const token = "rest_test_folder_error500_listings";
  await assert.rejects(
    readFolder({
      entity: "listings",
      maxIterations: 10,
      config: { ...testConfig(token, server), __rate_limit_delay_ms: 1 },
    }),
    /Request failed with status code 500/,
  );
  // The count preview fails and is ignored, then the first page fails.
  assert.equal(server.requests(token).length, 2);
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
  const open = await status("http://127.0.0.1:9/api");
  assert.doesNotMatch(open?.message ?? "", /private or metadata address/);
});

void test("an unknown entity fails the read, even with no entity at all", async () => {
  // The in-process connector threw "Entity configuration '<entity>' not
  // found"; the box must not answer 0 rows instead.
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

/** Run a script in the folder's own runtime and read its JSON output. */
function inFolder(script: string): any {
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      cwd: FOLDER,
    }),
  );
}

void test("DNS rebinding: the socket's own lookup is the guard, so a rebound name is refused and no header is sent", () => {
  // A fake resolver answers 93.184.216.34 on the first lookup (what a
  // separate guard would see) and the target below on every later one. A
  // second request on the same client is checked again, with no host cache.
  const script = `
    import http from "node:http";
    import { RestClient } from ${JSON.stringify(path.join(FOLDER, "client.ts"))};
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: 1 }));
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const out = {};
    const run = async (name, rebound) => {
      const calls = [];
      const resolve = (host, _o, cb) => {
        calls.push(host);
        const address = calls.length === 1 ? "93.184.216.34" : rebound;
        cb(null, [{ address, family: address.includes(":") ? 6 : 4 }]);
      };
      // The "guard" lookup an old client made before connecting.
      await new Promise(r => resolve("rebind.example.test", {}, () => r()));
      const before = seen.length;
      const client = new RestClient(
        { api_base_url: "http://rebind.example.test:" + port + "/api", headers: { "X-API-Key": "S3CRET" } },
        resolve,
      );
      try {
        await client.request({ method: "GET", path: "/x", params: {} });
        out[name] = { error: null, reached: seen.length - before, lookups: calls.length };
      } catch (error) {
        out[name] = { error: error.message, reached: seen.length - before, lookups: calls.length };
      }
    };
    await run("metadata", "169.254.169.254");
    await run("private", "10.1.2.3");
    await run("mappedMetadata", "::ffff:169.254.169.254");
    // Loopback is allowed in a box: the socket does connect to what the resolver answers.
    await run("loopback", "127.0.0.1");
    server.close();
    console.log(JSON.stringify(out));
  `;
  const out = inFolder(script);
  for (const name of ["metadata", "private", "mappedMetadata"]) {
    assert.match(out[name].error, /resolves to a blocked address/, name);
    assert.equal(
      out[name].reached,
      0,
      `${name}: no request reached the server`,
    );
    assert.equal(out[name].lookups, 2, `${name}: one lookup in the request`);
    assert.doesNotMatch(out[name].error, /S3CRET/);
  }
  assert.equal(out.loopback.error, null);
  assert.equal(out.loopback.reached, 1);
});

void test("redirects: https to http with a credential is refused, and custom headers leave with the host", () => {
  const script = `
    import http from "node:http";
    import { RestClient } from ${JSON.stringify(path.join(FOLDER, "client.ts"))};
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ path: req.url, key: req.headers["x-api-key"] ?? null });
      if (req.url.startsWith("/hop")) {
        res.writeHead(302, { location: "http://other.example.test:" + server.address().port + "/landed" });
        return res.end();
      }
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const resolve = (host, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]);
    const client = new RestClient(
      { api_base_url: "http://main.example.test:" + port, headers: { "X-API-Key": "S3CRET" } },
      resolve,
    );
    await client.request({ method: "GET", path: "/hop", params: {} });
    server.close();
    console.log(JSON.stringify(seen));
  `;
  const seen = inFolder(script);
  assert.deepEqual(seen, [
    { path: "/hop", key: "S3CRET" },
    { path: "/landed", key: null },
  ]);
});

void test("the address policy: public unicast and loopback pass, everything else is blocked", () => {
  const blocked = [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "fe80::1",
    "fec0::1",
    "fd00::1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::a9fe:a9fe",
    "100::1",
    "2002:a9fe:a9fe::1",
    "::ffff:0:a9fe:a9fe",
    "::ffff:169.254.169.254",
    "2001:db8::1",
  ];
  const allowed = [
    "1.1.1.1",
    "93.184.216.34",
    "127.0.0.1",
    "::1",
    "2606:2800::1",
  ];
  const script = `
    import { isBlockedAddress } from "@makoai/connector-sdk";
    const test = a => [a, isBlockedAddress(a, { allowLoopback: true })];
    console.log(JSON.stringify({
      blocked: ${JSON.stringify(blocked)}.map(test),
      allowed: ${JSON.stringify(allowed)}.map(test),
    }));
  `;
  const out = inFolder(script);
  for (const [address, isBlocked] of out.blocked) {
    assert.equal(isBlocked, true, address);
  }
  for (const [address, isBlocked] of out.allowed) {
    assert.equal(isBlocked, false, address);
  }
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
  // `search` with a total_count_path, which the in-process connector
  // previewed with a second POST. The folder sends the 3 pages and no
  // preview.
  const counted = ENTITIES.map(e =>
    e.name === "search" ? { ...e, total_count_path: "total" } : e,
  );
  const token = "rest_test_folder_preview_search";
  const folderRun = await readFolder({
    entity: "search",
    maxIterations: 10,
    config: {
      ...testConfig(token, server),
      entities: counted,
      __rate_limit_delay_ms: 1,
    },
  });
  assert.equal(folderRun.rows.length, 30);
  assert.equal(server.requests(token).length, 3);
  assert.deepEqual(server.misses, []);
});
