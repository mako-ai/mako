/**
 * The GraphQL connector folder (`connectors/graphql/`), run as production
 * runs it: through `SandboxedConnector`, with only the box replaced by a
 * local process, and again through a read session.
 *
 * The in-process connector this folder was ported from is deleted. The rows
 * it produced are the golden files in `connectors/graphql/fixtures/golden/`
 * (compared byte for byte by `workspace/graphql-folder-golden.test.ts`).
 * These tests cover what the golden rows cannot: the entity list, the forms,
 * `check`, the adapter and session paths, retries, and the address policy
 * (a redirect, a rebound DNS name, every spelling of a private address).
 *
 * Run: node --import tsx --test src/connectors/graphql-folder.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
  FLOW_QUERIES,
  FOLDER,
  RATE_LIMIT_SCENARIO,
  RUNNER,
  SCENARIOS,
  WORKSPACE_ID,
  ensureFolderInstalled,
  readFolder,
  runFolderCommand,
  scenarioConfig,
  startReplayServer,
  testConfig,
  tokenFor,
  type ReplayServer,
} from "../../../connectors/graphql/fixtures/harness.mjs";

const GOLDEN_DIR = path.join(FOLDER, "fixtures/golden");
const ENTITIES = FLOW_QUERIES.map(query => query.name);
const goldenFile = (scenario: string, entity: string) =>
  path.join(GOLDEN_DIR, scenario, `${entity}.json`);

/** The folder as a workspace connector; only the box is a local process. */
class BoxlessGraphql extends SandboxedConnector {
  static spec: Record<string, any> | undefined;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "graphql",
      runtime: "node",
      entry: "connector.ts",
      sha: "fixture",
      sourceSha: "fixture",
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
    name: "GraphQL fixture",
    type: "ws:graphql",
    workspaceId: WORKSPACE_ID,
    config,
  } as any);
  // As the registry hands one out: the index row loaded.
  void connector.loadDefinition();
  return connector;
};

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

/** What the engine does: schema, then chunks until `hasMore` is false. */
async function readThrough(
  connector: BoxlessGraphql,
  options: { entity: string; maxIterations: number; since?: string },
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  await connector.resolveSchema?.(options.entity);
  let state: any;
  for (let chunk = 0; chunk < 1000; chunk++) {
    state = await connector.fetchEntityChunk({
      entity: options.entity,
      since: options.since ? new Date(options.since) : undefined,
      maxIterations: options.maxIterations,
      rateLimitDelay: 1,
      state,
      onBatch: async (batch: Array<Record<string, unknown>>) => {
        rows.push(...batch);
      },
      onProgress: () => {},
    } as any);
    if (!state.hasMore) break;
  }
  return rows;
}

const goldenRows = (scenario: string, entity: string) =>
  JSON.parse(fs.readFileSync(goldenFile(scenario, entity), "utf8")).rows;

/** Compare as JSON: the golden files are JSON, a row may carry `undefined`. */
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value));

