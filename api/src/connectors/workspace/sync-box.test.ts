import { beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  exec: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  scratch: vi.fn(() => "/scratch"),
}));

vi.mock("../../apps/sandbox/provider", () => ({
  getSandboxProvider: () => sandbox,
}));

import {
  CONNECTOR_NODE_VERSION,
  MAX_CONNECTOR_PROTOCOL_BYTES,
  MAX_CONNECTOR_PROTOCOL_MESSAGES,
  installConnectorRuntime,
  runConnectorCommand,
} from "./sync-box";

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
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("head -c")) {
        return Promise.resolve(result(`${MAX_CONNECTOR_PROTOCOL_BYTES + 1}\n`));
      }
      return Promise.resolve(result());
    });
  });

  it("runs connector commands with the runtime's pinned Node", async () => {
    const protocol = `${JSON.stringify({ type: "STATE", state: {} })}\n`;
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("head -c")) {
        return Promise.resolve(result(`${Buffer.byteLength(protocol)}\n`));
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
    ).rejects.toThrow(/protocol output exceeded/);

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
        return Promise.resolve(result(`${Buffer.byteLength(protocol)}\n`));
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
        return Promise.resolve(result(`${Buffer.byteLength(protocol)}\n`));
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
