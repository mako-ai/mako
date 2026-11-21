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
import { Hono } from "hono";
import { Inngest, StepError } from "inngest";
import { serve } from "inngest/hono";
import { Types } from "mongoose";
import { Flow } from "../../database/workspace-schema";
import { handleFlowRunFailure } from "../../inngest/functions/flow/failure";
import {
  boxedReadError,
  boxedReadFailure,
  readBoxedReadFailure,
} from "./boxed-read-failure";
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
  runtime = "sdk-runtime-1";

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

  protected async sessionRuntimeId() {
    return this.runtime;
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

for (const mode of ["session", "chunk", "retry succeeds"] as const) {
  void test(`Inngest HTTP replay carries the boxed diagnostic: ${mode}`, async t => {
    const executionId = new Types.ObjectId().toString();
    const writes: unknown[] = [];
    let readAttempts = 0;
    let caught: unknown;
    t.mock.method(Flow.db, "collection", () => ({
      findOne: async () => ({ startedAt: new Date() }),
      updateOne: async (
        filter: { _id: Types.ObjectId },
        update: { $set: { error: unknown } },
      ) => {
        assert.equal(String(filter._id), executionId);
        writes.push(update.$set.error);
      },
    }));
    t.mock.method(Flow, "findByIdAndUpdate", async () => undefined);
    const client = new Inngest({
      id: "boxed-fixture",
      isDev: true,
      fetch: async () => {
        throw new Error("unexpected external Inngest request");
      },
    });
    const child = client.createFunction(
      { id: "child", retries: 1 },
      async ({ step }) => {
        return await step.run("read", async () => {
          readAttempts++;
          const box = make();
          box.useSession = mode !== "chunk";
          const result =
            mode === "retry succeeds" && readAttempts === 2
              ? ok([stateMessage("done", false)])
              : ok(
                  [
                    {
                      type: "TRACE",
                      trace: {
                        type: "ERROR",
                        error: { message: "synthetic secret; HTTP 500" },
                      },
                    },
                  ],
                  1,
                );
          if (box.useSession) {
            box.session.starts.push({ kind: "batch", seq: 1, result });
          } else {
            box.runAnswers.push(result);
          }
          return box.fetchEntityChunk({ entity: "rows", ...collect() });
        });
      },
    );
    const parent = client.createFunction({ id: "parent" }, async ({ step }) => {
      try {
        return await step.invoke("invoke-read", { function: child, data: {} });
      } catch (error) {
        caught = error;
        const noop = () => undefined;
        return handleFlowRunFailure(
          {
            step,
            flowId: new Types.ObjectId().toString(),
            data: { backfill: false },
            state: { executionId },
            logger: { error: noop, info: noop },
            appendExecutionLog: noop,
          } as unknown as Parameters<typeof handleFlowRunFailure>[0],
          error,
        );
      }
    });
    const app = new Hono();
    app.post("/api/inngest", serve({ client, functions: [child, parent] }));
    const post = (
      fn: "child" | "parent",
      stepId = "step",
      steps = {},
      attempt = 0,
    ) =>
      app.request(`/api/inngest?fnId=boxed-fixture-${fn}&stepId=${stepId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: { name: "inngest/function.invoked", data: {} },
          steps,
          ctx: {
            run_id: `fixture-${fn}`,
            attempt,
            max_attempts: 2,
            disable_immediate_execution: true,
          },
        }),
      });
    const discover = async (fn: "child" | "parent") => {
      const response = await post(fn);
      assert.equal(response.status, 206);
      const [operation] = (await response.json()) as { id: string }[];
      return operation.id;
    };
    const readId = await discover("child");
    const invokeId = await discover("parent");
    const first = await post("child", readId);
    assert.equal(first.status, 206);
    assert.equal(first.headers.get("x-inngest-no-retry"), "false");
    const [failed] = (await first.json()) as { error: { cause: unknown } }[];
    assert.deepEqual(failed.error.cause, {
      kind: "mako:boxed-read-failure",
      entity: "rows",
    });
    assert.deepEqual(writes, []);

    // Replay the same read step once, as the executor does on an ordinary retry.
    const second = await post("child", readId, {}, 1);
    assert.equal(second.status, 206);
    const [retried] = (await second.json()) as {
      data?: unknown;
      error?: unknown;
    }[];
    assert.equal(readAttempts, 2);
    const childResult = await post(
      "child",
      "step",
      {
        [readId]: retried.error
          ? { type: "error", error: retried.error }
          : { type: "data", data: retried.data },
      },
      1,
    );
    const invocationResult = await childResult.json();
    if (mode === "retry succeeds") {
      assert.equal(childResult.status, 200);
      const done = await post("parent", "step", {
        [invokeId]: { type: "data", data: invocationResult },
      });
      assert.equal(done.status, 200);
      assert.deepEqual(writes, []);
      assert.equal(caught, undefined);
      return;
    }

    // Use the child's actual SDK response as the executor's failed invoke result.
    assert.equal(childResult.status, 400);
    assert.ok(invocationResult && typeof invocationResult === "object");
    assert.ok("cause" in invocationResult);
    assert.deepEqual(invocationResult.cause, failed.error.cause);
    const invokeState = {
      [invokeId]: { type: "error", error: invocationResult },
    };
    const pending = await post("parent", "step", invokeState);
    assert.equal(pending.status, 206);
    const [terminal] = (await pending.json()) as {
      id: string;
      displayName: string;
    }[];
    assert.equal(terminal.displayName, "complete-execution-error");
    assert.deepEqual(readBoxedReadFailure(caught), { entity: "rows" });
    assert.deepEqual(writes, []);
    const receipt = await post("parent", terminal.id, invokeState);
    assert.equal(receipt.status, 206);
    assert.deepEqual(writes, [
      {
        message: "Boxed connector read failed",
        readFailure: { entity: "rows" },
      },
    ]);
  });
}

void test("a read takes batch 1, 2, 3 of one session and closes it after the last", async () => {
  const box = make();
  box.session.starts.push(batch(1, [1, 2], "c1", true));
  box.session.pulls.push(batch(2, [3], "c2", true), batch(3, [4], "c3", false));
  const sink = collect();
  const since = new Date("2026-01-01T00:00:00Z");

  const first = await box.fetchEntityChunk({ entity: "rows", since, ...sink });
  assert.deepEqual((first as any).readSession, {
    id: ID,
    box: "box-1",
    seq: 1,
    entity: "rows",
    connection: "ds",
    fp: (first as any).readSession.fp,
  });
  // The pointer is the engine's: the connector's STATE never holds it.
  assert.equal((first.metadata as any)[MAKO_SESSION_KEY], undefined);
  // The orchestrator adds its own keys between chunks.
  first.metadata = { ...(first.metadata as object), rowsWrittenTotal: 2 };
  const second = await box.fetchEntityChunk({
    entity: "rows",
    state: first,
    ...sink,
  });
  assert.equal((second as any).readSession.seq, 2);
  const third = await box.fetchEntityChunk({
    entity: "rows",
    state: second,
    ...sink,
  });

  assert.deepEqual(box.session.ops(), ["start", "pull 2", "pull 3", "close"]);
  assert.deepEqual(sink.rows, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  assert.equal(third.hasMore, false);
  assert.equal(third.totalProcessed, 4);
  assert.equal((third as any).readSession, undefined);
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
  assert.equal((second as any).readSession.seq, 2);
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
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'read failed for "rows": 401: key revoked');
      const stepError = new StepError("read", {
        name: error.name,
        message: error.message,
        cause: structuredClone(error.cause),
      });
      assert.deepEqual(readBoxedReadFailure(stepError), { entity: "rows" });
      return true;
    },
  );
  assert.deepEqual(box.session.ops(), ["start", "pull 2", "close"]);
  // Rows of the failed batch were never applied.
  assert.deepEqual(sink.rows, [{ id: 1 }]);
  box.session.pulls.push({ kind: "lost", reason: "session already closed" });
  box.session.starts.push(batch(1, [2], "c2", false));
  await box.fetchEntityChunk({ entity: "rows", state: first, ...sink });
  const restart = box.session.calls.filter(call => call.op === "start")[1];
  assert.ok(restart);
  const entry = (restart.input.state as any[])[0];
  assert.equal(entry.stream.stream_state.cursor, "c1");
  assert.deepEqual(sink.rows, [{ id: 1 }, { id: 2 }]);
});

void test("a failed chunk process reports only its catalog entity and keeps its cursor", async () => {
  const box = make();
  box.useSession = false;
  box.runAnswers.push(ok([stateMessage("saved", true)]));
  const sink = collect();
  const first = await box.fetchEntityChunk({ entity: "rows", ...sink });
  const input = { entity: "rows", state: first, ...sink };
  box.runAnswers.push({
    ...ok(
      [{ type: "RECORD", record: { stream: "rows", data: { id: 99 } } }],
      1,
    ),
    stderr: "HTTP 500 with fixture token and code 2446079",
  });
  await assert.rejects(box.fetchEntityChunk(input), (error: unknown) => {
    assert.deepEqual(readBoxedReadFailure(error), { entity: "rows" });
    return true;
  });
  assert.deepEqual(sink.rows, []);
  box.runAnswers.push(ok([stateMessage("done", false)]));
  await box.fetchEntityChunk(input);
  assert.deepEqual(box.runs[1].options.state, box.runs[2].options.state);
  assert.equal(
    box.runs[2].options.state[0].stream.stream_state.cursor,
    "saved",
  );
});

void test("an unmarked error and an undeclared entity have no read diagnostic", () => {
  assert.equal(
    readBoxedReadFailure(new Error('read failed for "rows": HTTP 500')),
    undefined,
  );
  assert.equal(
    readBoxedReadFailure(boxedReadError("failure", "rows", [])),
    undefined,
  );
  assert.equal(
    boxedReadFailure({ entity: "https://fixture.invalid/?token=value" }),
    undefined,
  );
  assert.deepEqual(
    boxedReadFailure({
      entity: "rows",
      message: "fixture token",
      httpStatus: 500,
    }),
    { entity: "rows" },
  );
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
  assert.deepEqual((first as any).readSession, { unsupported: true });
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
  assert.equal((state as any).readSession, undefined);
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
      readSession: { id: ID, seq: 4, entity: "other", connection: "ds" },
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
  assert.equal((state as any).readSession, undefined);
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
  const fp = (first as any).readSession.fp;
  assert.match(fp, /^[a-f0-9]{16}$/);
});

void test("sessions stay off unless CONNECTOR_SESSION_READS is true", async () => {
  const box = make();
  assert.equal(await box.defaultTransport(), null);
  process.env.CONNECTOR_SESSION_READS = "1";
  assert.equal(await box.defaultTransport(), null);
});

// ---------------------------------------------------------------------------
// A hostile connector. Its STATE is the only thing it writes into the
// engine's state. It must never steer a later chunk to another read's
// session, to end it or to take its batches.
// ---------------------------------------------------------------------------

const VICTIM = "fedcba9876543210";

/** A STATE that also carries a forged session pointer. */
const forgedState = (
  cursor: string,
  hasMore: boolean,
  pointer: Record<string, unknown>,
) => {
  const message = stateMessage(cursor, hasMore) as any;
  message.state[MAKO_SESSION_KEY] = pointer;
  message.state.readSession = pointer;
  return message;
};

const touched = (box: SessionBox) =>
  box.session.calls
    .filter(c => c.op !== "start")
    .map(c => (c as { handle: SessionHandle }).handle.id);

void test("a forged pointer in a connector's STATE cannot close another session", async () => {
  const box = make();
  // A batch over the cap sends this chunk to a chunk process. Its STATE
  // names VICTIM with a fingerprint that cannot match: the old code read
  // the pointer from the stored STATE and closed the session it named.
  box.session.starts.push(
    { kind: "too-large", limit: "bytes" },
    batch(1, [2], "c2", false),
  );
  box.runAnswers.push(
    ok([
      { type: "RECORD", record: { stream: "rows", data: { id: 1 } } },
      forgedState("c1", true, {
        id: VICTIM,
        box: "box-1",
        seq: 1,
        entity: "rows",
        connection: "ds",
        fp: "0000000000000000",
      }),
    ]),
  );
  const sink = collect();
  const first = await box.fetchEntityChunk({ entity: "rows", ...sink });
  // The forged pointer was dropped from the stored STATE.
  assert.equal((first.metadata as any)[MAKO_SESSION_KEY], undefined);
  assert.equal((first as any).readSession, undefined);
  await box.fetchEntityChunk({ entity: "rows", state: first, ...sink });

  assert.deepEqual(box.session.ops(), ["start", "close", "start", "close"]);
  assert.ok(!touched(box).includes(VICTIM), "the victim's session was closed");
  assert.deepEqual(sink.rows, [{ id: 1 }, { id: 2 }]);
});

void test("a forged pointer in a connector's STATE cannot read another session's batches", async () => {
  const box = make();
  // A legitimate first read gives the fingerprint an attacker would need.
  box.session.starts.push(batch(1, [1], "c1", true));
  const legit = await box.fetchEntityChunk({ entity: "rows", ...collect() });
  const fp = (legit as any).readSession.fp;

  // The read falls back to chunk processes, and the connector's STATE
  // points at VICTIM with the right fingerprint, entity and connection.
  const hostile = make();
  hostile.session.starts.push(
    { kind: "unsupported" },
    batch(1, [9], "own", false),
  );
  const pointer = {
    id: VICTIM,
    box: "box-1",
    seq: 1,
    entity: "rows",
    connection: "ds",
    fp,
  };
  hostile.runAnswers.push(ok([forgedState("c1", true, pointer)]));
  const sink = collect();
  const first = await hostile.fetchEntityChunk({ entity: "rows", ...sink });
  assert.deepEqual((first as any).readSession, { unsupported: true });
  assert.equal((first.metadata as any)[MAKO_SESSION_KEY], undefined);

  // Even a state that carries the pointer in its metadata (a checkpoint
  // written before this change) starts its own session and reads only it.
  await hostile.fetchEntityChunk({
    entity: "rows",
    state: {
      totalProcessed: 1,
      hasMore: true,
      iterationsInChunk: 10,
      metadata: { ...(first.metadata as object), [MAKO_SESSION_KEY]: pointer },
    },
    ...sink,
  });
  assert.deepEqual(hostile.session.ops(), ["start", "close", "start", "close"]);
  assert.ok(
    !touched(hostile).includes(VICTIM),
    "the victim's session was read",
  );
  assert.deepEqual(sink.rows, [{ id: 9 }]);
  // The connector's state never sees a pointer either.
  const restart = (hostile.session.calls[2] as any).input;
  assert.equal(restart.state[0][MAKO_SESSION_KEY], undefined);
});

void test("a pointer that names another connection is ignored", async () => {
  const box = make();
  box.session.starts.push(batch(1, [1], "c1", false));
  await box.fetchEntityChunk({
    entity: "rows",
    state: {
      totalProcessed: 0,
      hasMore: true,
      iterationsInChunk: 10,
      readSession: {
        id: VICTIM,
        box: "box-1",
        seq: 3,
        entity: "rows",
        connection: "another-connection",
      },
    },
    onBatch: async () => undefined,
  });
  assert.deepEqual(box.session.ops(), ["start", "close"]);
  assert.ok(!touched(box).includes(VICTIM));
});

void test("a new SDK runtime replaces the session, from the applied state", async () => {
  const box = make();
  box.session.starts.push(
    batch(1, [1], "c1", true),
    batch(1, [2], "c2", false),
  );
  const sink = collect();
  const first = await box.fetchEntityChunk({ entity: "rows", ...sink });
  box.runtime = "another-sdk-runtime";
  await box.fetchEntityChunk({ entity: "rows", state: first, ...sink });
  assert.deepEqual(box.session.ops(), ["start", "close", "start", "close"]);
  assert.equal(
    (box.session.calls[2] as any).input.state[0].stream.stream_state.cursor,
    "c1",
  );
});
