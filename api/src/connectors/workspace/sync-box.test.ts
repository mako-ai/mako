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
  retireLegacySyncBox,
  syncBoxContext,
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

  const runOnce = (onCleanupFailure?: (reason: string) => void) =>
    runConnectorCommand({
      ctx,
      runtimeId: "runtime",
      connectorDir:
        "/var/lib/mako-connectors/runtime/versions/runtime/connectors/acme@abc",
      command: "read",
      config: { apiKey: "secret" },
      onCleanupFailure,
    });

  const calls = () =>
    sandbox.exec.mock.calls.map(([, command, options]) => ({
      command: String(command),
      asRoot: (options as { asRoot?: boolean } | undefined)?.asRoot === true,
    }));
  const userOf = (command: string) =>
    /user='(mkc[0-9a-f]+)'/.exec(command)?.[1];
  const dirOf = (command: string) => /R='([^']+)'/.exec(command)?.[1];

  it("creates a run user, its home and a root-only output directory, as root", async () => {
    await runOnce();

    const setup = calls().find(c => c.command.includes("useradd -l"));
    expect(setup?.asRoot).toBe(true);
    expect(setup?.command).toContain('useradd -l -M -u "$uid" -g "$gid"');
    expect(setup?.command).toContain('groupadd -g "$gid"');
    expect(setup?.command).toContain(
      "install -d -o root -g root -m 0711 '/var/lib/mako-connectors/runs'",
    );
    expect(setup?.command).toContain('install -d -o root -g root -m 0711 "$R"');
    expect(setup?.command).toContain(
      'install -d -o "$user" -g "$user" -m 0700 "$R/home"',
    );
    expect(setup?.command).toContain(
      'install -d -o root -g root -m 0700 "$R/out"',
    );
    expect(userOf(setup?.command ?? "")).toMatch(/^mkc[0-9a-f]{12}$/);
  });

  it("opens stdout as root on a root-only file, so root never follows a path the run controls", async () => {
    await runOnce();

    const dir = dirOf(
      calls().find(c => c.command.includes("useradd -l"))?.command ?? "",
    );
    const user = userOf(
      calls().find(c => c.command.includes("useradd -l"))?.command ?? "",
    );
    const launch = calls().find(c => c.command.includes("mako-connector.js"));
    expect(launch?.asRoot).toBe(true);
    // The redirect target is in out/ (root 0700), after runuser drops privileges.
    expect(launch?.command).toMatch(
      new RegExp(`runuser -u '${user}' -- .* > '${dir}/out/out\\.jsonl'$`),
    );
    expect(launch?.command).toContain(`cd '${dir}/home'`);
    // Inputs belong to root and are only readable by the run's group.
    // Inputs belong to the run user alone: no group can read them.
    expect(launch?.command).toContain(
      `chown '${user}:${user}' '${dir}/config.json'`,
    );
    expect(launch?.command).toContain("chmod 0400");
    // The bounded copy and the read stay in out/ too.
    const snapshot = calls().find(c => c.command.includes("head -c"));
    expect(snapshot?.asRoot).toBe(true);
    expect(snapshot?.command).toContain(`'${dir}/out/out.jsonl'`);
    expect(snapshot?.command).toContain(`> '${dir}/out/out.bounded.jsonl'`);
    expect(sandbox.readFile).toHaveBeenCalledWith(
      ctx,
      `${dir}/out/out.bounded.jsonl`,
      { asRoot: true },
    );
    const config = sandbox.writeFile.mock.calls.find(([, file]) =>
      String(file).endsWith("/config.json"),
    );
    expect(config?.[1]).toBe(`${dir}/config.json`);
    expect(config?.[3]).toEqual({ asRoot: true });
  });

  it("kills the run user's processes without procps, then deletes its files, IPC and the user", async () => {
    await runOnce();

    const cleanup = calls().find(c => c.command.includes('userdel "$user" ||'));
    expect(cleanup?.asRoot).toBe(true);
    expect(cleanup?.command).toContain('runuser -u "$user" -- kill -9 -1');
    expect(cleanup?.command).not.toContain("pkill");
    expect(cleanup?.command).toContain("/proc/sysvipc");
    expect(cleanup?.command).toContain(
      "/tmp /var/tmp /dev/shm /run/lock /dev/mqueue",
    );
  });

  it("reports a failed cleanup instead of swallowing it", async () => {
    sandbox.exec.mockImplementation((_ctx, command: string) => {
      if (command.includes("head -c")) {
        return Promise.resolve(result(`${Buffer.byteLength(protocol)}\n`));
      }
      if (command.includes("kill -9 -1")) {
        return Promise.resolve({ ...result(), exitCode: 3 });
      }
      return Promise.resolve(result());
    });
    const onCleanupFailure = vi.fn();

    const output = await runOnce(onCleanupFailure);

    expect(output.messages).toHaveLength(1);
    expect(onCleanupFailure).toHaveBeenCalledWith(
      expect.stringContaining("would not die"),
    );
  });

  it("gives two concurrent runs in one box different users and directories", async () => {
    await Promise.all([runOnce(), runOnce()]);

    const setups = calls().filter(c => c.command.includes("useradd -l"));
    expect(setups).toHaveLength(2);
    const users = setups.map(c => userOf(c.command));
    const dirs = setups.map(c => dirOf(c.command));
    expect(new Set(users).size).toBe(2);
    expect(new Set(dirs).size).toBe(2);
    const launches = calls().filter(c =>
      c.command.includes("mako-connector.js"),
    );
    for (const [index, user] of users.entries()) {
      const mine = launches.find(c =>
        c.command.includes(`runuser -u '${user}'`),
      );
      expect(mine?.command).toContain(`> '${dirs[index]}/out/out.jsonl'`);
      expect(mine?.command).toContain(`${dirs[index]}/config.json`);
    }
  });

  it("refuses to run when no isolated user can be created", async () => {
    sandbox.exec.mockImplementation((_ctx, command: string) =>
      Promise.resolve(
        command.includes("groupadd -g")
          ? { ...result(), exitCode: 1, stderr: "groupadd: GID not unique" }
          : result(),
      ),
    );

    await expect(runOnce()).rejects.toThrow(/isolated user/);
    expect(calls().some(c => c.command.includes("mako-connector.js"))).toBe(
      false,
    );
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
      calls().some(c => c.command.includes("chmod -R a+rX,go-w") && c.asRoot),
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
