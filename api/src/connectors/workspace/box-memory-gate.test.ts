/**
 * The connector box memory gate. On 19 Nov 2026 RealAdvisor's 2 GB sync box
 * reached 1,899 of 1,982 MB with Close, Stripe and Meta reads side by side:
 * commands hit deadline_exceeded, run cleanup exited 124, and Mako replaced
 * the box 10 times in 2 hours. A connector run or read session must never
 * start into a box that is out of memory, and the refusal must read as the
 * platform's failure, never the connector's.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
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
  BoxLowMemoryError,
  isBoxLowMemoryError,
  memoryGateShell,
} from "../../apps/sandbox/box-memory";
import {
  CHUNK_MARKER,
  CONNECTOR_RUN_MIN_FREE_MB,
  LOW_MEMORY_EXIT,
  chunkScript,
  lowMemoryMb,
  memoryGateScript,
  runLayout,
} from "./run-isolation";
import {
  SESSION_MARKER,
  sessionLayout,
  startScript,
} from "./session-isolation";
import {
  ConnectorBoxLowMemoryError,
  forgetPreparedBox,
  runConnectorCommand,
} from "./sync-box";
import { boxSessionTransport } from "./session-read";
import { sessionLimits } from "./session-config";
import { isTransientIndexFailure } from "./transient-failure";
import { isInfrastructureFailure } from "../../inngest/functions/flow/infra-failure";

const result = (stdout = "") => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  durationMs: 1,
  truncated: false,
  sandboxId: "sbx-1",
});

/** Run a gate against a fake /proc/meminfo reporting `kb` kB available. */
function runGate(script: string, kb: number | null) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "mem-gate-"));
  const meminfo = nodePath.join(dir, "meminfo");
  if (kb !== null) {
    fs.writeFileSync(
      meminfo,
      `MemTotal:        2029568 kB\nMemFree:           12000 kB\nMemAvailable:   ${kb} kB\n`,
    );
  }
  const inbox = nodePath.join(dir, "inbox");
  fs.mkdirSync(inbox);
  fs.writeFileSync(nodePath.join(inbox, "config.json"), "{}");
  const shell = script
    .replace("/proc/meminfo", meminfo)
    .replace("'INBOX'", JSON.stringify(inbox));
  let status = 0;
  let stdout: string;
  try {
    stdout = execFileSync("bash", ["-c", `${shell}\necho passed`], {
      encoding: "utf8",
    });
  } catch (error) {
    const e = error as { status: number; stdout: string };
    status = e.status;
    stdout = e.stdout;
  }
  return { status, stdout, inboxLeft: fs.existsSync(inbox) };
}

describe("the gate's shell", () => {
  const gate = memoryGateScript(CHUNK_MARKER, "'INBOX'");

  it("refuses the 19 Nov box (83 MB free), removes the inbox, exits 94", () => {
    const out = runGate(gate, 83 * 1024);
    expect(out.status).toBe(LOW_MEMORY_EXIT);
    expect(LOW_MEMORY_EXIT).toBe(94);
    expect(out.stdout.trim()).toBe(`${CHUNK_MARKER} low-memory 83`);
    expect(out.inboxLeft).toBe(false);
  });

  it("refuses 1 MB under 600 MB and lets 600 MB through", () => {
    expect(CONNECTOR_RUN_MIN_FREE_MB).toBe(600);
    expect(runGate(gate, 599 * 1024).status).toBe(LOW_MEMORY_EXIT);
    const ok = runGate(gate, 600 * 1024);
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe("passed");
    expect(ok.inboxLeft).toBe(true);
  });

  it("lets the run through without /proc (local provider, macOS)", () => {
    const out = runGate(gate, null);
    expect(out.stdout.trim()).toBe("passed");
  });

  it("refuses an unsafe threshold", () => {
    expect(() => memoryGateShell(1.5, "exit 1")).toThrow();
  });

  it("runs first in a chunk run, before the run's user exists", () => {
    const l = runLayout("r1", "mkc1", 300_000, 300_000);
    const script = chunkScript(l, [], "node x", 1024);
    const gateAt = script.indexOf(`${CHUNK_MARKER} low-memory`);
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(script.indexOf("useradd"));
  });

  it("runs in a session start after the reap and before the user exists", () => {
    const layout = sessionLayout(runLayout("r1", "mkc1", 300_000, 300_000));
    const script = startScript({
      layout,
      inputs: [],
      command: "node x",
      node: "/node",
      limits: sessionLimits(),
      waitMs: 1000,
    });
    const gateAt = script.indexOf(`${SESSION_MARKER} low-memory`);
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt).toBeLessThan(script.indexOf("useradd"));
  });

  it("reads the marker's MiB", () => {
    expect(lowMemoryMb("low-memory 83")).toBe(83);
    expect(lowMemoryMb("setup-failed")).toBeNull();
    expect(lowMemoryMb(undefined)).toBeNull();
  });
});

describe("the gate's refusal", () => {
  it("reads as a platform failure everywhere a failure is classified", () => {
    const error = new ConnectorBoxLowMemoryError("connector-sync:v2:ws1", 83);
    expect(isBoxLowMemoryError(error)).toBe(true);
    expect(error).toBeInstanceOf(BoxLowMemoryError);
    expect(error.availableMb).toBe(83);
    expect(error.requiredMb).toBe(600);
    expect(isInfrastructureFailure(error.message)).toBe(true);
    expect(isTransientIndexFailure(error.message)).toBe(true);
  });
});

let n = 0;
let ctx = { sessionKey: "connector-sync:v2:gate-0" };

describe("a refused run in the box", () => {
  beforeEach(() => {
    sandbox.exec.mockReset();
    sandbox.writeFiles.mockReset();
    sandbox.readFile.mockReset();
    n++;
    ctx = { sessionKey: `connector-sync:v2:gate-${n}` };
    forgetPreparedBox(ctx.sessionKey);
  });

  it("a chunk throws ConnectorBoxLowMemoryError, with no extra round trip", async () => {
    sandbox.exec.mockImplementation(async (_ctx, script: string) =>
      script.includes(`${CHUNK_MARKER} setup-failed`)
        ? result(`${CHUNK_MARKER} low-memory 83\n`)
        : result(),
    );
    const error = await runConnectorCommand({
      ctx,
      runtimeId: "rt1",
      connectorDir: "/var/lib/mako-connectors/runtime/connectors/x@1",
      command: "read",
      config: { apiKey: "secret" },
    }).catch(e => e);
    expect(error).toBeInstanceOf(ConnectorBoxLowMemoryError);
    expect(error.availableMb).toBe(83);
    // Prepare, then the chunk command. No retry with a fresh user, no
    // abandon: nothing of the run was created.
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it("a session start throws ConnectorBoxLowMemoryError and closes nothing", async () => {
    sandbox.exec.mockImplementation(async (_ctx, script: string) =>
      script.includes("setsid nohup")
        ? result(`${SESSION_MARKER} low-memory 120\n`)
        : result(),
    );
    const onCleanupFailure = vi.fn();
    const transport = boxSessionTransport({
      ctx,
      runtimeId: "rt1",
      connectorDir: "/var/lib/mako-connectors/runtime/connectors/x@1",
      onCleanupFailure,
    });
    const error = await transport
      .start({ config: { apiKey: "secret" }, maxIterations: 10 })
      .catch(e => e);
    expect(error).toBeInstanceOf(ConnectorBoxLowMemoryError);
    expect(error.availableMb).toBe(120);
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
    expect(onCleanupFailure).not.toHaveBeenCalled();
  });
});
