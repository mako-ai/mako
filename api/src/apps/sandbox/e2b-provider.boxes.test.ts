/**
 * The E2B provider's rules for leased connector boxes, with the E2B SDK
 * mocked (no account, no network):
 *
 * - only boxLifecycle.create may create a `connector-box:*` sandbox, so a
 *   box the reaper killed never comes back untracked under a run's next call;
 * - destroySession fails when it could neither list nor remember a box,
 *   so a kill is never recorded for a box that still runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const e2b = vi.hoisted(() => {
  class SandboxNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SandboxNotFoundError";
    }
  }
  const sandbox = {
    sandboxId: "sbx_new",
    setTimeout: vi.fn(async () => undefined),
    commands: {
      run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    },
  };
  const page: { items: Array<{ sandboxId: string }> } = { items: [] };
  const Sandbox = {
    list: vi.fn(() => ({
      hasNext: true,
      nextItems: vi.fn(async () => page.items),
    })),
    connect: vi.fn(async (_id: string): Promise<typeof sandbox> => {
      throw new SandboxNotFoundError("Sandbox is probably not running anymore");
    }),
    create: vi.fn(async () => sandbox),
    kill: vi.fn(async () => true),
  };
  return { Sandbox, SandboxNotFoundError, sandbox, page };
});

vi.mock("e2b", () => ({
  Sandbox: e2b.Sandbox,
  SandboxNotFoundError: e2b.SandboxNotFoundError,
}));

import { e2bSandboxProvider } from "./e2b-provider";

beforeEach(() => {
  process.env.E2B_API_KEY = "test-key-not-real";
  e2b.page.items = [];
  e2b.Sandbox.create.mockClear();
  e2b.Sandbox.kill.mockClear();
  e2b.Sandbox.list.mockClear();
});

describe("connector boxes on E2B", () => {
  it("never recreates a killed connector box from an ordinary call", async () => {
    const ctx = { sessionKey: "connector-box:cbx_gone" };

    await expect(e2bSandboxProvider.exec(ctx, "true")).rejects.toThrow(
      /only its scheduler may create it/,
    );
    await expect(
      e2bSandboxProvider.writeFile(ctx, "/tmp/x", new Uint8Array([1])),
    ).rejects.toThrow(/only its scheduler may create it/);
    expect(e2b.Sandbox.create).not.toHaveBeenCalled();
  });

  it("creates a connector box through boxLifecycle.create, from a template", async () => {
    await e2bSandboxProvider.boxLifecycle?.create("connector-box:cbx_new", {
      template: "snap:mako-cbox-abc",
    });
    expect(e2b.Sandbox.create).toHaveBeenCalledWith(
      "snap:mako-cbox-abc",
      expect.objectContaining({
        metadata: { makoAppsSessionKey: "connector-box:cbx_new" },
      }),
    );
  });

  it("still creates app sessions on demand", async () => {
    await e2bSandboxProvider.exec({ sessionKey: "worktree-123" }, "true");
    expect(e2b.Sandbox.create).toHaveBeenCalledTimes(1);
  });

  it("fails a kill that could neither list nor remember the box", async () => {
    e2b.Sandbox.list.mockImplementationOnce(() => {
      throw new Error("E2B API unreachable");
    });
    await expect(
      e2bSandboxProvider.destroySession?.("connector-box:cbx_unknown"),
    ).rejects.toThrow(/list call failed/);
    expect(e2b.Sandbox.kill).not.toHaveBeenCalled();
  });

  it("fails a connector box kill the API refused", async () => {
    e2b.page.items = [{ sandboxId: "sbx_1" }];
    e2b.Sandbox.kill.mockRejectedValueOnce(new Error("500"));
    await expect(
      e2bSandboxProvider.destroySession?.("connector-box:cbx_1"),
    ).rejects.toThrow(/Could not kill 1 of 1/);
  });

  it("kills every listed box and succeeds", async () => {
    e2b.page.items = [{ sandboxId: "sbx_1" }, { sandboxId: "sbx_2" }];
    await e2bSandboxProvider.destroySession?.("connector-box:cbx_2");
    expect(e2b.Sandbox.kill).toHaveBeenCalledTimes(2);
  });
});

describe("legacy sync box kills", () => {
  it("fails, so it is retried, when the old box would not die", async () => {
    e2b.page.items = [{ sandboxId: "sbx_old" }];
    e2b.Sandbox.kill.mockRejectedValueOnce(new Error("500"));
    await expect(
      e2bSandboxProvider.destroySession?.("connector-sync:ws1"),
    ).rejects.toThrow(/Could not kill 1 of 1/);
  });

  it("still swallows a failed kill for an app session, as before", async () => {
    e2b.page.items = [{ sandboxId: "sbx_app" }];
    e2b.Sandbox.kill.mockRejectedValueOnce(new Error("500"));
    await expect(
      e2bSandboxProvider.destroySession?.("worktree-1"),
    ).resolves.toBeUndefined();
  });
});

describe("a run pinned to its sandbox", () => {
  it("refuses a sync box that was replaced under the run", async () => {
    // The key now resolves to a new box; the run started in sbx_old, gone.
    e2b.page.items = [{ sandboxId: "sbx_new" }];
    e2b.Sandbox.connect.mockImplementation(async (id: string) => {
      if (id === "sbx_old") {
        throw new e2b.SandboxNotFoundError(
          "Sandbox is probably not running anymore",
        );
      }
      return { ...e2b.sandbox, sandboxId: id };
    });
    const ctx = { sessionKey: "connector-sync:v2:ws-pinned" };

    await expect(
      e2bSandboxProvider.exec(ctx, "true", { expectSandboxId: "sbx_old" }),
    ).rejects.toThrow(/was replaced or is gone/);
    await expect(
      e2bSandboxProvider.readFile(ctx, "/x", { expectSandboxId: "sbx_old" }),
    ).rejects.toThrow(/was replaced or is gone/);
    expect(e2b.Sandbox.create).not.toHaveBeenCalled();
  });
});

describe("a pinned call whose connect fails", () => {
  const ctx = { sessionKey: "connector-sync:v2:ws-transient" };

  it("rethrows a transient error as-is, never as a gone box", async () => {
    e2b.page.items = [{ sandboxId: "sbx_live" }];
    e2b.Sandbox.connect.mockImplementation(async () => {
      throw new Error("503 Service Unavailable");
    });
    const failure = await e2bSandboxProvider
      .exec(ctx, "true", { expectSandboxId: "sbx_pinned" })
      .catch((error: unknown) => error);
    expect(String(failure)).toContain("503 Service Unavailable");
    expect((failure as Error).name).not.toBe("SandboxNotFoundError");
  });

  it("rethrows a transient error when the pinned id is this process's cached session too", async () => {
    // Create the session through the scheduler path so the id is cached.
    e2b.Sandbox.create.mockResolvedValueOnce({
      ...e2b.sandbox,
      sandboxId: "sbx_cached",
    });
    e2b.page.items = [];
    await e2bSandboxProvider.boxLifecycle?.create(
      "connector-box:cbx_cached",
      {},
    );
    e2b.page.items = [{ sandboxId: "sbx_cached" }];
    e2b.Sandbox.connect.mockImplementation(async () => {
      throw new Error("503 Service Unavailable");
    });
    const failure = await e2bSandboxProvider
      .exec({ sessionKey: "connector-box:cbx_cached" }, "true", {
        expectSandboxId: "sbx_cached",
      })
      .catch((error: unknown) => error);
    expect(String(failure)).toContain("503 Service Unavailable");
    expect((failure as Error).name).not.toBe("SandboxNotFoundError");
  });

  it("labels a not-found answer as gone", async () => {
    e2b.Sandbox.connect.mockImplementation(async () => {
      throw new e2b.SandboxNotFoundError(
        "Sandbox is probably not running anymore",
      );
    });
    await expect(
      e2bSandboxProvider.exec(ctx, "true", { expectSandboxId: "sbx_pinned" }),
    ).rejects.toThrow(/was replaced or is gone/);
  });
});
