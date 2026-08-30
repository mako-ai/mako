import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("./dev-server.service", () => ({
  discoverDevServers: vi.fn(async () => [{ slug: "other", port: 5174 }]),
}));
vi.mock("./sandbox/provider", () => ({
  getSandboxProvider: () => ({
    publicUrlForPort: async (_ctx: unknown, port: number) =>
      `https://${port}-box.example`,
    // The service resolves snapshot urls through the never-create peek.
    peekPublicUrlForPort: async (_ctx: unknown, port: number) =>
      `https://${port}-box.example`,
  }),
}));

import { publishRealtimeEvent } from "../services/realtime.service";
import { discoverDevServers } from "./dev-server.service";
import {
  forgetBoxState,
  getBoxState,
  patchBoxState,
  resetBoxStateStoreForTests,
} from "./box-state.service";

const ws = "6846e6a01b05af0948070582";
const user = "u1";
const key = `${ws}:${user}`;

describe("box-state (memory store)", () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
    resetBoxStateStoreForTests();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await forgetBoxState(key);
  });

  it("starts empty and forgets", async () => {
    expect(await getBoxState(key)).toBeNull();
    await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { branch: "main" },
      source: "t",
    });
    expect((await getBoxState(key))?.branch).toBe("main");
    await forgetBoxState(key);
    expect(await getBoxState(key)).toBeNull();
  });

  it("shapes porcelain lines into changes", async () => {
    const state = await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: {
        changes: [
          "?? apps/a/new.txt",
          " M apps/a/src/App.tsx",
          "D  apps/b/gone.ts",
          "R  old.ts -> new.ts",
        ],
      },
      source: "t",
    });
    // X = index, Y = working tree: untracked is unstaged only; " M" is
    // unstaged only; "D " and "R " are staged only.
    expect(state.changes).toEqual([
      {
        path: "apps/a/new.txt",
        status: "added",
        staged: false,
        unstaged: true,
      },
      {
        path: "apps/a/src/App.tsx",
        status: "modified",
        staged: false,
        unstaged: true,
      },
      {
        path: "apps/b/gone.ts",
        status: "deleted",
        staged: true,
        unstaged: false,
      },
      { path: "new.ts", status: "renamed", staged: true, unstaged: false },
    ]);
  });

  it("seeds a cold snapshot by discovery before applying a launcher delta", async () => {
    const state = await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { devServer: { slug: "hello", port: 5173, state: "serving" } },
      source: "launcher",
    });
    expect(discoverDevServers).toHaveBeenCalledTimes(1);
    expect(state.devServers?.map(d => d.slug).sort()).toEqual([
      "hello",
      "other",
    ]);
    expect(state.devServers?.find(d => d.slug === "hello")?.url).toBe(
      "https://5173-box.example",
    );
  });

  it("does not re-seed a warm snapshot and merges deltas", async () => {
    await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { devServers: [{ slug: "a", port: 5173 }] },
      source: "agent",
    });
    const after = await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { devServer: { slug: "b", port: 5174, state: "serving" } },
      source: "launcher",
    });
    expect(discoverDevServers).not.toHaveBeenCalled();
    expect(after.devServers?.map(d => d.slug).sort()).toEqual(["a", "b"]);
    const down = await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { devServer: { slug: "a", port: 5173, state: "down" } },
      source: "launcher",
    });
    expect(down.devServers?.map(d => d.slug)).toEqual(["b"]);
  });

  it("an agent snapshot replaces the list but keeps resolved urls", async () => {
    await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { devServers: [{ slug: "a", port: 5173 }] },
      source: "agent",
    });
    const next = await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { devServers: [{ slug: "a", port: 5173 }] },
      source: "agent",
    });
    expect(next.devServers?.[0].url).toBe("https://5173-box.example");
  });

  it("publishes a realtime event naming the user", async () => {
    await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { branch: "feature/x" },
      source: "hook",
    });
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ type: "app.box-state", userId: user }),
    );
  });
});