void test("connector.yaml is a node folder with its entry", () => {
  const parsed = parseConnectorFile(
    fs.readFileSync(path.join(FOLDER, "connector.yaml"), "utf8"),
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.equal(parsed.value.runtime, "node");
  assert.equal(parsed.value.entry, "connector.ts");
});

void test("one entity per flow query, in the flow's order", async () => {
  const box = boxed(BoxlessGraphql, CONFIG);
  await box.loadDefinition();
  assert.deepEqual(box.getAvailableEntities(), ENTITIES);
  assert.equal(ENTITIES.length, 5);
  // A connection with no flow queries offers no entity.
  const bare = boxed(BoxlessGraphql, { endpoint: CONFIG.endpoint });
  await bare.loadDefinition();
  assert.deepEqual(bare.getAvailableEntities(), []);
  // The spec declares no fixed entity: the index holds none.
  assert.deepEqual(spec?.mako?.entities, {});
  assert.equal(spec?.mako?.queryEntities?.source, "flow");
});

void test("the credential form and the flow query form", () => {
  const form = specToForm(spec);
  assert.deepEqual(
    form.fields.map(f => [f.name, f.type, Boolean(f.required)]),
    [
      ["endpoint", "string", true],
      ["headers", "textarea", false],
    ],
  );
  const headers = form.fields.find(f => f.name === "headers");
  assert.equal(headers?.encrypted, true);
  assert.equal(
    form.fields.find(f => f.name === "endpoint")?.encrypted,
    undefined,
  );
  assert.equal(form.transferQueries?.label, "GraphQL Queries");
  assert.equal(form.transferQueries?.required, true);
  assert.deepEqual(
    form.transferQueries?.fields?.map(f => [
      f.name,
      f.type,
      Boolean(f.required),
    ]),
    [
      ["name", "string", true],
      ["query", "textarea", true],
      ["data_path", "string", true],
      ["total_count_path", "string", false],
      ["has_next_page_path", "string", false],
      ["cursor_path", "string", false],
      ["batch_size", "number", false],
    ],
  );
});

void test("incremental capability: a client filter, before any query exists", async () => {
  const bare = boxed(BoxlessGraphql, { endpoint: CONFIG.endpoint });
  await bare.loadDefinition();
  assert.equal(bare.getIncrementalCapabilities().supported, true);
  assert.equal(bare.getIncrementalCapabilities().mode, "client-filter");
  const box = boxed(BoxlessGraphql, CONFIG);
  await box.loadDefinition();
  for (const entity of ENTITIES) {
    assert.equal(
      box.getIncrementalCapabilities().perEntity?.[entity]?.mode,
      "client-filter",
      entity,
    );
  }
});

void test("no schema: rows land as they come, typed by the destination", async () => {
  const box = boxed(BoxlessGraphql, CONFIG);
  await box.loadDefinition();
  for (const entity of ENTITIES) {
    assert.equal(await box.resolveSchema(entity), null, entity);
    assert.equal(await box.declaresUntypedSchema(entity), true, entity);
    // The engine accepts the null: the catalog says the stream is untyped.
    assert.equal(
      await resolveEntitySchema({
        entity,
        workspaceId: WORKSPACE_ID,
        connector: box,
        sourceConnection: { type: "ws:graphql" },
        context: "fixture",
      }),
      null,
    );
  }
});

void test("check passes on a valid endpoint and fails on GraphQL errors, a 401 and bad headers", async () => {
  const outcome = async (variant: string, headers?: string) => {
    const token = `gql_test_folder_check_${variant}${variant === "valid" ? "" : `_${variant}`}`;
    const { queries: _queries, ...connection } = testConfig(token, server);
    const run = await runFolderCommand("check", {
      config: headers === undefined ? connection : { ...connection, headers },
    });
    const status = run.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    return [variant, status?.status, server.requests(token).length];
  };
  assert.deepEqual(
    [
      await outcome("valid"),
      await outcome("errors"),
      await outcome("revoked"),
      await outcome("bad-headers", "{not json"),
    ],
    [
      ["valid", "SUCCEEDED", 1],
      ["errors", "FAILED", 1],
      ["revoked", "FAILED", 1],
      ["bad-headers", "FAILED", 0],
    ],
  );
});

void test("a read through the adapter gives the golden rows, default and incremental", async () => {
  const run = async (scenarioName: string) => {
    const scenario = SCENARIOS.find(s => s.name === scenarioName)!;
    for (const entity of ENTITIES) {
      const token = tokenFor("adapter", scenario, entity);
      const config = testConfig(token, server, scenario);
      const box = boxed(
        BoxlessGraphql,
        config as unknown as Record<string, unknown>,
      );
      const rows = await readThrough(box, {
        entity,
        since: scenario.since,
        maxIterations: scenario.maxIterations,
      });
      assert.deepEqual(
        asJson(rows),
        goldenRows(scenarioName, entity),
        `${scenarioName}/${entity}`,
      );
    }
  };
  await run("default");
  await run("since");
  assert.deepEqual(server.misses, []);
});

void test("a read session gives the golden rows and starts and closes once per read", async () => {
  const own = await startReplayServer();
  try {
    const scenario = SCENARIOS.find(s => s.name === "chunked")!;
    for (const entity of ENTITIES) {
      const token = tokenFor("session", scenario, entity);
      const config = testConfig(token, own, scenario);
      const box = boxed(
        SessionGraphql,
        config as unknown as Record<string, unknown>,
      );
      const rows = await readThrough(box, {
        entity,
        maxIterations: scenario.maxIterations,
      });
      assert.deepEqual(asJson(rows), goldenRows("chunked", entity), entity);
    }
    assert.deepEqual(own.misses, []);
    assert.equal(SessionGraphql.chunkReads, 0);
    const calls = SessionGraphql.transports.flatMap(t => t.calls);
    assert.equal(calls.filter(c => c === "start").length, ENTITIES.length);
    assert.equal(calls.filter(c => c === "close").length, ENTITIES.length);
  } finally {
    await own.close();
  }
});

void test("a 429 then a 503 before the first page are retried, and the rows are the default rows", async () => {
  for (const entity of ENTITIES) {
    const token = tokenFor("folder", RATE_LIMIT_SCENARIO, entity);
    const { rows } = await readFolder({
      entity,
      maxIterations: RATE_LIMIT_SCENARIO.maxIterations,
      config: scenarioConfig(token, server, RATE_LIMIT_SCENARIO),
    });
    assert.deepEqual(asJson(rows), goldenRows("default", entity), entity);
    const requests = server.requestKeys(token);
    const unique = new Set(requests);
    assert.ok(requests.length > unique.size, `${entity}: first page retried`);
  }
});

void test("the cassettes hold no credential", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /gql_test_|Bearer |admin-secret/i, file);
  }
  assert.ok(fs.existsSync(GOLDEN_DIR));
});

