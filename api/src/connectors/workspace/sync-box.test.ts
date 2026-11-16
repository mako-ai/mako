import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  supportsRunUsers: undefined as boolean | undefined,
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
  CONNECTOR_NODE_VERSION,
  materializeConnector,
  retireLegacySyncBox,
  syncBoxContext,
  ConnectorOutputTooLargeError,
  MAX_CONNECTOR_PROTOCOL_BYTES,
  MAX_CONNECTOR_PROTOCOL_MESSAGES,
  installConnectorRuntime,
  runConnectorCommand,
} from "./sync-box";

/** What the bounding step prints for a snapshot of `bytes` bytes. */
const bounded = (bytes: number | "missing") => `MAKO_BOUNDED_OUTPUT ${bytes}\n`;

const result = (stdout = "") => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  durationMs: 1,
  truncated: false,
});

describe("workspace connector protocol output", () => {
  beforeEach(() => {
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFile.mockReset();
    sandbox.writeFiles.mockReset();
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("head -c")) {
        return Promise.resolve(
          result(bounded(MAX_CONNECTOR_PROTOCOL_BYTES + 1)),
        );
      }
      return Promise.resolve(result());
    });
  });

  it("runs connector commands with the runtime's pinned Node", async () => {
    const protocol = `${JSON.stringify({ type: "STATE", state: {} })}\n`;
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("head -c")) {
        return Promise.resolve(result(bounded(Buffer.byteLength(protocol))));
      }
      return Promise.resolve(result());
    });
    sandbox.readFile.mockResolvedValue(new TextEncoder().encode(protocol));

    await runConnectorCommand({
      ctx: { sessionKey: "connector-sync:test" },
      runtimeId: "runtime",
      connectorDir: "/scratch/connector",
      command: "read",
    });

    const run = sandbox.exec.mock.calls.find(([, command]) =>
      String(command).includes("mako-connector.js"),
    );
    expect(run?.[1]).toContain(
      "/connector-runtime/versions/runtime/node/bin/node",
    );
  });

  it("rejects an oversized bounded snapshot before reading it into the API", async () => {
    await expect(
      runConnectorCommand({
        ctx: { sessionKey: "connector-sync:test" },
        runtimeId: "runtime",
        connectorDir: "/scratch/connector",
        command: "read",
      }),
    ).rejects.toThrow(ConnectorOutputTooLargeError);

    expect(sandbox.readFile).not.toHaveBeenCalled();
    expect(
      sandbox.exec.mock.calls.some(([, command]) =>
        String(command).includes("rm -rf"),
      ),
    ).toBe(true);
  });

  it("parses the bounded snapshot rather than the connector-owned file", async () => {
    const protocol = `${JSON.stringify({ type: "STATE", state: {} })}\n`;
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("head -c")) {
        return Promise.resolve(result(bounded(Buffer.byteLength(protocol))));
      }
      return Promise.resolve(result());
    });
    sandbox.readFile.mockResolvedValue(new TextEncoder().encode(protocol));

    const output = await runConnectorCommand({
      ctx: { sessionKey: "connector-sync:test" },
      runtimeId: "runtime",
      connectorDir: "/scratch/connector",
      command: "read",
    });

    expect(output.messages).toEqual([{ type: "STATE", state: {} }]);
    expect(sandbox.readFile).toHaveBeenCalledWith(
      { sessionKey: "connector-sync:test" },
      expect.stringContaining("out.bounded.jsonl"),
    );
  });

  it("caps tiny protocol lines whose object overhead would evade the byte cap", async () => {
    const protocol = "{}\n".repeat(MAX_CONNECTOR_PROTOCOL_MESSAGES + 1);
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("head -c")) {
        return Promise.resolve(result(bounded(Buffer.byteLength(protocol))));
      }
      return Promise.resolve(result());
    });
    sandbox.readFile.mockResolvedValue(new TextEncoder().encode(protocol));

    await expect(
      runConnectorCommand({
        ctx: { sessionKey: "connector-sync:test" },
        runtimeId: "runtime",
        connectorDir: "/scratch/connector",
        command: "read",
      }),
    ).rejects.toThrow(/message limit/);
  });

  it("costs 3 calls on the critical path: one write, one command, one read", async () => {
    const protocol = `${JSON.stringify({ type: "STATE", state: {} })}\n`;
    let cleaned!: () => void;
    const cleanup = new Promise<void>(resolve => (cleaned = resolve));
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("mako-connector.js")) {
        return Promise.resolve(result(bounded(Buffer.byteLength(protocol))));
      }
      // The run directory's removal is held open: the chunk must not wait.
      if (command.startsWith("rm -rf")) return cleanup.then(() => result());
      return Promise.resolve(result());
    });
    sandbox.readFile.mockResolvedValue(new TextEncoder().encode(protocol));

    const output = await runConnectorCommand({
      ctx: { sessionKey: "connector-sync:test" },
      runtimeId: "runtime",
      connectorDir: "/scratch/connector",
      command: "read",
      config: { api_key: "secret" },
      catalog: { streams: [] },
      state: [{ type: "STREAM" }],
      maxIterations: 10,
      maxBytes: 1234,
    });
    expect(output.messages).toEqual([{ type: "STATE", state: {} }]);

    // One request for all three inputs.
    expect(sandbox.writeFiles).toHaveBeenCalledTimes(1);
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    const written = sandbox.writeFiles.mock.calls[0][1] as Array<{
      path: string;
    }>;
    expect(written.map(f => f.path.split("/").at(-1))).toEqual([
      "config.json",
      "catalog.json",
      "state.json",
    ]);

    // One command: it runs the connector, deletes the inputs, bounds the
    // output. The cleanup exec is still pending when the call returns.
    const commands = sandbox.exec.mock.calls.map(([, c]) => String(c));
    expect(commands).toHaveLength(2);
    const [script, rm] = commands;
    expect(script).toContain("--max-iterations' '10'");
    expect(script).toContain("--max-bytes' '1234'");
    const runAt = script.indexOf("mako-connector.js");
    const deleteAt = script.indexOf("config.json'", script.indexOf("rm -f"));
    const headAt = script.indexOf("head -c");
    expect(runAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(runAt);
    expect(headAt).toBeGreaterThan(deleteAt);
    expect(script).toMatch(/exit \$status$/);
    expect(rm).toMatch(/^rm -rf /);
    expect(sandbox.readFile).toHaveBeenCalledTimes(1);
    cleaned();
  });

  it("waits for the cleanup when the command never deleted its inputs", async () => {
    let cleanedUp = false;
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("mako-connector.js")) {
        return Promise.resolve({ ...result(), exitCode: 124, timedOut: true });
      }
      if (command.startsWith("rm -rf")) {
        return new Promise(resolve =>
          setTimeout(() => {
            cleanedUp = true;
            resolve(result());
          }, 10),
        );
      }
      return Promise.resolve(result());
    });

    const output = await runConnectorCommand({
      ctx: { sessionKey: "connector-sync:test" },
      runtimeId: "runtime",
      connectorDir: "/scratch/connector",
      command: "read",
      config: { api_key: "secret" },
    });
    expect(output.timedOut).toBe(true);
    // The credential may still be on disk: the call returns only after rm.
    expect(cleanedUp).toBe(true);
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it("awaits the cleanup when the marker never came back", async () => {
    let cleanedUp = false;
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("mako-connector.js")) {
        // Killed before the bounding step: no marker, inputs maybe on disk.
        return Promise.resolve({ ...result(""), exitCode: 137 });
      }
      if (command.startsWith("rm -rf")) {
        return new Promise(resolve =>
          setTimeout(() => {
            cleanedUp = true;
            resolve(result());
          }, 10),
        );
      }
      return Promise.resolve(result());
    });
    await expect(
      runConnectorCommand({
        ctx: { sessionKey: "connector-sync:test" },
        runtimeId: "runtime",
        connectorDir: "/scratch/connector",
        command: "read",
        config: { api_key: "secret" },
      }),
    ).rejects.toThrow(/protocol size/);
    expect(cleanedUp).toBe(true);
  });

  it("skips the read when the command wrote nothing", async () => {
    sandbox.exec.mockImplementation((_ctx, command: string) =>
      Promise.resolve(
        command.includes("mako-connector.js")
          ? { ...result(bounded("missing")), exitCode: 1, stderr: "boom" }
          : result(),
      ),
    );
    const output = await runConnectorCommand({
      ctx: { sessionKey: "connector-sync:test" },
      runtimeId: "runtime",
      connectorDir: "/scratch/connector",
      command: "spec",
    });
    expect(output).toMatchObject({ exitCode: 1, messages: [], stderr: "boom" });
    expect(sandbox.readFile).not.toHaveBeenCalled();
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
  });
});

