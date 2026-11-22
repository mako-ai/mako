/**
 * What `SandboxedConnector.fetchEntityChunk` hands a box, and what it does
 * when the box's answer is too big.
 *
 * The box itself is replaced (`run` is the one seam), so these check the
 * adapter alone: the engine's `since` reaches the stream state, the batch
 * size and rate limit reach the config, a chunk over the protocol cap is
 * retried once with a single page instead of failing the same way forever, and
 * a record's own time is its source timestamp.
 *
 * Run: node --import tsx src/connectors/workspace/sandboxed-chunk.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  CHUNK_BYTE_BUDGET,
  CHUNK_GROW_MAX_MS,
  CHUNK_PAGES_MAX_FACTOR,
  SandboxedConnector,
  nextChunkPages,
  readState,
  recordTimestamp,
} from "./SandboxedConnector";
import type { LoadedConnector } from "./resolver";
import {
  ConnectorOutputTooLargeError,
  parseProtocol,
  type ConnectorCommand,
  type RunResult,
} from "./sync-box";

type RunOptions = Parameters<SandboxedConnector["run"]>[1];

const state = (stream_state: Record<string, unknown>, hasMore: boolean) => ({
  type: "STATE",
  state: {
    type: "STREAM",
    stream: { stream_descriptor: { name: "rows" }, stream_state },
    mako: { hasMore },
  },
});

/** A connector whose box is a script: each `read` gets the next answer. */
class ScriptedBox extends SandboxedConnector {
  calls: Array<{ command: ConnectorCommand; options: RunOptions }> = [];
  answers: Array<RunResult | Error> = [];

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "acme",
      runtime: "node",
      entry: "connector.ts",
      sha: "sha",
      sourceSha: "sha",
      spec: {
        mako: {
          entities: {
            rows: { label: "Rows", incremental: "native" },
            other: { label: "Other" },
          },
        },
      },
      entities: ["rows", "other"],
      status: "indexed",
    } as LoadedConnector;
    return this.loaded;
  }

  protected async run(
    command: ConnectorCommand,
    options: RunOptions,
  ): Promise<RunResult> {
    this.calls.push({ command, options: structuredClone(options) });
    const answer = this.answers.shift();
    if (!answer) throw new Error("no scripted answer left");
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

const ok = (messages: RunResult["messages"]): RunResult => ({
  exitCode: 0,
  messages,
  malformed: [],
  stderr: "",
  timedOut: false,
});

const tooLarge = () =>
  new ConnectorOutputTooLargeError("over the byte limit", "bytes");

const make = (settings: Record<string, unknown> = {}) =>
  new ScriptedBox({
    id: "ds",
    name: "Acme",
    type: "ws:acme",
    workspaceId: "ws",
    config: { api_key: "k" },
    settings,
  } as any);

const noop = async () => undefined;

void test("only the acknowledged final source batch logs the driver's sandbox fingerprint", async t => {
  const box = make();
  const onLog = t.mock.fn();
  const message = JSON.stringify({
    type: "RECORD",
    record: { stream: "rows", data: { sandboxId: "untrusted" } },
  });
  const exec = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    durationMs: 1,
    truncated: false,
  };
  const read = (hasMore: boolean, sandboxId?: string) =>
    parseProtocol(
      [message, JSON.stringify(state({}, hasMore))].join("\n"),
      "read",
      { ...exec, sandboxId },
    );
  const options = { entity: "rows", onLog, onBatch: noop };
  box.answers.push(
    read(true, "earlier"),
    read(false),
    read(false, "probe"),
    read(false, "failed"),
    read(false, "last"),
  );
  await box.fetchEntityChunk(options);
  await box.fetchEntityChunk(options);
  await box.fetchEntityChunk({ ...options, singleChunk: true });
  await assert.rejects(
    box.fetchEntityChunk({
      ...options,
      onBatch: async () => {
        throw new Error("batch rejected");
      },
    }),
    /batch rejected/,
  );
  assert.equal(onLog.mock.callCount(), 0);
  await box.fetchEntityChunk(options);
  assert.deepEqual(
    onLog.mock.calls.map(call => call.arguments),
    [
      [
        "info",
        "Read final source batch in sandbox",
        {
          entity: "rows",
          sandboxIdSha256: createHash("sha256").update("last").digest("hex"),
        },
      ],
    ],
  );
});

