/**
 * The boxed Stripe connector folder (`connectors/stripe/`): checks that hold
 * the folder to itself, kept after the in-process connector was removed.
 *
 * - the folder is a node connector with 26 entities, each with a label;
 * - the folder reads the replay cassettes into 105 golden files, byte for
 *   byte: 26 entities in 4 scenarios (one page per chunk, two-row pages, the
 *   default chunk, incremental `since`) and the outcome of 94 webhook
 *   events (rewrite them, after an intended change, with
 *   `node connectors/stripe/fixtures/golden.mjs --write`; rebuild the
 *   cassettes with `--record`);
 * - through `SandboxedConnector`, the adapter the box path uses, and through
 *   a read session, every read gives the golden rows, chunks and requests,
 *   and every row's source timestamp is Stripe's `created`;
 * - the schemas carry Mako's 8 system columns, every entity is partitioned
 *   by day of sync, and 25 of 26 read incrementally from `created`;
 * - `check` accepts a valid key and refuses a revoked one;
 * - the cassettes hold no key or signing secret.
 *
 * The folder runs through `SandboxedConnector` with only the box replaced by
 * a local process (`BoxlessStripe`). `since`, the page size, the rate limit
 * and the source timestamp therefore cross the same code a production box
 * run does.
 *
 * The harness lives with the folder: connectors/stripe/fixtures/harness.mjs.
 * Sits at the top of api/src/connectors, not in a stripe/ folder, which the
 * connector family boundary guard would treat as a family.
 *
 * Run: node --import tsx --test src/connectors/stripe-folder.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MAKO_SYSTEM_FIELDS } from "./base/BaseConnector";
import { SandboxedConnector } from "./workspace/SandboxedConnector";
import type { LoadedConnector } from "./workspace/resolver";
import type { ConnectorCommand, RunResult } from "./workspace/sync-box";
import { parseConnectorFile } from "./workspace/connector-file";
import { connectionSpecificationToForm } from "./workspace/spec-translation";
import { LocalSessionTransport } from "./workspace/test-support/local-session";
import {
  CASSETTE_DIR,
  FOLDER,
  RUNNER,
  SCENARIOS,
  SINCE,
  canonicalJson,
  ensureFolderInstalled,
  readBoxed,
  runFolderCommand,
  sourceTimestamps,
  startReplayServer,
  type ReplayServer,
  type StripeTestConfig,
} from "../../../connectors/stripe/fixtures/harness.mjs";

/** golden.mjs has a top-level await, so it loads at run time. */
const loadGolden = () =>
  import("../../../connectors/stripe/fixtures/golden.mjs");

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
      sha: "golden",
      sourceSha: "golden",
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
    id: "ds_golden",
    name: "Stripe golden",
    type: "ws:stripe",
    workspaceId: "ws_golden",
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
    id: "ds_golden",
    name: "Stripe golden",
    type: "ws:stripe",
    workspaceId: "ws_golden",
    config,
  } as any);

let server: ReplayServer;
let streams: Array<Record<string, any>> = [];
let spec: Record<string, any> | undefined;
let entities: string[] = [];

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  const discover = await runFolderCommand("discover", {
    config: { api_key: "sk_test_schema" },
  });
  streams =
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
  entities = streams.map(s => s.name);
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  BoxlessStripe.spec = spec;
});

after(async () => {
  await server?.close();
});

/** A golden file, parsed. */
const golden = async (file: string) => {
  const { GOLDEN_DIR } = await loadGolden();
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, file), "utf8"));
};

/** Every file under golden/, as paths relative to it. */
function goldenFiles(dir: string, prefix = ""): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(entry =>
      entry.isDirectory()
        ? goldenFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    );
}

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
      path.resolve(__dirname, "../../node_modules/stripe/package.json"),
      "utf8",
    ),
  ).version;
  assert.equal(folderPackage.dependencies.stripe, apiStripe);
  assert.equal(lock.packages["node_modules/stripe"].version, apiStripe);
});