describe("workspace connector runtime installation", () => {
  beforeEach(() => {
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFile.mockReset();
  });

  it("installs a pinned, checksum-verified Node before writing the marker", async () => {
    sandbox.exec.mockResolvedValue(result());

    await installConnectorRuntime(
      { sessionKey: "connector-sync:test" },
      "runtime",
      new Map([["package.json", new TextEncoder().encode("{}")]]),
    );

    const install = String(sandbox.exec.mock.calls[0]?.[1]);
    expect(install).toContain(
      `https://nodejs.org/dist/v${CONNECTOR_NODE_VERSION}/`,
    );
    expect(install).toContain("sha256sum -c -");
    expect(sandbox.writeFile).toHaveBeenLastCalledWith(
      { sessionKey: "connector-sync:test" },
      expect.stringMatching(/\/runtime\/.materialized$/),
      expect.any(Uint8Array),
    );
  });

  it("does not mark a runtime complete when Node installation fails", async () => {
    sandbox.exec.mockResolvedValue({
      ...result(),
      exitCode: 1,
      stderr: "curl failed",
    });

    await expect(
      installConnectorRuntime(
        { sessionKey: "connector-sync:test" },
        "runtime",
        new Map([["package.json", new TextEncoder().encode("{}")]]),
      ),
    ).rejects.toThrow(/curl failed/);

    expect(
      sandbox.writeFile.mock.calls.some(([, file]) =>
        String(file).endsWith("/.materialized"),
      ),
    ).toBe(false);
  });
});