void test("since reaches the stream state on the first chunk and every later one", async () => {
  const box = make();
  box.answers.push(
    ok([
      state(
        { cursor: "c1", mako: { since: "2026-01-01T00:00:00.000Z" } },
        true,
      ),
    ]),
    ok([state({ cursor: "c2" }, false)]),
  );
  const since = new Date("2026-01-01T00:00:00Z");
  const first = await box.fetchEntityChunk({
    entity: "rows",
    since,
    onBatch: noop,
  });
  await box.fetchEntityChunk({
    entity: "rows",
    since,
    state: first,
    onBatch: noop,
  });

  const [a, b] = box.calls.map(c => c.options.state as any[]);
  assert.deepEqual(a, [
    {
      type: "STREAM",
      stream: {
        stream_descriptor: { name: "rows" },
        stream_state: { mako: { since: "2026-01-01T00:00:00.000Z" } },
      },
    },
  ]);
  // The resumed chunk keeps the connector's cursor AND the engine's since,
  // even though this connector dropped `since` from its own state.
  assert.equal(b[0].stream.stream_state.cursor, "c1");
  assert.equal(b[0].stream.stream_state.mako.since, "2026-01-01T00:00:00.000Z");
});

void test("since given on chunk 1 only still reaches chunk 2, as on a scheduled incremental sync", async () => {
  const box = make();
  // The connector keeps only its cursor; `since` is not in its own state.
  box.answers.push(
    ok([state({ cursor: "c1" }, true)]),
    ok([state({ cursor: "c2" }, true)]),
    ok([state({ cursor: "c3" }, false)]),
  );
  const since = new Date("2026-01-01T00:00:00Z");
  const first = await box.fetchEntityChunk({
    entity: "rows",
    since,
    onBatch: noop,
  });
  // The orchestrator adds its own keys to the metadata between chunks.
  first.metadata = { ...first.metadata, rowsWrittenTotal: 1 };
  const second = await box.fetchEntityChunk({
    entity: "rows",
    state: first,
    onBatch: noop,
  });
  await box.fetchEntityChunk({ entity: "rows", state: second, onBatch: noop });
  for (const call of box.calls) {
    const [entry] = call.options.state as any[];
    assert.equal(
      entry.stream.stream_state.mako.since,
      "2026-01-01T00:00:00.000Z",
    );
  }
  assert.equal(
    (box.calls[2].options.state as any[])[0].stream.stream_state.cursor,
    "c2",
  );
});

void test("since is namespaced, so a connector's own since survives", () => {
  const previous = {
    type: "STREAM",
    stream: { stream_state: { cursor: 1, since: "vendor-token" } },
  };
  const [entry] = readState(
    "rows",
    previous,
    new Date("2026-01-01T00:00:00Z"),
  ) as any[];
  assert.equal(entry.stream.stream_state.since, "vendor-token");
  assert.equal(
    entry.stream.stream_state.mako.since,
    "2026-01-01T00:00:00.000Z",
  );
  assert.throws(
    () =>
      readState(
        "rows",
        { stream: { stream_state: { mako: "mine" } } },
        new Date("2026-01-01T00:00:00Z"),
      ),
    /reserved key `mako`/,
  );
});

void test("no since leaves the state exactly as the connector wrote it", () => {
  const previous = { type: "STREAM", stream: { stream_state: { cursor: 1 } } };
  assert.deepEqual(readState("rows", previous, undefined), [previous]);
  assert.equal(readState("rows", undefined, undefined), undefined);
  assert.equal(readState("rows", undefined, new Date("nope")), undefined);
});