void test("the endpoint check refuses metadata names and private IPs in any spelling", async () => {
  // Through `check`, as a box runs it: the refusal comes before any request.
  const status = async (endpoint: string) =>
    (await runFolderCommand("check", { config: { endpoint } })).messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
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
  // A public name passes the check and fails later, on the network.
  const open = await status("http://[2606:2800::1]:9/graphql");
  assert.doesNotMatch(open?.message ?? "", /private or metadata address/);
});

void test("an unknown query entity fails the read, even with no query at all", async () => {
  // The box must not answer 0 rows (a probe on a connection with no flow).
  for (const config of [
    { endpoint: CONFIG.endpoint },
    { ...CONFIG, queries: FLOW_QUERIES.slice(0, 1) },
  ]) {
    const box = boxed(BoxlessGraphql, config);
    await assert.rejects(
      box.fetchEntityChunk({
        entity: "no_such_query",
        maxIterations: 1,
        singleChunk: true,
        onBatch: async () => {},
      } as any),
      /has no entity "no_such_query"/,
    );
  }
});

void test("a redirect is refused once, never followed or retried", async () => {
  const token = "gql_test_folder_check_redirect";
  const { queries: _queries, ...connection } = testConfig(token, server);
  const result = await runFolderCommand("check", { config: connection });
  const status = result.messages.find(m => m.type === "CONNECTION_STATUS");
  assert.equal(status?.connectionStatus?.status, "FAILED");
  assert.match(status?.connectionStatus?.message ?? "", /redirect/);
  assert.equal(server.requests(token).length, 1);
});

void test("a credentialed or query URL never appears in an error", async () => {
  const status = async (endpoint: string) =>
    (await runFolderCommand("check", { config: { endpoint } })).messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
  for (const endpoint of [
    "https://user:s3cret@api.x.com/graphql?token=Q",
    "ftp://user:s3cret@api.x.com/graphql?token=Q",
    "http://user:s3cret@169.254.169.254/graphql?token=Q",
    "not a url s3cret?token=Q",
  ]) {
    const result = await status(endpoint);
    assert.equal(result?.status, "FAILED", endpoint);
    const message = result?.message ?? "";
    for (const secret of ["s3cret", "token=Q", "user:"]) {
      assert.ok(!message.includes(secret), `${endpoint}: ${message}`);
    }
  }
  assert.match(
    (await status("https://user:s3cret@api.x.com/graphql"))?.message ?? "",
    /credentials/,
  );
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
  // separate guard would see) and the target below on every later one.
  const script = `
    import http from "node:http";
    import { GraphqlClient } from ${JSON.stringify(path.join(FOLDER, "client.ts"))};
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { ok: 1 } }));
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
      const client = new GraphqlClient(
        { endpoint: "http://rebind.example.test:" + port + "/graphql", headers: { "x-hasura-admin-secret": "S3CRET" } },
        () => {},
        resolve,
      );
      try {
        await client.post({ query: "{ a }" });
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

void test("the address policy: public unicast and loopback pass, everything else is blocked", () => {
  const blocked = [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "fe80::1",
    "fec0::1",
    "fd00::1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1",
    "100::1",
    "2002:a9fe:a9fe::",
    "2002:a00:1::",
    "::ffff:0:a9fe:a9fe",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "2001:db8::1",
    "2001::1",
    "::a9fe:a9fe",
  ];
  const allowed = [
    "1.1.1.1",
    "93.184.216.34",
    "127.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "2606:2800::1",
    "::ffff:93.184.216.34",
  ];
  const endpoints = [
    // Decimal, octal and hex spellings of 169.254.169.254 and 10.0.0.1.
    "http://2852039166/",
    "http://0251.0376.0251.0376/",
    "http://0xa9fea9fe/",
    "http://167772161/",
    "http://012.0.0.1/",
    "http://0xa000001/",
    "http://metadata.google.internal/",
    "http://[::ffff:169.254.169.254]/",
  ];
  const script = `
    import { addressBlocked, checkEndpoint } from ${JSON.stringify(path.join(FOLDER, "client.ts"))};
    const refuses = url => { try { checkEndpoint(url); return false; } catch { return true; } };
    console.log(JSON.stringify({
      blocked: ${JSON.stringify(blocked)}.map(a => [a, addressBlocked(a)]),
      allowed: ${JSON.stringify(allowed)}.map(a => [a, addressBlocked(a)]),
      endpoints: ${JSON.stringify(endpoints)}.map(u => [u, refuses(u)]),
    }));
  `;
  const out = inFolder(script);
  for (const [address, isBlocked] of out.blocked) {
    assert.equal(isBlocked, true, address);
  }
  for (const [address, isBlocked] of out.allowed) {
    assert.equal(isBlocked, false, address);
  }
  for (const [url, refused] of out.endpoints) assert.equal(refused, true, url);
});

// The scenario list is part of the contract with golden.mjs.
void test("the golden scenarios exist in the harness", () => {
  for (const name of ["default", "since", "chunked"]) {
    assert.ok(
      SCENARIOS.some(s => s.name === name),
      name,
    );
  }
  assert.ok(RATE_LIMIT_SCENARIO.rateLimited);
});
