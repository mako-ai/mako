/**
 * The box side of a read session (session-read.ts) against a mocked sandbox
 * provider: which calls each batch costs, what each is pinned to, and what
 * every report of the box turns into. The scripts themselves run in Docker
 * (session-isolation.docker.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  supportsRunUsers: true as boolean | undefined,
  exec: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  writeFiles: vi.fn(),
  scratch: vi.fn(() => "/scratch"),
}));

vi.mock("../../apps/sandbox/provider", () => ({
  getSandboxProvider: () => sandbox,
  isSandboxGone: (error: unknown) =>
    (error as { name?: string })?.name === "SandboxNotFoundError",
}));

import {
  ConnectorSessionLostError,
  boxSessionTransport,
  type SessionHandle,
} from "./session-read";
import { forgetPreparedBox } from "./sync-box";

const encode = (text: string) => new TextEncoder().encode(text);
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const STATE = line({
  type: "STATE",
  state: {
    type: "STREAM",
    stream: { stream_descriptor: { name: "rows" }, stream_state: { n: 1 } },
    mako: { hasMore: true },
  },
});
const RECORD = line({
  type: "RECORD",
  record: { stream: "rows", data: { id: 1 } },
});

const result = (stdout = "", extra: Record<string, unknown> = {}) => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  durationMs: 1,
  truncated: false,
  ...extra,
});

const gone = () =>
  Object.assign(new Error("Sandbox is probably not running anymore"), {
    name: "SandboxNotFoundError",
  });

let key = 0;
let box = "sbx-1";
/** Scripted replies to the session commands, by what the script contains. */
let replies: {
  start?: () => unknown;
  wait?: () => unknown;
  close?: () => unknown;
};

function setup() {
  key++;
  const ctx = { sessionKey: `connector-sync:v2:ws${key}` };
  forgetPreparedBox(ctx.sessionKey);
  const onCleanupFailure = vi.fn();
  const transport = boxSessionTransport({
    ctx,
    runtimeId: "rt",
    connectorDir:
      "/var/lib/mako-connectors/runtime/versions/rt/connectors/acme@sha",
    entry: "connector.ts",
    waitSliceMs: 50,
    batchTimeoutMs: 1_000,
    onCleanupFailure,
  });
  return { ctx, transport, onCleanupFailure };
}

const execs = () => sandbox.exec.mock.calls.map(([, script]) => String(script));
const kindOf = (script: string) =>
  script.includes('command -v "$tool"') && script.includes("incoming")
    ? script.includes("setsid nohup")
      ? "start"
      : "prepare"
    : script.includes("closed $code")
      ? "close"
      : script.includes("waiting")
        ? "wait"
        : "ack";

