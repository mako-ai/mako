/**
 * The boxed Stripe connector folder read against its golden files, through
 * `SandboxedConnector` (the adapter the box path uses) and through a read
 * session: every read gives the golden rows, chunks and requests, and every
 * row's source timestamp is Stripe's `created`. Split from
 * stripe-folder.test.ts so the two files run in parallel; see that file for
 * the folder, the cassettes and the golden files.
 *
 * Run: node --import tsx --test src/connectors/stripe-folder-reads.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SandboxedConnector } from "./workspace/SandboxedConnector";
import type { ConnectorCommand, RunResult } from "./workspace/sync-box";
import { LocalSessionTransport } from "./workspace/test-support/local-session";
import {
  FOLDER,
  RUNNER,
  SCENARIOS,
  canonicalJson,
  ensureFolderInstalled,
  readBoxed,
  runFolderCommand,
  sourceTimestamps,
  startReplayServer,
  type ReplayServer,
  type StripeTestConfig,
} from "../../../connectors/stripe/fixtures/harness.mjs";
import { BoxlessStripe, makeBoxed } from "./stripe-folder-boxless";

/** golden.mjs has a top-level await, so it loads at run time. */
const loadGolden = () =>
  import("../../../connectors/stripe/fixtures/golden.mjs");

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
let entities: string[] = [];

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  const discover = await runFolderCommand("discover", {
    config: { api_key: "sk_test_schema" },
  });
  entities = (
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? []
  ).map((s: Record<string, any>) => s.name);
  BoxlessStripe.spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
});

after(async () => {
  await server?.close();
});

/** A golden file, parsed. */
const golden = async (file: string) => {
  const { GOLDEN_DIR } = await loadGolden();
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, file), "utf8"));
};

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