/**
 * Credential isolation between runs that share a box, in one command.
 *
 * Before per-run users every command ran as the template user, so a run could
 * read a concurrent run's config.json (another connection's credential) or
 * leave a process behind to read later ones. Each run gets its own Unix user
 * and a 0700 directory, the connector starts under `runuser`, and cleanup
 * kills the user's processes and deletes the user. All of it now happens in
 * the chunk's single root command (run-isolation.ts chunkScript), so a chunk
 * still costs one write, one command and one read.
 */
describe("per-run Unix users on providers with real users", () => {
  const protocol = `${JSON.stringify({ type: "STATE", state: {} })}\n`;
  let n = 0;
  let ctx = { sessionKey: "connector-box:test-0" };
  /** What the chunk command prints last; override per test. */
  let chunkStdout: () => string;

  beforeEach(() => {
    n++;
    ctx = { sessionKey: `connector-box:test-${n}` };
    sandbox.supportsRunUsers = true;
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFile.mockReset();
    sandbox.writeFiles.mockReset();
    chunkStdout = () => `MAKO_CHUNK ${Buffer.byteLength(protocol)} 0\n`;
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("/var/lib/mako-connectors/incoming'")) {
        // prepareBoxScript: tools present, inbox made.
        return Promise.resolve({ ...result(), sandboxId: "sbx_1" });
      }
      if (
        command.includes("mako-connector.js") &&
        command.includes("MAKO_CHUNK")
      ) {
        return Promise.resolve({
          ...result(chunkStdout()),
          sandboxId: "sbx_1",
        });
      }
      return Promise.resolve(result());
    });
    sandbox.readFile.mockResolvedValue(new TextEncoder().encode(protocol));
  });

  afterEach(() => {
    sandbox.supportsRunUsers = undefined;
  });

  const runOnce = (onCleanupFailure?: (reason: string) => void) =>
    runConnectorCommand({
      ctx,
      runtimeId: "runtime",
      connectorDir:
        "/var/lib/mako-connectors/runtime/versions/runtime/connectors/acme@abc",
      command: "read",
      config: { apiKey: "secret" },
      state: [{ type: "STREAM" }],
      onCleanupFailure,
    });

  const calls = () =>
    sandbox.exec.mock.calls.map(([, command, options]) => ({
      command: String(command),
      options: options as Record<string, unknown> | undefined,
    }));
  const chunks = () =>
    calls().filter(c => c.command.includes("mako-connector.js"));
  const userOf = (command: string) =>
    /user='(mkc[0-9a-f]+)'/.exec(command)?.[1];
  const dirOf = (command: string) => /R='([^']+)'/.exec(command)?.[1];

  it("costs one write, one root command and one read, with setup and cleanup inside the command", async () => {
    await runOnce(); // prepares the box once
    sandbox.exec.mockClear();
    sandbox.writeFiles.mockClear();
    sandbox.readFile.mockClear();

    const output = await runOnce();
    expect(output.messages).toEqual([{ type: "STATE", state: {} }]);

    expect(sandbox.writeFiles).toHaveBeenCalledTimes(1);
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    expect(chunks()).toHaveLength(1);
    expect(sandbox.readFile).toHaveBeenCalledTimes(1);
    // Besides the chunk, only the off-path removal of the read output.
    const others = calls().filter(
      c => !c.command.includes("mako-connector.js"),
    );
    expect(others.map(c => c.command)).toEqual([
      expect.stringMatching(/^rm -f '\/var\/lib\/mako-connectors\/results\//),
    ]);

    // Setup, hand-over, launch, bounding and cleanup, in that order.
    const chunk = chunks()[0].command;
    const order = [
      'useradd -l -M -u "$uid" -g "$gid"',
      "mv -- '/var/lib/mako-connectors/incoming/",
      "chown '",
      "runuser -u '",
      "head -c ",
      'runuser -u "$user" -- kill -9 -1',
      'userdel "$user" ||',
      'echo "MAKO_CHUNK $size $cleanup"',
    ].map(part => chunk.indexOf(part));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(chunks()[0].options).toMatchObject({ asRoot: true });
  });

  it("prepares a box once: tools checked, root-only inbox and results made", async () => {
    await runOnce();
    await runOnce();
    const prepares = calls().filter(c =>
      c.command.includes("/var/lib/mako-connectors/incoming'"),
    );
    expect(prepares).toHaveLength(1);
    expect(prepares[0].command).toContain("command -v");
    expect(prepares[0].command).toContain(
      "install -d -o root -g root -m 0700 '/var/lib/mako-connectors/incoming' '/var/lib/mako-connectors/results'",
    );
    expect(prepares[0].options).toMatchObject({ asRoot: true });
  });

  it("writes the credential into the root-only inbox, then hands it to the run user", async () => {
    await runOnce();
    const chunk = chunks()[0].command;
    const dir = dirOf(chunk);
    const user = userOf(chunk);
    const runId = dir?.split("/").at(-1);
    const [, files, options] = sandbox.writeFiles.mock.calls[0];
    expect(files.map((f: { path: string }) => f.path)).toEqual([
      `/var/lib/mako-connectors/incoming/${runId}/config.json`,
      `/var/lib/mako-connectors/incoming/${runId}/state.json`,
    ]);
    expect(options).toEqual({ asRoot: true, expectSandboxId: "sbx_1" });
    expect(chunk).toContain(
      `mv -- '/var/lib/mako-connectors/incoming/${runId}/config.json' '${dir}/stage/config.json'`,
    );
    expect(chunk).toContain(
      `chown '${user}:${user}' '${dir}/stage/config.json' '${dir}/stage/state.json' && chmod 0400`,
    );
    expect(chunk).toContain(`--config' '${dir}/config.json'`);
    // stdout opened by root on a root-only file, after runuser drops privileges.
    expect(chunk).toMatch(
      new RegExp(`runuser -u '${user}' -- .* > '${dir}/out/out\\.jsonl'`),
    );
    expect(chunk).toContain(`cd '${dir}/home'`);
    // The bounded copy outlives the run directory, root-only.
    expect(chunk).toContain(
      `> '/var/lib/mako-connectors/results/${runId}.jsonl'`,
    );
    expect(sandbox.readFile).toHaveBeenCalledWith(
      ctx,
      `/var/lib/mako-connectors/results/${runId}.jsonl`,
      { asRoot: true, expectSandboxId: "sbx_1" },
    );
  });

  it("kills the run user's processes without procps, then deletes its files, IPC and the user", async () => {
    await runOnce();
    const chunk = chunks()[0].command;
    expect(chunk).toContain('runuser -u "$user" -- kill -9 -1');
    expect(chunk).not.toContain("pkill");
    expect(chunk).toContain("/proc/sysvipc");
    expect(chunk).toContain("/tmp /var/tmp /dev/shm /run/lock /dev/mqueue");
  });

  it("reports a failed cleanup instead of swallowing it", async () => {
    chunkStdout = () => `MAKO_CHUNK ${Buffer.byteLength(protocol)} 3\n`;
    const onCleanupFailure = vi.fn();
    const output = await runOnce(onCleanupFailure);
    expect(output.messages).toHaveLength(1);
    expect(onCleanupFailure).toHaveBeenCalledWith(
      expect.stringContaining("would not die"),
    );
  });

  it("gives two concurrent runs in one box different users and directories", async () => {
    await Promise.all([runOnce(), runOnce()]);
    const users = chunks().map(c => userOf(c.command));
    const dirs = chunks().map(c => dirOf(c.command));
    expect(users).toHaveLength(2);
    expect(new Set(users).size).toBe(2);
    expect(new Set(dirs).size).toBe(2);
    for (const [index, chunk] of chunks().entries()) {
      expect(chunk.command).toContain(`> '${dirs[index]}/out/out.jsonl'`);
      expect(chunk.command).toContain(`${dirs[index]}/config.json`);
    }
  });

  it("retries with a new user when one cannot be created, then refuses", async () => {
    chunkStdout = () => "MAKO_CHUNK setup-failed\n";
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("/var/lib/mako-connectors/incoming'")) {
        return Promise.resolve({ ...result(), sandboxId: "sbx_1" });
      }
      if (command.includes("mako-connector.js")) {
        return Promise.resolve({
          ...result(chunkStdout()),
          exitCode: 97,
          stderr: "groupadd: GID not unique",
        });
      }
      return Promise.resolve(result());
    });
    await expect(runOnce()).rejects.toThrow(/isolated user.*GID not unique/);
    expect(chunks()).toHaveLength(3);
    expect(new Set(chunks().map(c => userOf(c.command))).size).toBe(3);
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it("runs the cleanup on its own, awaited, when the command was cut off", async () => {
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("/var/lib/mako-connectors/incoming'")) {
        return Promise.resolve({ ...result(), sandboxId: "sbx_1" });
      }
      if (command.includes("mako-connector.js")) {
        return Promise.resolve({ ...result(), exitCode: 124, timedOut: true });
      }
      return Promise.resolve(result());
    });
    const output = await runOnce();
    expect(output.timedOut).toBe(true);
    const runId = dirOf(chunks()[0].command)?.split("/").at(-1);
    const abandon = calls().find(
      c =>
        c.command.includes('userdel "$user" ||') &&
        !c.command.includes("mako-connector.js"),
    );
    expect(abandon?.command).toContain(
      `'/var/lib/mako-connectors/incoming/${runId}'`,
    );
    expect(abandon?.options).toMatchObject({
      asRoot: true,
      expectSandboxId: "sbx_1",
    });
  });

  it("writes the runtime and connector folders as root under /var/lib, read-only to runs", async () => {
    await materializeConnector({
      ctx,
      runtimeId: "runtime",
      slug: "acme",
      sourceSha: "abc",
      files: new Map([["connector.ts", new TextEncoder().encode("x")]]),
    });

    for (const call of sandbox.writeFile.mock.calls) {
      expect(call[1]).toMatch(
        /^\/var\/lib\/mako-connectors\/runtime\/versions\//,
      );
      expect(call[3]).toEqual({ asRoot: true });
    }
    expect(
      calls().some(
        c =>
          c.command.includes("chmod -R a+rX,go-w") &&
          c.options?.asRoot === true,
      ),
    ).toBe(true);
  });

  it("moves the workspace sync box to a new key and retires the old one once", async () => {
    const destroySession = vi.fn(async () => undefined);
    Object.assign(sandbox, { destroySession });
    try {
      expect(syncBoxContext("ws1")).toEqual({
        sessionKey: "connector-sync:v2:ws1",
      });
      await retireLegacySyncBox("ws1");
      await retireLegacySyncBox("ws1");
      expect(destroySession).toHaveBeenCalledTimes(1);
      expect(destroySession).toHaveBeenCalledWith("connector-sync:ws1");
    } finally {
      Object.assign(sandbox, { destroySession: undefined });
    }
  });

  it("retries retiring the old box after a failed kill", async () => {
    const destroySession = vi
      .fn()
      .mockRejectedValueOnce(new Error("list failed"))
      .mockResolvedValue(undefined);
    Object.assign(sandbox, { destroySession });
    try {
      await retireLegacySyncBox("ws2");
      await retireLegacySyncBox("ws2");
      expect(destroySession).toHaveBeenCalledTimes(2);
    } finally {
      Object.assign(sandbox, { destroySession: undefined });
    }
  });
});

