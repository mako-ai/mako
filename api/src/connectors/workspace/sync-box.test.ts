import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  supportsRunUsers: undefined as boolean | undefined,
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
  materializeConnector,
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

/**
 * Credential isolation between runs that share a box.
 *
 * Before per-run users every command ran as the template user, so a run could
 * read a concurrent run's config.json (another connection's credential) or
 * leave a process behind to read later ones. These pin the fix: each run gets
 * its own Unix user and a 0700 directory, the connector starts under
 * `runuser`, and cleanup kills the user's processes and deletes the user.
 */
describe("per-run Unix users on providers with real users", () => {
  const ctx = { sessionKey: "connector-box:test" };
  const protocol = `${JSON.stringify({ type: "STATE", state: {} })}\n`;

  beforeEach(() => {
    sandbox.supportsRunUsers = true;
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFile.mockReset();
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("head -c")) {
        return Promise.resolve(result(`${Buffer.byteLength(protocol)}\n`));
      }
      return Promise.resolve(result());
    });
    sandbox.readFile.mockResolvedValue(new TextEncoder().encode(protocol));
  });

  afterEach(() => {
    sandbox.supportsRunUsers = undefined;
  });

  const runOnce = () =>
    runConnectorCommand({
      ctx,
      runtimeId: "runtime",
      connectorDir: "/scratch/connector",
      command: "read",
      config: { apiKey: "secret" },
    });

  const userOf = (command: string) =>
    /user='(mkc[0-9a-f]+)'/.exec(command)?.[1];

  it("creates a run user that alone owns a 0700 run directory", async () => {
    await runOnce();

    const [setupCall] = sandbox.exec.mock.calls.filter(([, command]) =>
      String(command).includes("useradd"),
    );
    expect(setupCall).toBeDefined();
    const setup = String(setupCall?.[1]);
    expect(setupCall?.[2]).toMatchObject({ asRoot: true });
    expect(setup).toContain('chmod 0711 "$runs"');
    expect(setup).toContain('mkdir -m 0700 "$dir"');
    expect(setup).toContain('chown "$user:$user" "$dir"');
    expect(userOf(setup)).toMatch(/^mkc[0-9a-f]{12}$/);
  });

  it("writes the credential as root and hands it to the run user read-only", async () => {
    await runOnce();

    const config = sandbox.writeFile.mock.calls.find(([, file]) =>
      String(file).endsWith("/config.json"),
    );
    expect(config?.[3]).toEqual({ asRoot: true });
    const run = sandbox.exec.mock.calls.find(([, command]) =>
      String(command).includes("mako-connector.js"),
    );
    const user = userOf(
      String(
        sandbox.exec.mock.calls.find(([, c]) =>
          String(c).includes("useradd"),
        )?.[1],
      ),
    );
    expect(run?.[1]).toContain(`chown '${user}:${user}'`);
    expect(run?.[1]).toContain("chmod 0400");
    expect(run?.[1]).toContain(`runuser -u '${user}' --`);
    expect(sandbox.readFile).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("out.bounded.jsonl"),
      { asRoot: true },
    );
  });

  it("kills the run user's processes, deletes its files and the user", async () => {
    await runOnce();

    const cleanup = sandbox.exec.mock.calls.find(([, command]) =>
      String(command).includes("pkill"),
    );
    expect(cleanup?.[2]).toMatchObject({ asRoot: true });
    expect(cleanup?.[1]).toContain('pkill -KILL -u "$user"');
    expect(cleanup?.[1]).toContain("find /tmp /var/tmp /dev/shm");
    expect(cleanup?.[1]).toContain("rm -rf '/scratch/connector-runs/");
    expect(cleanup?.[1]).toContain('userdel "$user"');
  });

  it("gives two concurrent runs in one box different users and directories", async () => {
    await Promise.all([runOnce(), runOnce()]);

    const setups = sandbox.exec.mock.calls
      .map(([, command]) => String(command))
      .filter(command => command.includes("useradd"));
    expect(setups).toHaveLength(2);
    const users = setups.map(userOf);
    const dirs = setups.map(command => /dir='([^']+)'/.exec(command)?.[1]);
    expect(new Set(users).size).toBe(2);
    expect(new Set(dirs).size).toBe(2);

    // Each connector process runs as its own run's user, in its own dir.
    const runs = sandbox.exec.mock.calls
      .map(([, command]) => String(command))
      .filter(command => command.includes("mako-connector.js"));
    for (const [index, user] of users.entries()) {
      const mine = runs.find(command =>
        command.includes(`runuser -u '${user}'`),
      );
      expect(mine).toContain(`cd '${dirs[index]}'`);
      expect(mine).toContain(`${dirs[index]}/config.json`);
    }
  });

  it("refuses to run when no isolated user can be created", async () => {
    sandbox.exec.mockImplementation((_ctx, command: string) =>
      Promise.resolve(
        command.includes("useradd")
          ? { ...result(), exitCode: 1, stderr: "useradd: not found" }
          : result(),
      ),
    );

    await expect(runOnce()).rejects.toThrow(/isolated user/);
    expect(
      sandbox.exec.mock.calls.some(([, command]) =>
        String(command).includes("mako-connector.js"),
      ),
    ).toBe(false);
  });

  it("writes the runtime and connector folders as root and read-only to runs", async () => {
    await materializeConnector({
      ctx,
      runtimeId: "runtime",
      slug: "acme",
      sourceSha: "abc",
      files: new Map([["connector.ts", new TextEncoder().encode("x")]]),
    });

    for (const call of sandbox.writeFile.mock.calls) {
      expect(call[1]).toContain("/connector-runtime/isolated/versions/");
      expect(call[3]).toEqual({ asRoot: true });
    }
    expect(
      sandbox.exec.mock.calls.some(
        ([, command, options]) =>
          String(command).includes("chmod -R a+rX,go-w") &&
          (options as { asRoot?: boolean })?.asRoot === true,
      ),
    ).toBe(true);
  });
});

describe("providers without real users keep one shared user", () => {
  beforeEach(() => {
    sandbox.supportsRunUsers = undefined;
    sandbox.exec.mockReset();
    sandbox.readFile.mockReset();
    sandbox.writeFile.mockReset();
    sandbox.exec.mockResolvedValue(result("missing\n"));
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
