/**
 * `SandboxedConnector.fetchEntityChunk` through a read session, with the
 * session replaced by a script (`sessionTransport` is the seam).
 *
 * What it pins down: which batch each chunk asks for (a retry asks for the
 * same one, never the next), what a lost session restarts from (the last
 * applied state), when the session is closed, and the fallbacks to chunk
 * processes (an old runner, a batch over the cap).
 *
 * Run: node --import tsx src/connectors/workspace/sandboxed-session.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  CHUNK_BYTE_BUDGET,
  MAKO_SESSION_KEY,
  SandboxedConnector,
} from "./SandboxedConnector";
import type { LoadedConnector } from "./resolver";
import type {
  PullOutcome,
  ReadSessionTransport,
  SessionHandle,
  SessionStart,
} from "./session-read";
import type { ConnectorCommand, RunResult } from "./sync-box";

const ID = "0123456789abcdef";

const stateMessage = (cursor: string, hasMore: boolean) => ({
  type: "STATE",
  state: {
    type: "STREAM",
    stream: {
      stream_descriptor: { name: "rows" },
      stream_state: { cursor },
    },
    mako: { hasMore },
  },
});

const batch = (
  seq: number,
  rows: number[],
  cursor: string,
  hasMore: boolean,
): PullOutcome => ({
  kind: "batch",
  seq,
  result: ok([
    ...rows.map(id => ({
      type: "RECORD",
      record: { stream: "rows", data: { id } },
    })),
    stateMessage(cursor, hasMore),
  ]),
});

const ok = (messages: RunResult["messages"], exitCode = 0): RunResult => ({
  exitCode,
  messages,
  malformed: [],
  stderr: "",
  timedOut: false,
});

/** A session whose answers are scripted, recording every call. */
class ScriptedSession implements ReadSessionTransport {
  calls: Array<
    | { op: "start"; input: SessionStart }
    | { op: "pull"; handle: SessionHandle; seq: number }
    | { op: "close"; handle: SessionHandle }
  > = [];
  starts: PullOutcome[] = [];
  pulls: PullOutcome[] = [];

  async start(input: SessionStart) {
    this.calls.push({ op: "start", input: structuredClone(input) });
    const outcome = this.starts.shift();
    if (!outcome) throw new Error("no scripted start left");
    return { handle: { id: ID, box: "box-1" }, outcome };
  }

  async pull(handle: SessionHandle, seq: number) {
    this.calls.push({ op: "pull", handle, seq });
    const outcome = this.pulls.shift();
    if (!outcome) throw new Error("no scripted pull left");
    return outcome;
  }

  async close(handle: SessionHandle) {
    this.calls.push({ op: "close", handle });
  }

  ops() {
    return this.calls.map(c => (c.op === "pull" ? `pull ${c.seq}` : c.op));
  }
}

class SessionBox extends SandboxedConnector {
  session = new ScriptedSession();
  runs: Array<{ command: ConnectorCommand; options: any }> = [];
  runAnswers: RunResult[] = [];
  useSession = true;

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "acme",
      runtime: "node",
      entry: "connector.ts",
      sha: "sha",
      sourceSha: "sha",
      spec: { mako: { entities: { rows: { label: "Rows" } } } },
      entities: ["rows"],
      status: "indexed",
    } as LoadedConnector;
    return this.loaded;
  }

  protected async sessionTransport() {
    return this.useSession ? this.session : null;
  }

  protected async run(command: ConnectorCommand, options: any) {
    this.runs.push({ command, options: structuredClone(options) });
    const answer = this.runAnswers.shift();
    if (!answer) throw new Error("no scripted chunk left");
    return answer;
  }

  /** The production seam, for the flag test. */
  defaultTransport() {
    return SandboxedConnector.prototype["sessionTransport"].call(this);
  }
}

const make = () =>
  new SessionBox({
    id: "ds",
    name: "Acme",
    type: "ws:acme",
    workspaceId: "ws",
    config: { api_key: "k" },
  } as any);

const collect = () => {
  const rows: unknown[] = [];
  return {
    rows,
    onBatch: async (batch: unknown[]) => {
      rows.push(...batch);
    },
  };
};

afterEach(() => {
  delete process.env.CONNECTOR_SESSION_READS;
});