describe("providers without real users keep one shared user", () => {
  beforeEach(() => {
    sandbox.supportsRunUsers = undefined;
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFile.mockReset();
    sandbox.exec.mockResolvedValue(result(bounded("missing")));
  });

  it("never calls useradd or runuser and never asks for root", async () => {
    await runConnectorCommand({
      ctx: { sessionKey: "connector-sync:test" },
      runtimeId: "runtime",
      connectorDir: "/scratch/connector",
      command: "spec",
    });
    for (const [, command, options] of sandbox.exec.mock.calls) {
      expect(String(command)).not.toMatch(/useradd|runuser/);
      expect((options as { asRoot?: boolean })?.asRoot).toBeUndefined();
    }
  });
});

describe("isolation preflight", () => {
  beforeEach(() => {
    sandbox.supportsRunUsers = true;
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFile.mockReset();
  });
  afterEach(() => {
    sandbox.supportsRunUsers = undefined;
  });

  it("names the missing tools and refuses the run before creating any user", async () => {
    sandbox.exec.mockImplementation((_ctx, command: string) =>
      Promise.resolve(
        command.includes("command -v") && !command.includes("useradd -l")
          ? result("runuser\ngroupadd\n")
          : result(),
      ),
    );

    await expect(
      runConnectorCommand({
        ctx: { sessionKey: "connector-box:no-tools" },
        runtimeId: "runtime",
        connectorDir: "/x",
        command: "spec",
      }),
    ).rejects.toThrow(
      "cannot isolate connector runs: missing runuser, groupadd",
    );
    expect(
      sandbox.exec.mock.calls.some(([, command]) =>
        String(command).includes("useradd -l"),
      ),
    ).toBe(false);
  });
});

