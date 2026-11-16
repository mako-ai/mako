/**
 * The E2B provider after an account move (a new E2B_API_KEY).
 *
 * Nothing durable names a box: the provider finds a session's box by its
 * `makoAppsSessionKey` metadata, and the only remembered id is an in-process
 * map. So after the key changes, a box id from the old account must lead to a
 * fresh box in the new one, never to an error. These specs pin that, with the
 * SDK mocked so no real box is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const e2b = vi.hoisted(() => {
  class SandboxNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SandboxNotFoundError";
    }
  }
  const fakeBox = (sandboxId: string) => ({
    sandboxId,
    setTimeout: vi.fn(async () => undefined),
    getHost: (port: number) => `${port}-${sandboxId}.e2b.app`,
    commands: {
      // Started in the background, then awaited (e2b-provider startCommand);
      // the create path still runs one command directly.
      run: vi.fn(async (_cmd: string, opts?: { background?: boolean }) =>
        opts?.background
          ? {
              pid: 1,
              wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
            }
          : { exitCode: 0, stdout: "", stderr: "" },
      ),
    },
  });
  const listed: { items: Array<{ sandboxId: string; startedAt?: Date }> } = {
    items: [],
  };
  const Sandbox = {
    connect: vi.fn(async (id: string) => fakeBox(id)),
    create: vi.fn(async () => fakeBox("new-account-box")),
    kill: vi.fn(async () => true),
    list: vi.fn(() => ({
      hasNext: true,
      nextItems: async () => listed.items,
    })),
  };
  return { Sandbox, SandboxNotFoundError, listed, fakeBox };
});

vi.mock("e2b", async importOriginal => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: e2b.Sandbox,
  SandboxNotFoundError: e2b.SandboxNotFoundError,
}));

import {
  e2bSandboxProvider,
  pinE2bSession,
  resetE2bProviderStateForTests,
  useE2bPinnedSessionsOnly,
} from "./e2b-provider";

const sessionKey = "6846e6a01b05af0948070582:user-1";
const ctx = { sessionKey };

describe("e2b provider after an account move", () => {
  beforeEach(() => {
    process.env.E2B_API_KEY = "test-key-not-a-secret";
    process.env.APPS_E2B_TEMPLATE = "mako-apps";
    resetE2bProviderStateForTests();
    vi.clearAllMocks();
    e2b.listed.items = [];
    e2b.Sandbox.connect.mockImplementation(async (id: string) =>
      e2b.fakeBox(id),
    );
  });
  afterEach(() => {
    resetE2bProviderStateForTests();
  });

  it("a remembered old-account box id leads to a fresh box", async () => {
    pinE2bSession(sessionKey, "old-account-box");
    e2b.Sandbox.connect.mockImplementation(async (id: string) => {
      if (id === "old-account-box") {
        throw new e2b.SandboxNotFoundError("Sandbox old-account-box not found");
      }
      return e2b.fakeBox(id);
    });

    const result = await e2bSandboxProvider.exec(ctx, "true");

    expect(result.exitCode).toBe(0);
    expect(e2b.Sandbox.create).toHaveBeenCalledTimes(1);
    expect(e2b.Sandbox.create).toHaveBeenCalledWith(
      "mako-apps",
      expect.objectContaining({
        metadata: { makoAppsSessionKey: sessionKey },
      }),
    );
  });

  it("a listed box that will not connect leads to a fresh box", async () => {
    e2b.listed.items = [{ sandboxId: "vanished-box", startedAt: new Date() }];
    e2b.Sandbox.connect.mockImplementation(async (id: string) => {
      if (id === "vanished-box") {
        throw new e2b.SandboxNotFoundError("Sandbox vanished-box not found");
      }
      return e2b.fakeBox(id);
    });

    await e2bSandboxProvider.exec(ctx, "true");

    expect(e2b.Sandbox.create).toHaveBeenCalledTimes(1);
  });

  it("an empty new account creates the first box with the configured template", async () => {
    await e2bSandboxProvider.exec(ctx, "true");
    expect(e2b.Sandbox.create).toHaveBeenCalledWith(
      "mako-apps",
      expect.anything(),
    );
  });

  it("pinned-only mode never lists, creates or kills", async () => {
    useE2bPinnedSessionsOnly();
    await expect(e2bSandboxProvider.exec(ctx, "true")).rejects.toThrow(
      /no sandbox is pinned/,
    );
    pinE2bSession(sessionKey, "paused-box");
    await e2bSandboxProvider.exec(ctx, "true");

    expect(e2b.Sandbox.connect).toHaveBeenCalledWith(
      "paused-box",
      expect.anything(),
    );
    expect(e2b.Sandbox.list).not.toHaveBeenCalled();
    expect(e2b.Sandbox.create).not.toHaveBeenCalled();
    expect(e2b.Sandbox.kill).not.toHaveBeenCalled();
  });

  it("pinned-only mode surfaces a dead pinned box instead of replacing it", async () => {
    useE2bPinnedSessionsOnly();
    pinE2bSession(sessionKey, "gone-box");
    e2b.Sandbox.connect.mockImplementation(async () => {
      throw new e2b.SandboxNotFoundError("Sandbox gone-box not found");
    });
    await expect(e2bSandboxProvider.exec(ctx, "true")).rejects.toThrow(
      /not found/,
    );
    expect(e2b.Sandbox.create).not.toHaveBeenCalled();
  });

  it("sessionSandboxIds lists ids and throws when the list fails", async () => {
    e2b.listed.items = [{ sandboxId: "a" }, { sandboxId: "b" }];
    expect(await e2bSandboxProvider.sessionSandboxIds?.(ctx)).toEqual([
      "a",
      "b",
    ]);
    e2b.Sandbox.list.mockImplementationOnce(() => {
      throw new Error("list API down");
    });
    await expect(e2bSandboxProvider.sessionSandboxIds?.(ctx)).rejects.toThrow(
      /list API down/,
    );
  });
});