void test("a read takes batch 1, 2, 3 of one session and closes it after the last", async () => {
  const box = make();
  box.session.starts.push(batch(1, [1, 2], "c1", true));
  box.session.pulls.push(batch(2, [3], "c2", true), batch(3, [4], "c3", false));
  const sink = collect();
  const since = new Date("2026-01-01T00:00:00Z");

  const first = await box.fetchEntityChunk({ entity: "rows", since, ...sink });
  assert.deepEqual((first.metadata as any)[MAKO_SESSION_KEY], {
    id: ID,
    box: "box-1",
    seq: 1,
    entity: "rows",
    fp: (first.metadata as any)[MAKO_SESSION_KEY].fp,
  });
  // The orchestrator adds its own keys between chunks.
  first.metadata = { ...(first.metadata as object), rowsWrittenTotal: 2 };
  const second = await box.fetchEntityChunk({
    entity: "rows",
    state: first,
    ...sink,
  });
  assert.equal((second.metadata as any)[MAKO_SESSION_KEY].seq, 2);
  const third = await box.fetchEntityChunk({
    entity: "rows",
    state: second,
    ...sink,
  });

  assert.deepEqual(box.session.ops(), ["start", "pull 2", "pull 3", "close"]);
  assert.deepEqual(sink.rows, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  assert.equal(third.hasMore, false);
  assert.equal(third.totalProcessed, 4);
  assert.equal((third.metadata as any)[MAKO_SESSION_KEY], undefined);
  // The STATE is the connector's, plus the run's since, as a chunk's.
  assert.equal((third.metadata as any).stream.stream_state.cursor, "c3");
  assert.equal((third.metadata as any).makoSince, since.toISOString());

  const [start] = box.session.calls as any[];
  assert.equal(start.input.maxIterations, 10);
  assert.equal(start.input.maxBytes, CHUNK_BYTE_BUDGET);
  assert.equal(start.input.since, since.toISOString());
  assert.deepEqual(start.input.state[0].stream.stream_state, {
    mako: { since: since.toISOString() },
  });
  assert.equal(box.runs.length, 0);
});

void test("a retried chunk asks for the same batch again, never the next one", async () => {
  const box = make();
  box.session.starts.push(batch(1, [1], "c1", true));
  const sink = collect();
  const first = await box.fetchEntityChunk({ entity: "rows", ...sink });

  // The write of batch 2 fails; the engine retries the chunk with the same
  // state, so it asks for batch 2 again, which is still there.
  box.session.pulls.push(batch(2, [2], "c2", true), batch(2, [2], "c2", true));
  let fail = true;
  await assert.rejects(
    box.fetchEntityChunk({
      entity: "rows",
      state: first,
      onBatch: async () => {
        if (fail) throw new Error("warehouse down");
      },
    }),
    /warehouse down/,
  );
  fail = false;
  const second = await box.fetchEntityChunk({
    entity: "rows",
    state: first,
    ...sink,
  });
  assert.deepEqual(box.session.ops(), ["start", "pull 2", "pull 2"]);
  // A failed write does not end the session.
  assert.equal(box.session.calls.filter(c => c.op === "close").length, 0);
  assert.equal((second.metadata as any)[MAKO_SESSION_KEY].seq, 2);
});

void test("a lost session starts again from the last applied state", async () => {
  const box = make();
  box.session.starts.push(
    batch(1, [1], "c1", true),
    batch(1, [2], "c2", false),
  );
  box.session.pulls.push({ kind: "lost", reason: "its box was replaced" });
  const sink = collect();
  const since = new Date("2026-01-01T00:00:00Z");
  const first = await box.fetchEntityChunk({ entity: "rows", since, ...sink });
  first.metadata = { ...(first.metadata as object), rowsWrittenTotal: 1 };
  // A scheduled incremental passes since on the first chunk only.
  const second = await box.fetchEntityChunk({
    entity: "rows",
    state: first,
    ...sink,
  });

  assert.deepEqual(box.session.ops(), ["start", "pull 2", "start", "close"]);
  const restart = (box.session.calls[2] as any).input;
  const [entry] = restart.state;
  // The applied STATE, with since, and without the dead session's handle.
  assert.equal(entry.stream.stream_state.cursor, "c1");
  assert.equal(entry.stream.stream_state.mako.since, since.toISOString());
  assert.equal(entry[MAKO_SESSION_KEY], undefined);
  assert.equal(restart.since, since.toISOString());
  assert.deepEqual(sink.rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(second.hasMore, false);
});

void test("a failed read closes its session, and its retry starts a new one", async () => {
  const box = make();
  box.session.starts.push(batch(1, [1], "c1", true));
  const sink = collect();
  const first = await box.fetchEntityChunk({ entity: "rows", ...sink });
  box.session.pulls.push({
    kind: "batch",
    seq: 2,
    result: ok(
      [
        {
          type: "TRACE",
          trace: { type: "ERROR", error: { message: "401: key revoked" } },
        },
      ],
      1,
    ),
  });
  await assert.rejects(
    box.fetchEntityChunk({ entity: "rows", state: first, ...sink }),
    /read failed for "rows": 401: key revoked/,
  );
  assert.deepEqual(box.session.ops(), ["start", "pull 2", "close"]);
  // Rows of the failed batch were never applied.
  assert.deepEqual(sink.rows, [{ id: 1 }]);
});

void test("a runner without sessions falls back to chunk processes for the rest of the read", async () => {
  const box = make();
  box.session.starts.push({ kind: "unsupported" });
  box.runAnswers.push(
    ok([
      { type: "RECORD", record: { stream: "rows", data: { id: 1 } } },
      stateMessage("c1", true),
    ]),
    ok([stateMessage("c2", false)]),
  );
  const sink = collect();
  const first = await box.fetchEntityChunk({ entity: "rows", ...sink });
  assert.deepEqual((first.metadata as any)[MAKO_SESSION_KEY], {
    unsupported: true,
  });
  await box.fetchEntityChunk({ entity: "rows", state: first, ...sink });
  assert.deepEqual(box.session.ops(), ["start", "close"]);
  assert.equal(box.runs.length, 2);
  // The chunk's own state never carries the session marker to the connector.
  assert.equal(box.runs[1].options.state[0][MAKO_SESSION_KEY], undefined);
  assert.equal(box.runs[1].options.state[0].stream.stream_state.cursor, "c1");
});

void test("a batch over the cap is read as one chunk process of one page", async () => {
  const box = make();
  box.session.starts.push({ kind: "too-large", limit: "bytes" });
  box.runAnswers.push(ok([stateMessage("c1", true)]));
  const logs: string[] = [];
  const state = await box.fetchEntityChunk({
    entity: "rows",
    onBatch: async () => undefined,
    onLog: (_level, message) => logs.push(message),
  });
  assert.deepEqual(box.session.ops(), ["start", "close"]);
  assert.equal(box.runs[0].options.maxIterations, 1);
  assert.equal(state.iterationsInChunk, 1);
  assert.equal(logs.length, 1);
  // The next chunk tries a session again.
  assert.equal((state.metadata as any)[MAKO_SESSION_KEY], undefined);
});

void test("a session that ends before its first batch fails the chunk, never a 0-row success", async () => {
  const box = make();
  box.session.starts.push({
    kind: "lost",
    reason: "the connector exited before batch 1",
  });
  await assert.rejects(
    box.fetchEntityChunk({ entity: "rows", onBatch: async () => undefined }),
    /ended before its first batch/,
  );
  assert.deepEqual(box.session.ops(), ["start", "close"]);
});

void test("another entity's session is never pulled", async () => {
  const box = make();
  box.session.starts.push(batch(1, [1], "c1", false));
  await box.fetchEntityChunk({
    entity: "rows",
    state: {
      totalProcessed: 0,
      hasMore: true,
      iterationsInChunk: 10,
      metadata: {
        [MAKO_SESSION_KEY]: { id: ID, seq: 4, entity: "other" },
      },
    },
    onBatch: async () => undefined,
  });
  assert.deepEqual(box.session.ops(), ["start", "close"]);
});

void test("a session started by a chunk whose write fails is closed, never orphaned", async () => {
  const box = make();
  box.session.starts.push(batch(1, [1], "c1", true));
  await assert.rejects(
    box.fetchEntityChunk({
      entity: "rows",
      onBatch: async () => {
        throw new Error("warehouse down");
      },
    }),
    /warehouse down/,
  );
  assert.deepEqual(box.session.ops(), ["start", "close"]);
});

void test("a probe's single chunk never opens a session", async () => {
  const box = make();
  box.runAnswers.push(ok([stateMessage("c1", true)]));
  const state = await box.fetchEntityChunk({
    entity: "rows",
    maxIterations: 1,
    singleChunk: true,
    onBatch: async () => undefined,
  });
  assert.deepEqual(box.session.ops(), []);
  assert.equal(box.runs.length, 1);
  assert.equal((state.metadata as any)[MAKO_SESSION_KEY], undefined);
});

void test("a connection edited mid-read replaces its session, from the applied state", async () => {
  const box = make();
  box.session.starts.push(
    batch(1, [1], "c1", true),
    batch(1, [2], "c2", false),
  );
  const sink = collect();
  const first = await box.fetchEntityChunk({ entity: "rows", ...sink });
  // A new key: the config the next chunk would send differs.
  (box as any).sourceConnection.config = { api_key: "rotated" };
  await box.fetchEntityChunk({ entity: "rows", state: first, ...sink });
  assert.deepEqual(box.session.ops(), ["start", "close", "start", "close"]);
  const restart = (box.session.calls[2] as any).input;
  assert.equal(restart.config.api_key, "rotated");
  assert.equal(restart.state[0].stream.stream_state.cursor, "c1");
  // The fingerprint is a short hash, never the config.
  const fp = (first.metadata as any)[MAKO_SESSION_KEY].fp;
  assert.match(fp, /^[a-f0-9]{16}$/);
});

void test("sessions stay off unless CONNECTOR_SESSION_READS is true", async () => {
  const box = make();
  assert.equal(await box.defaultTransport(), null);
  process.env.CONNECTOR_SESSION_READS = "1";
  assert.equal(await box.defaultTransport(), null);
});