describe("a box replaced under a run", () => {
  let n = 0;
  let ctx = { sessionKey: "connector-sync:v2:ws-0" };
  beforeEach(() => {
    n++;
    ctx = { sessionKey: `connector-sync:v2:ws-${n}` };
    sandbox.supportsRunUsers = true;
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFile.mockReset();
    sandbox.writeFiles.mockReset();
  });
  afterEach(() => {
    sandbox.supportsRunUsers = undefined;
  });

  const answer = (chunk: string) =>
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("/var/lib/mako-connectors/incoming'")) {
        return Promise.resolve({ ...result(), sandboxId: "sbx_1" });
      }
      if (command.includes("mako-connector.js")) {
        return Promise.resolve({ ...result(chunk), sandboxId: "sbx_1" });
      }
      return Promise.resolve(result());
    });
  const run = () =>
    runConnectorCommand({
      ctx,
      runtimeId: "runtime",
      connectorDir: "/x",
      command: "read",
      config: { apiKey: "secret" },
    });

  it("pins every call of the run to the box that was prepared", async () => {
    const protocol = `${JSON.stringify({ type: "STATE", state: {} })}\n`;
    answer(`MAKO_CHUNK ${Buffer.byteLength(protocol)} 0\n`);
    sandbox.readFile.mockResolvedValue(new TextEncoder().encode(protocol));
    await run();
    const runCalls = sandbox.exec.mock.calls.filter(
      ([, command]) =>
        !String(command).includes("/var/lib/mako-connectors/incoming'"),
    );
    expect(runCalls).toHaveLength(2); // the chunk, the result removal
    for (const [, , options] of runCalls) {
      expect(options).toMatchObject({ asRoot: true, expectSandboxId: "sbx_1" });
    }
    expect(sandbox.writeFiles.mock.calls[0]?.[2]).toEqual({
      asRoot: true,
      expectSandboxId: "sbx_1",
    });
    expect(sandbox.readFile.mock.calls[0]?.[2]).toEqual({
      asRoot: true,
      expectSandboxId: "sbx_1",
    });
  });

  it("fails the chunk when the output file is missing after a clean exit", async () => {
    answer("MAKO_CHUNK missing 0\n");
    await expect(run()).rejects.toThrow(/box was replaced during the run/);
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it("fails the chunk when the inputs never reached the box it ran in", async () => {
    answer("MAKO_CHUNK inputs-missing 0\n");
    await expect(run()).rejects.toThrow(/inputs are missing/);
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it("fails, and prepares the next box afresh, when the pinned box is gone", async () => {
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("/var/lib/mako-connectors/incoming'")) {
        return Promise.resolve({ ...result(), sandboxId: "sbx_1" });
      }
      return Promise.resolve(result());
    });
    sandbox.writeFiles.mockRejectedValueOnce(
      Object.assign(new Error("Sandbox sbx_1 was replaced or is gone."), {
        name: "SandboxNotFoundError",
      }),
    );
    await expect(run()).rejects.toThrow(/replaced or is gone/);
    sandbox.writeFiles.mockResolvedValue(undefined);
    await expect(run()).rejects.toThrow();
    const prepares = sandbox.exec.mock.calls.filter(([, command]) =>
      String(command).includes("/var/lib/mako-connectors/incoming'"),
    );
    expect(prepares).toHaveLength(2);
  });
});