void test("the batch size and rate limit the engine knows reach the box's config", async () => {
  const fromSettings = make({ sync_batch_size: 50, rate_limit_delay_ms: 300 });
  fromSettings.answers.push(ok([state({}, false)]));
  await fromSettings.fetchEntityChunk({ entity: "rows", onBatch: noop });
  assert.deepEqual(fromSettings.calls[0].options.config, {
    api_key: "k",
    __workspace_id: "ws",
    __page_size: 50,
    __rate_limit_delay_ms: 300,
  });

  // Options win over settings, as in-process.
  const fromOptions = make({ sync_batch_size: 50 });
  fromOptions.answers.push(ok([state({}, false)]));
  await fromOptions.fetchEntityChunk({
    entity: "rows",
    batchSize: 2,
    rateLimitDelay: 1,
    onBatch: noop,
  });
  // A batch size the caller asked for is also passed on its own, apart
  // from the connection's setting.
  assert.deepEqual(fromOptions.calls[0].options.config, {
    api_key: "k",
    __workspace_id: "ws",
    __page_size: 2,
    __requested_page_size: 2,
    __rate_limit_delay_ms: 1,
  });

  // Nothing known: nothing added, so the connector's defaults apply.
  const bare = make();
  bare.answers.push(ok([state({}, false)]));
  await bare.fetchEntityChunk({ entity: "rows", onBatch: noop });
  assert.deepEqual(bare.calls[0].options.config, {
    api_key: "k",
    __workspace_id: "ws",
  });

  // The create-time defaults every connection carries are not a choice:
  // they must not override the connector's own defaults.
  const created = make({ sync_batch_size: 100, rate_limit_delay_ms: 200 });
  created.answers.push(ok([state({}, false)]));
  await created.fetchEntityChunk({ entity: "rows", onBatch: noop });
  assert.deepEqual(created.calls[0].options.config, {
    api_key: "k",
    __workspace_id: "ws",
  });
});

void test("a saved connection's id and workspace reach the box's config", async () => {
  const saved = new ScriptedBox({
    _id: "6a0000000000000000000001",
    name: "Acme",
    type: "ws:acme",
    workspaceId: "ws",
    config: { api_key: "k" },
  } as any);
  saved.answers.push(ok([state({}, false)]));
  await saved.fetchEntityChunk({ entity: "rows", onBatch: noop });
  assert.deepEqual(saved.calls[0].options.config, {
    api_key: "k",
    __connection_id: "6a0000000000000000000001",
    __workspace_id: "ws",
  });
});

void test("a chunk asks for at most half the protocol cap", async () => {
  const box = make();
  box.answers.push(ok([state({}, false)]));
  await box.fetchEntityChunk({ entity: "rows", onBatch: noop });
  assert.equal(box.calls[0].options.maxBytes, CHUNK_BYTE_BUDGET);
  assert.equal(box.calls[0].options.maxIterations, 10);
});

void test("a chunk over the cap is retried once with one page, not the same budget", async () => {
  const box = make();
  const logs: string[] = [];
  const rows: unknown[] = [];
  box.answers.push(
    tooLarge(),
    ok([
      { type: "RECORD", record: { stream: "rows", data: { id: 1 } } },
      state({ cursor: "c" }, true),
    ]),
  );
  const result = await box.fetchEntityChunk({
    entity: "rows",
    maxIterations: 10,
    onBatch: async batch => {
      rows.push(...batch);
    },
    onLog: (_level, message) => logs.push(message),
  });
  assert.deepEqual(
    box.calls.map(c => [c.options.maxIterations, c.options.maxBytes]),
    [
      [10, CHUNK_BYTE_BUDGET],
      [1, CHUNK_BYTE_BUDGET],
    ],
  );
  // Every attempt resumes from the same state: nothing was skipped.
  assert.equal(
    new Set(box.calls.map(c => JSON.stringify(c.options.state))).size,
    1,
  );
  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(result.hasMore, true);
  assert.equal(result.iterationsInChunk, 1);
  assert.equal(logs.length, 1);
});