describe("read session transport", () => {
  beforeEach(() => {
    box = "sbx-1";
    replies = {};
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFiles.mockReset();
    sandbox.exec.mockImplementation(async (_ctx, script: string) => {
      const kind = kindOf(script);
      if (kind === "prepare") return result("", { sandboxId: box });
      const reply = replies[kind as keyof typeof replies];
      if (reply) return reply();
      return result();
    });
  });

  const start = (transport: ReturnType<typeof setup>["transport"]) =>
    transport.start({
      config: { api_key: "sk_live_x" },
      catalog: { streams: [] },
      state: [{ type: "STREAM" }],
      maxIterations: 10,
      maxBytes: 1000,
      since: "2026-01-01T00:00:00.000Z",
    });

  it("starts in three calls, every one as root and pinned to the prepared box", async () => {
    const { transport } = setup();
    replies.start = () => result("MAKO_SESSION ready 1 99\n");
    sandbox.readFile.mockResolvedValue(encode(RECORD + STATE));

    const { handle, outcome } = await start(transport);

    expect(handle).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{16}$/),
      box: "sbx-1",
    });
    expect(outcome).toMatchObject({ kind: "batch", seq: 1 });
    expect(
      outcome.kind === "batch" && outcome.result.messages.map(m => m.type),
    ).toEqual(["RECORD", "STATE"]);
    // 1: the inputs into the root-only inbox.
    const [, files, owner] = sandbox.writeFiles.mock.calls[0];
    expect(owner).toEqual({ asRoot: true, expectSandboxId: "sbx-1" });
    expect(files.map((f: any) => f.path)).toEqual([
      `/var/lib/mako-connectors/incoming/${handle.id}/config.json`,
      `/var/lib/mako-connectors/incoming/${handle.id}/catalog.json`,
      `/var/lib/mako-connectors/incoming/${handle.id}/state.json`,
    ]);
    // 2: the start, which runs the connector as the run user with --session.
    const startCall = sandbox.exec.mock.calls.find(
      ([, script]) => kindOf(String(script)) === "start",
    );
    if (!startCall) throw new Error("no start command");
    expect(startCall[2]).toMatchObject({
      asRoot: true,
      expectSandboxId: "sbx-1",
    });
    const script = String(startCall[1]);
    expect(script).toContain("runuser -u");
    expect(script).toContain(
      "'--session' '--since' '2026-01-01T00:00:00.000Z'",
    );
    expect(script).toContain("'--max-iterations' '10' '--max-bytes' '1000'");
    expect(script).toContain("/runtime/versions/rt/node/bin/node");
    // No credential on any command line.
    expect(script).not.toContain("sk_live_x");
    // 3: the batch, pinned.
    expect(sandbox.readFile).toHaveBeenCalledWith(
      expect.anything(),
      `/var/lib/mako-connectors/sessions/${handle.id}/batches/1.jsonl`,
      { asRoot: true, expectSandboxId: "sbx-1" },
    );
  });

  it("takes a ready batch in one call, and acknowledges the one before off the path", async () => {
    const { transport } = setup();
    const handle: SessionHandle = { id: "0123456789abcdef", box: "sbx-1" };
    sandbox.readFile.mockResolvedValue(encode(STATE));

    const outcome = await transport.pull(handle, 4);

    expect(outcome).toMatchObject({ kind: "batch", seq: 4 });
    expect(sandbox.readFile).toHaveBeenCalledTimes(1);
    expect(sandbox.readFile.mock.calls[0][1]).toBe(
      "/var/lib/mako-connectors/sessions/0123456789abcdef/batches/4.jsonl",
    );
    const acks = execs().filter(s => kindOf(s) === "ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]).toContain('[ "$n" -le 3 ]');
    expect(execs().filter(s => kindOf(s) === "wait")).toHaveLength(0);
  });

  it("waits in the box for a batch not written yet", async () => {
    const { transport } = setup();
    const handle: SessionHandle = { id: "0123456789abcdef", box: "sbx-1" };
    sandbox.readFile
      .mockRejectedValueOnce(new Error("file not found"))
      .mockResolvedValueOnce(encode(STATE));
    let waits = 0;
    replies.wait = () =>
      result(
        ++waits < 2 ? "MAKO_SESSION waiting\n" : "MAKO_SESSION ready 2 50\n",
      );

    expect(await transport.pull(handle, 2)).toMatchObject({
      kind: "batch",
      seq: 2,
    });
    expect(waits).toBe(2);
  });

  it("reports a session in a replaced box as lost, without touching the new box's files", async () => {
    const { transport } = setup();
    box = "sbx-2";
    const outcome = await transport.pull(
      { id: "0123456789abcdef", box: "sbx-1" },
      3,
    );
    expect(outcome).toEqual({ kind: "lost", reason: "its box was replaced" });
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it("fails the call when the box is replaced under it", async () => {
    const { transport } = setup();
    sandbox.readFile.mockRejectedValue(gone());
    await expect(
      transport.pull({ id: "0123456789abcdef", box: "sbx-1" }, 2),
    ).rejects.toBeInstanceOf(ConnectorSessionLostError);
  });

  it("turns each way a session ends into what the reader does next", async () => {
    const cases: Array<[string, unknown]> = [
      [
        "ended too-large-bytes 137 0 none",
        { kind: "too-large", limit: "bytes" },
      ],
      [
        "ended too-large-messages 137 0 none",
        { kind: "too-large", limit: "messages" },
      ],
      ["ended unsupported 137 0 none", { kind: "unsupported" }],
      [
        "ended deadline 137 0 none",
        { kind: "lost", reason: "the session ended (deadline)" },
      ],
      [
        "ended abandoned 137 0 none",
        { kind: "lost", reason: "the session ended (abandoned)" },
      ],
      ["gone", { kind: "lost", reason: "the session was reaped" }],
      [
        "acked",
        {
          kind: "lost",
          reason: "batch 2 was already taken by another attempt",
        },
      ],
      // Exit 0 and no batch: never a short success.
      [
        "ended done 0 0 none",
        { kind: "lost", reason: "the connector exited before batch 2" },
      ],
    ];
    for (const [marker, expected] of cases) {
      const { transport } = setup();
      sandbox.readFile.mockReset();
      sandbox.readFile.mockRejectedValue(new Error("file not found"));
      replies.wait = () => result(`MAKO_SESSION ${marker}\n`);
      expect(
        await transport.pull({ id: "0123456789abcdef", box: "sbx-1" }, 2),
      ).toEqual(expected);
    }
  });

  it("reads a failed read's end with its exit code and stderr", async () => {
    const { transport } = setup();
    const trace = line({
      type: "TRACE",
      trace: { type: "ERROR", error: { message: "401 revoked" } },
    });
    sandbox.readFile
      .mockRejectedValueOnce(new Error("file not found"))
      .mockResolvedValueOnce(encode(trace));
    replies.wait = () =>
      result("MAKO_SESSION ended done 3 0 120\n", { stderr: "boom" });

    const outcome = await transport.pull(
      { id: "0123456789abcdef", box: "sbx-1" },
      2,
    );
    expect(sandbox.readFile.mock.calls[1][1]).toBe(
      "/var/lib/mako-connectors/sessions/0123456789abcdef/batches/2.tail",
    );
    expect(outcome).toMatchObject({
      kind: "batch",
      seq: 2,
      result: { exitCode: 3, stderr: "boom" },
    });
  });

  it("kills the box when a session's cleanup failed, however it is learned", async () => {
    // At the end of the read.
    let { transport, onCleanupFailure } = setup();
    sandbox.readFile.mockRejectedValue(new Error("file not found"));
    replies.wait = () => result("MAKO_SESSION ended done 0 3 none\n");
    await transport.pull({ id: "0123456789abcdef", box: "sbx-1" }, 2);
    expect(onCleanupFailure).toHaveBeenCalledWith(
      expect.stringContaining("exit 3"),
    );

    // At a close.
    ({ transport, onCleanupFailure } = setup());
    replies.close = () => result("MAKO_SESSION closed 3\n");
    await transport.close({ id: "0123456789abcdef", box: "sbx-1" });
    expect(onCleanupFailure).toHaveBeenCalledTimes(1);

    // A close that cannot reach the box (not gone) may have left it all.
    ({ transport, onCleanupFailure } = setup());
    replies.close = () => Promise.reject(new Error("ETIMEDOUT"));
    await transport.close({ id: "0123456789abcdef", box: "sbx-1" });
    expect(onCleanupFailure).toHaveBeenCalledWith(
      expect.stringContaining("ETIMEDOUT"),
    );

    // A box that is gone took the session with it.
    ({ transport, onCleanupFailure } = setup());
    replies.close = () => Promise.reject(gone());
    await transport.close({ id: "0123456789abcdef", box: "sbx-1" });
    expect(onCleanupFailure).not.toHaveBeenCalled();

    // At a start that finds an earlier session's failed cleanup.
    ({ transport, onCleanupFailure } = setup());
    replies.start = () =>
      result("MAKO_SESSION box-unclean abc\n", { exitCode: 96 });
    await expect(start(transport)).rejects.toThrow(/killed/);
    expect(onCleanupFailure).toHaveBeenCalledTimes(1);
  });

  it("retries a UID collision with a fresh user, but never an account it cannot lock", async () => {
    let { transport } = setup();
    let starts = 0;
    replies.start = () =>
      ++starts === 1
        ? result("MAKO_SESSION setup-failed\n", {
            exitCode: 97,
            stderr: "useradd: UID is not unique",
          })
        : result("MAKO_SESSION ready 1 10\n");
    sandbox.readFile.mockResolvedValue(encode(STATE));
    await start(transport);
    expect(starts).toBe(2);
    const users = execs()
      .filter(s => kindOf(s) === "start")
      .map(s => /user='(mkc[a-f0-9]+)'/.exec(s)?.[1]);
    expect(new Set(users).size).toBe(2);

    ({ transport } = setup());
    starts = 0;
    replies.start = () => {
      starts++;
      return result("MAKO_SESSION setup-failed\n", {
        exitCode: 97,
        stderr: "empty passwords left: root",
      });
    };
    await expect(start(transport)).rejects.toThrow(/empty passwords left/);
    expect(starts).toBe(1);
  });

  it("cleans up a start that was cut off, since the credential may be in the box", async () => {
    const { transport } = setup();
    replies.start = () => Promise.reject(new Error("connection reset"));
    replies.close = () => result("MAKO_SESSION closed 0\n");
    await expect(start(transport)).rejects.toThrow(/connection reset/);
    expect(execs().filter(s => kindOf(s) === "close")).toHaveLength(1);
  });

  it("gives up on a batch that never comes, and ends the session", async () => {
    const { transport } = setup();
    sandbox.readFile.mockRejectedValue(new Error("file not found"));
    replies.wait = () => result("MAKO_SESSION waiting\n");
    replies.close = () => result("MAKO_SESSION closed 0\n");
    await expect(
      transport.pull({ id: "0123456789abcdef", box: "sbx-1" }, 2),
    ).rejects.toThrow(/no batch in 1 s/);
    expect(execs().filter(s => kindOf(s) === "close")).toHaveLength(1);
  });
});
