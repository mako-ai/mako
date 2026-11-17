import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("./dev-server.service", () => ({
  discoverDevServers: vi.fn(async () => [{ slug: "other", port: 5174 }]),
}));
// What the provider says it holds for a session. undefined = a provider with
// no listing (local); a function lets a test answer or throw.
const held = vi.hoisted(() => ({
  ids: undefined as undefined | (() => Promise<string[]>),
}));
vi.mock("./sandbox/provider", () => ({
  getSandboxProvider: () => ({
    publicUrlForPort: async (_ctx: unknown, port: number) =>
      `https://${port}-box.example`,
    // The service resolves snapshot urls through the never-create peek.
    peekPublicUrlForPort: async (_ctx: unknown, port: number) =>
      `https://${port}-box.example`,
    ...(held.ids ? { sessionSandboxIds: held.ids } : {}),
  }),
}));

import { publishRealtimeEvent } from "../services/realtime.service";
import { discoverDevServers } from "./dev-server.service";
import {
  forgetBoxState,
  getBoxState,
  markBoxOffline,
  patchBoxState,
  probePreview,
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

describe("box-state after an E2B account move", () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
    resetBoxStateStoreForTests();
    vi.clearAllMocks();
    held.ids = undefined;
  });
  afterEach(async () => {
    held.ids = undefined;
    await forgetBoxState(key);
  });

  it("drops a report from an old-account box once the new account holds one", async () => {
    held.ids = async () => ["new-box"];
    await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { sandboxId: "new-box", branch: "main" },
      source: "agent",
    });
    const state = await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { sandboxId: "old-box", branch: "feature" },
      source: "agent",
    });
    expect(state.sandboxId).toBe("new-box");
    const stored = await getBoxState(key);
    expect(stored?.sandboxId).toBe("new-box");
    expect(stored?.branch).toBe("main");
    expect(publishRealtimeEvent).toHaveBeenCalledTimes(1);
  });

  it("accepts a new box the provider does not list yet", async () => {
    held.ids = async () => [];
    const state = await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { sandboxId: "fresh-box", branch: "main" },
      source: "agent",
    });
    expect(state.sandboxId).toBe("fresh-box");
  });

  it("accepts when the provider cannot answer", async () => {
    held.ids = async () => {
      throw new Error("list API blipped");
    };
    const state = await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { sandboxId: "some-box" },
      source: "agent",
    });
    expect(state.sandboxId).toBe("some-box");
  });

  it("does not ask the provider again for the box it already believes", async () => {
    const ids = vi.fn(async () => ["box-1"]);
    held.ids = ids;
    await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { sandboxId: "box-1" },
      source: "agent",
    });
    await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { sandboxId: "box-1", ahead: 2 },
      source: "agent",
    });
    expect(ids).toHaveBeenCalledTimes(1);
    expect((await getBoxState(key))?.ahead).toBe(2);
  });
});

describe("box reports right after an offline broadcast", () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
    resetBoxStateStoreForTests();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a heartbeat inside 10 s is ignored: no online flip, nothing stored", async () => {
    vi.useFakeTimers({
      now: Date.parse("2026-11-16T18:00:00Z"),
      toFake: ["Date"],
    });
    await markBoxOffline(ws, user);
    vi.mocked(publishRealtimeEvent).mockClear();
    vi.setSystemTime(Date.now() + 4_000);
    const state = await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { branch: "main", sandboxId: "sbx-1" },
      source: "agent",
    });
    expect(state.status).toBe("offline");
    expect(publishRealtimeEvent).not.toHaveBeenCalled();
    expect(await getBoxState(key)).toBeNull();
  });

  it("after 10 s, reports count again", async () => {
    vi.useFakeTimers({
      now: Date.parse("2026-11-16T18:00:00Z"),
      toFake: ["Date"],
    });
    await markBoxOffline(ws, user);
    vi.setSystemTime(Date.now() + 11_000);
    const state = await patchBoxState({
      workspaceId: ws,
      userId: user,
      patch: { branch: "main" },
      source: "agent",
    });
    expect(state.status).toBe("online");
    expect((await getBoxState(key))?.branch).toBe("main");
  });
});

describe("probePreview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answer = (status: number, body: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status })),
    );

  it("reports a served preview as reachable", async () => {
    answer(200, "<html></html>");
    expect(await probePreview("https://5173-box.example/")).toEqual({
      reachable: true,
    });
  });

  it("blames E2B's edge for its traffic-token 403", async () => {
    answer(
      403,
      '{"sandboxId":"i1","message":"Sandbox is secured with traffic access token"}',
    );
    expect(await probePreview("https://5173-box.example/")).toEqual({
      reachable: false,
      blockedBy: "e2b-traffic-token",
    });
  });

  it("blames the dev server for vite's blocked-host 403", async () => {
    answer(403, "Blocked request. This host is not allowed.");
    expect(await probePreview("https://5173-box.example/")).toEqual({
      reachable: false,
      blockedBy: "host",
    });
  });

  it("counts a network failure as reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await probePreview("https://5173-box.example/")).toEqual({
      reachable: true,
    });
  });
});
