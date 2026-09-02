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
  MAX_CONNECTOR_PROTOCOL_BYTES,
  MAX_CONNECTOR_PROTOCOL_MESSAGES,
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