void test("one page over the cap fails with a message that says so", async () => {
  const box = make();
  box.answers.push(tooLarge(), tooLarge());
  await assert.rejects(
    box.fetchEntityChunk({ entity: "rows", maxIterations: 10, onBatch: noop }),
    (error: Error) =>
      // Inngest must not replay a read that can only fail the same way.
      error.name === "NonRetriableError" &&
      /one page of it is over the .*chunk cap/.test(error.message),
  );
  assert.equal(box.calls.length, 2);
});

void test("other failures are not retried", async () => {
  const box = make();
  box.answers.push(new Error("box gone"));
  await assert.rejects(
    box.fetchEntityChunk({ entity: "rows", onBatch: noop }),
    /box gone/,
  );
  assert.equal(box.calls.length, 1);
});

void test("a record's own time is its source timestamp, never now", () => {
  // Stripe: epoch seconds in `created`.
  assert.equal(
    recordTimestamp({ created: 1_700_000_000 })?.toISOString(),
    "2023-11-14T22:13:20.000Z",
  );
  // Milliseconds are read as milliseconds.
  assert.equal(
    recordTimestamp({ created: 1_700_000_000_000 })?.toISOString(),
    "2023-11-14T22:13:20.000Z",
  );
  // Update time before creation time; ISO strings as before.
  assert.equal(
    recordTimestamp({
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    })?.toISOString(),
    "2026-02-01T00:00:00.000Z",
  );
  // A declared cursor field comes first.
  assert.equal(
    recordTimestamp(
      { updated: 1_800_000_000, created: 1_700_000_000 },
      "created",
    )?.toISOString(),
    "2023-11-14T22:13:20.000Z",
  );
  assert.equal(recordTimestamp({ id: "x" }), null);
  // Microseconds are read as microseconds.
  assert.equal(
    recordTimestamp({ created: 1_700_000_000_000_000 })?.toISOString(),
    "2023-11-14T22:13:20.000Z",
  );
  // Outside 1990–2100 is a misread number, not a time.
  assert.equal(recordTimestamp({ created: 42 }), null);
  assert.equal(recordTimestamp({ updated_at: "2150-01-01T00:00:00Z" }), null);
  // Short digit strings are not years or months; long ones are epochs.
  assert.equal(recordTimestamp({ updated_at: "2024" }), null);
  assert.equal(recordTimestamp({ updated_at: "7" }), null);
  assert.equal(
    recordTimestamp({ updated_at: "1700000000" })?.toISOString(),
    "2023-11-14T22:13:20.000Z",
  );
  assert.equal(recordTimestamp({ updated_at: "soon" }), null);
  assert.equal(
    recordTimestamp({
      updated_at: "Tue, 14 Nov 2023 22:13:20 GMT",
    })?.toISOString(),
    "2023-11-14T22:13:20.000Z",
  );

  const box = make();
  const normalized = box.normalizeBackfillRecord("rows", {
    id: "r1",
    created: 1_700_000_000,
  });
  assert.equal(normalized?.sourceTs.toISOString(), "2023-11-14T22:13:20.000Z");
});

void test("only entities that declare what they do with since are incremental", async () => {
  const box = make();
  await box.loadDefinition();
  assert.deepEqual(box.getIncrementalCapabilities(), {
    supported: true,
    mode: "none",
    perEntity: { rows: { mode: "native" }, other: { mode: "none" } },
  });
});

void test("a user's own __ keys never reach the box: Mako's keys are Mako's", async () => {
  // Saved, typed into an unsaved test, or passed to a probe: the same config.
  const forged = new ScriptedBox({
    _id: "6a0000000000000000000002",
    name: "Acme",
    type: "ws:acme",
    workspaceId: "ws",
    config: {
      api_key: "k",
      __workspace_id: "another-workspace",
      __connection_id: "another-connection",
      __requested_page_size: 100000,
      __page_size: 100000,
      __rate_limit_delay_ms: 0,
      __http: { baseUrl: "http://169.254.169.254" },
    },
  } as any);
  forged.answers.push(ok([state({}, false)]));
  await forged.fetchEntityChunk({
    entity: "rows",
    singleChunk: true,
    onBatch: noop,
  } as any);
  assert.deepEqual(forged.calls[0].options.config, {
    api_key: "k",
    __connection_id: "6a0000000000000000000002",
    __workspace_id: "ws",
  });

  // A probe's batch size is the caller's, never the config's.
  const probed = new ScriptedBox({
    name: "Acme",
    type: "ws:acme",
    workspaceId: "ws",
    config: { api_key: "k", __requested_page_size: 5000 },
  } as any);
  probed.answers.push(ok([state({}, false)]));
  await probed.fetchEntityChunk({
    entity: "rows",
    batchSize: 10,
    singleChunk: true,
    onBatch: noop,
  } as any);
  assert.deepEqual(probed.calls[0].options.config, {
    api_key: "k",
    __workspace_id: "ws",
    __page_size: 10,
    __requested_page_size: 10,
  });
});