void test("26 entities, each with a label and its golden files", async () => {
  const { GOLDEN_DIR, goldenFile } = await loadGolden();
  assert.equal(entities.length, 26);
  for (const name of entities) {
    assert.ok(spec?.mako?.entities?.[name]?.label, `${name} has a label`);
  }
  assert.deepEqual(
    goldenFiles(GOLDEN_DIR).sort(),
    [
      ...SCENARIOS.flatMap(s => entities.map(e => goldenFile(s.name, e))),
      "webhooks.json",
    ].sort(),
  );
});

void test("the folder reads the cassettes into the golden files, byte for byte", async () => {
  const { GOLDEN_DIR, buildGolden } = await loadGolden();
  const actual = await buildGolden();
  assert.equal(Object.keys(actual).length, 26 * 4 + 1);
  for (const [file, text] of Object.entries(actual)) {
    const expected = fs.readFileSync(path.join(GOLDEN_DIR, file), "utf8");
    assert.equal(
      text,
      expected,
      `${file} differs from fixtures/golden/${file}`,
    );
  }
});

void test("the golden reads cross pages, chunks and child lists", async () => {
  const chunked = (entity: string) => golden(`chunked/${entity}.json`);
  assert.equal((await chunked("customers")).chunks.length, 2);
  assert.equal((await chunked("payout_balance_transactions")).rowCount, 212);
  assert.equal((await chunked("customer_balance_transactions")).rowCount, 126);
  assert.equal((await chunked("setup_intents")).rowCount, 0);
  for (const entity of entities) {
    const full = await golden(`default/${entity}.json`);
    const one = await chunked(entity);
    const small = await golden(`small-pages/${entity}.json`);
    // The same rows, however the read is cut.
    assert.equal(one.rowCount, full.rows.length, entity);
    assert.equal(small.rowCount, full.rows.length, entity);
    assert.equal(one.chunks.at(-1).hasMore, false, entity);
    // Two rows a page: every entity with 3 rows or more resumes from a cursor.
    if (small.rowCount >= 3) {
      assert.ok(small.chunks.length >= 2, `${entity} never resumed`);
    }
    // `since` sends `created[gte]` and keeps no row created before it.
    const since = await golden(`since/${entity}.json`);
    assert.ok(since.rows.length <= full.rows.length, entity);
  }
  const since = await golden("since/customers.json");
  assert.ok(since.rows.length > 0);
  assert.ok(
    since.requests.every((r: string) =>
      r.includes(`created[gte]=${Date.parse(SINCE) / 1000}`),
    ),
    since.requests.join("\n"),
  );
});

void test("the config form is the key and the base URL", () => {
  const form = connectionSpecificationToForm(spec?.connectionSpecification);
  assert.deepEqual(
    form.fields.map((f: { name: string }) => f.name),
    ["api_key", "api_base_url"],
  );
  assert.deepEqual(spec?.connectionSpecification?.required, ["api_key"]);
});

void test("every schema carries the 8 system columns, through the box", async () => {
  const system = Object.keys(MAKO_SYSTEM_FIELDS);
  assert.equal(system.length, 8);
  const boxed = makeBoxed({ api_key: "sk_test_schema", api_base_url: "" });
  for (const entity of entities) {
    const schema: any = await boxed.resolveSchema(entity);
    for (const name of system) {
      assert.equal(
        canonicalJson(schema.fields[name]),
        canonicalJson((MAKO_SYSTEM_FIELDS as Record<string, unknown>)[name]),
        `${entity}.${name}`,
      );
    }
  }
});

void test("every entity is partitioned by day of sync; all but one read incrementally from created", async () => {
  const boxed = makeBoxed({ api_key: "sk_test_list", api_base_url: "" });
  await boxed.loadDefinition();
  const metadata = boxed.getEntityMetadata();
  assert.equal(metadata.length, 26);
  for (const e of metadata) {
    assert.deepEqual(
      e.layoutSuggestion,
      {
        partitionField: "_syncedAt",
        partitionGranularity: "day",
        clusterFields: ["_dataSourceId", "id"],
      },
      e.name,
    );
  }
  const caps = boxed.getIncrementalCapabilities();
  assert.equal(caps.supported, true);
  // Customer balance transactions walk every customer: no incremental mode.
  for (const entity of entities) {
    assert.equal(
      caps.perEntity?.[entity]?.mode ?? caps.mode,
      entity === "customer_balance_transactions" ? "none" : "created-anchor",
      entity,
    );
  }
});