describe("box hardening", () => {
  let n = 0;
  beforeEach(() => {
    sandbox.supportsRunUsers = true;
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFile.mockReset();
    sandbox.writeFiles.mockReset();
  });
  afterEach(() => {
    sandbox.supportsRunUsers = undefined;
  });
  const prepared = (command: string) =>
    command.includes("/var/lib/mako-connectors/incoming'");

  it("locks passwordless accounts in every run's command, and refuses the run if it cannot", async () => {
    sandbox.exec.mockImplementation((_ctx, command: string) =>
      Promise.resolve(
        prepared(command)
          ? { ...result(), sandboxId: "sbx_1" }
          : command.includes("mako-connector.js")
            ? {
                ...result("MAKO_CHUNK setup-failed\n"),
                exitCode: 97,
                stderr: "empty passwords left: root",
              }
            : result(),
      ),
    );
    n++;
    await expect(
      runConnectorCommand({
        ctx: { sessionKey: `connector-box:soft-root-${n}` },
        runtimeId: "runtime",
        connectorDir: "/x",
        command: "spec",
      }),
    ).rejects.toThrow(/isolated user.*empty passwords left: root/);
    const chunks = sandbox.exec.mock.calls.filter(([, c]) =>
      String(c).includes("mako-connector.js"),
    );
    // No retry with a fresh uid can help a box whose accounts cannot be
    // locked. The lock runs as root, inside setup, before useradd.
    expect(chunks).toHaveLength(1);
    const chunk = String(chunks[0]?.[1]);
    expect(chunks[0]?.[2]).toMatchObject({ asRoot: true });
    expect(chunk.indexOf("usermod -p")).toBeGreaterThan(-1);
    expect(chunk.indexOf("usermod -p")).toBeLessThan(
      chunk.indexOf("useradd -l"),
    );
    expect(chunk.indexOf("useradd -l")).toBeLessThan(
      chunk.indexOf("runuser -u '"),
    );
  });

  it("runs the lock on every run, not once per box key", async () => {
    sandbox.exec.mockImplementation((_ctx, command: string) =>
      Promise.resolve(
        prepared(command)
          ? { ...result(), sandboxId: "sbx_1" }
          : command.includes("mako-connector.js")
            ? result("MAKO_CHUNK 0 0\n")
            : result(),
      ),
    );
    n++;
    const ctx = { sessionKey: `connector-sync:v2:replaced-${n}` };
    for (let i = 0; i < 2; i++) {
      await runConnectorCommand({
        ctx,
        runtimeId: "runtime",
        connectorDir: "/x",
        command: "spec",
      });
    }
    expect(
      sandbox.exec.mock.calls.filter(([, c]) =>
        String(c).includes("usermod -p"),
      ),
    ).toHaveLength(2);
  });
});