const record = (data: unknown) => ({
  type: "RECORD",
  record: { stream: "rows", data },
});

void test("the page cap doubles while chunks use little of the byte budget, up to its factor", () => {
  const small = 1024 * 1024;
  assert.equal(nextChunkPages(10, 10, small, true, 5_000), 20);
  assert.equal(nextChunkPages(10, 40, small, true, 5_000), 80);
  assert.equal(
    nextChunkPages(10, 80, small, true, 5_000),
    10 * CHUNK_PAGES_MAX_FACTOR,
  );
  // The last chunk of an entity, or one that ended early: no growth.
  assert.equal(nextChunkPages(10, 20, small, false, 5_000), 20);
  // A quarter of the budget or more: kept.
  assert.equal(nextChunkPages(10, 40, CHUNK_BYTE_BUDGET / 4, true, 5_000), 40);
  // The budget reached, or a slow chunk: halved, never below the base.
  assert.equal(nextChunkPages(10, 40, CHUNK_BYTE_BUDGET, true, 5_000), 20);
  assert.equal(nextChunkPages(10, 40, small, true, CHUNK_GROW_MAX_MS + 1), 20);
  assert.equal(nextChunkPages(10, 10, CHUNK_BYTE_BUDGET, true, 5_000), 10);
});

void test("a chunk of small pages asks the next chunk for twice the pages", async () => {
  const box = make();
  box.answers.push(
    ok([record({ id: 1 }), state({ cursor: "c1" }, true)]),
    ok([record({ id: 2 }), state({ cursor: "c2" }, true)]),
    ok([record({ id: 3 }), state({ cursor: "c3" }, false)]),
  );
  const first = await box.fetchEntityChunk({
    entity: "rows",
    onBatch: noop,
    maxIterations: 10,
  });
  assert.equal(first.chunkPages, 20);
  const second = await box.fetchEntityChunk({
    entity: "rows",
    state: JSON.parse(JSON.stringify(first)),
    onBatch: noop,
    maxIterations: 10,
  });
  assert.equal(second.chunkPages, 40);
  const third = await box.fetchEntityChunk({
    entity: "rows",
    state: second,
    onBatch: noop,
    maxIterations: 10,
  });
  assert.deepEqual(
    box.calls.map(c => c.options.maxIterations),
    [10, 20, 40],
  );
  // The byte budget is unchanged: it still ends every chunk.
  assert.ok(box.calls.every(c => c.options.maxBytes === CHUNK_BYTE_BUDGET));
  // The last chunk carries no cap forward.
  assert.equal(third.chunkPages, undefined);
});

void test("a carried page cap never passes its factor, and an over-cap retry reads one page", async () => {
  const box = make();
  box.answers.push(
    tooLarge(),
    ok([record({ id: 1 }), state({ cursor: "c1" }, true)]),
  );
  const next = await box.fetchEntityChunk({
    entity: "rows",
    state: {
      totalProcessed: 0,
      hasMore: true,
      iterationsInChunk: 10,
      chunkPages: 10_000,
    },
    onBatch: noop,
    maxIterations: 10,
  });
  assert.deepEqual(
    box.calls.map(c => c.options.maxIterations),
    [10 * CHUNK_PAGES_MAX_FACTOR, 1],
  );
  // After a one-page retry the cap starts again from the engine's.
  assert.equal(next.chunkPages, undefined);
});
