import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  exec: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  writeFiles: vi.fn(),
  scratch: vi.fn(() => "/scratch"),
}));

vi.mock("../../apps/sandbox/provider", () => ({
  getSandboxProvider: () => sandbox,
}));

import {
  CONNECTOR_NODE_VERSION,
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