void test("check accepts a valid key and refuses a revoked one", async () => {
  const statusOf = async (apiKey: string) =>
    (
      await runFolderCommand("check", {
        config: { api_key: apiKey, api_base_url: server.url },
      })
    ).messages.find(m => m.type === "CONNECTION_STATUS")?.connectionStatus;
  assert.equal((await statusOf("sk_test_check"))?.status, "SUCCEEDED");
  assert.equal((await statusOf("sk_test_check_revoked"))?.status, "FAILED");
  assert.deepEqual(server.requests("sk_test_check"), [
    "GET /v1/account (Stripe-Version 2023-10-16)",
  ]);
});

/**
 * Read every entity in every scenario through `make`, and compare each read
 * with its golden file: the rows (by checksum), the chunk states and the
 * requests. Returns the failures and the row count read.
 */
async function readAgainstGolden(
  make: (config: StripeTestConfig) => BoxlessStripe,
  replay: ReplayServer,
) {
  const { rowsSha256 } = await loadGolden();
  const failures: string[] = [];
  let rowsRead = 0;
  const jobs = SCENARIOS.flatMap(scenario =>
    entities.map(entity => ({ scenario, entity })),
  );
  const work = async ({ scenario, entity }: (typeof jobs)[number]) => {
    const key = `${scenario.name}/${entity}`;
    const apiKey = `sk_test_box_${scenario.name}_${entity}`;
    const connector = make({ api_key: apiKey, api_base_url: replay.url });
    const run = await readBoxed(connector, {
      entity,
      since: scenario.since,
      maxIterations: scenario.maxIterations,
      pageSize: scenario.pageSize,
    });
    const expected = await golden(`${key}.json`);
    const rows = JSON.parse(JSON.stringify(run.rows));
    const sha = expected.rowsSha256 ?? rowsSha256(expected.rows);
    if (rowsSha256(rows) !== sha) failures.push(`${key}: rows`);
    if (
      expected.chunks &&
      canonicalJson(run.chunks) !== canonicalJson(expected.chunks)
    ) {
      failures.push(`${key}: chunks`);
    }
    if (
      canonicalJson(replay.requests(apiKey)) !==
      canonicalJson(expected.requests)
    ) {
      failures.push(`${key}: requests`);
    }
    const timestamps = sourceTimestamps(connector, entity, run.rows);
    if (timestamps.fellBackToNow > 0) {
      failures.push(`${key}: ${timestamps.fellBackToNow} timestamps are now`);
    }
    rowsRead += run.rows.length;
  };
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length > 0) await work(queue.shift()!);
    }),
  );
  return { failures, rowsRead, runs: jobs.length };
}

void test("the box path reads the golden rows, chunks, requests and timestamps", async () => {
  const { failures, rowsRead, runs } = await readAgainstGolden(
    makeBoxed,
    server,
  );
  assert.equal(runs, 26 * 4);
  assert.deepEqual(failures, []);
  assert.ok(rowsRead > 0);
  assert.deepEqual(server.misses, []);
});

void test("a read session reads the golden rows, chunks, requests and timestamps", async () => {
  // A server of its own: request logs are per key, and the keys repeat.
  const own = await startReplayServer();
  try {
    const { failures, runs } = await readAgainstGolden(makeSession, own);
    assert.deepEqual(failures, []);
    assert.deepEqual(own.misses, []);
    // Every read went through a session, one per entity read, and every
    // session was closed at the end of its read.
    assert.equal(SessionStripe.chunkReads, 0);
    const calls = SessionStripe.transports.flatMap(t => t.calls);
    assert.equal(calls.filter(c => c === "start").length, runs);
    assert.equal(calls.filter(c => c === "close").length, runs);
    assert.ok(calls.filter(c => c.startsWith("pull")).length > 0);
    assert.deepEqual(
      SessionStripe.transports.map(t => t.open()),
      SessionStripe.transports.map(() => 0),
    );
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

void test("the cassettes hold no key or signing secret", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /\b(sk|rk)_(live|test)_|whsec_/, file);
  }
});
