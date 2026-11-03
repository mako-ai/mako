// @vitest-environment jsdom
/**
 * The explorer's response to a workspace-wide change.
 *
 * Measured in production (2026-09-01 14:34Z): one `git push` produced 118
 * requests in a single second against a ~10-15/s baseline — 33 files, 33
 * branches, 32 status and a list — and Cloud Run refused 65 of them while it
 * scaled from 3 instances to 13. The cause was not the endpoints being slow,
 * though they are; it was this store refreshing every app it had EVER loaded,
 * because `filesByApp` is pruned only when an app is deleted and never when a
 * tab closes. The burst therefore scaled with how long somebody had been
 * working rather than with what they were looking at.
 *
 * The herd cannot be reproduced offline, so what these assert is the property
 * that removes it: the number of requests a workspace-wide event provokes does
 * not grow with the size of the cache. The latency figures stay in the commit
 * message as the evidence for why it matters, rather than being re-proved here.
 *
 * The second half matters as much as the first. Marking state stale instead of
 * refetching it trades a request storm for a correctness bug unless something
 * reliably re-reads: a tab that never unmounted would otherwise show state from
 * before the push, silently and forever. So activation drains the stale set,
 * and that is tested too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("../api", () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return {
    api: {
      GET: vi.fn(async (path: string) => {
        calls.push(path);
        return {
          data: { success: true, files: [], branches: [], status: {} },
        };
      }),
      POST: vi.fn(async () => ({ data: { success: true } })),
    },
    unwrapBody: vi.fn((r: { data?: unknown }) => (r?.data ?? {}) as never),
    ApiError,
    toErrorMessage: (e: unknown) => String(e),
    toLoadError: (e: unknown, fallback: string) => ({
      message: e instanceof Error ? e.message : fallback,
    }),
  };
});
vi.mock("../apps-runtime/shell", () => ({
  focusAppsTab: vi.fn(),
  focusAppsFileTab: vi.fn(),
  reconcileAppsTabs: vi.fn(),
}));

import { ApiError, api, unwrapBody } from "../api";
import { reconcileAppsTabs } from "../apps-runtime/shell";
import { useAppsStore } from "./appsStore";
import { useConsoleStore } from "./consoleStore";
import { useUIStore } from "./uiStore";

const WS = "6846e6a01b05af0948070582";

/** A window that has browsed `n` apps this session — the real starting state. */
function cacheApps(n: number): string[] {
  const ids = Array.from({ length: n }, (_, i) => `app${i}`);
  useAppsStore.setState(s => {
    for (const id of ids) {
      s.filesByApp[id] = [];
      s.branchesByApp[id] = { current: "main", branches: [] } as never;
    }
  });
  return ids;
}

function openAppTab(appId: string): string {
  const id = `tab-${appId}`;
  useConsoleStore.setState(s => {
    s.tabs[id] = {
      id,
      title: appId,
      content: "",
      kind: "app",
      metadata: { appId },
    } as never;
    s.tabOrder = [...s.tabOrder, id];
  });
  return id;
}

beforeEach(() => {
  calls.length = 0;
  vi.mocked(unwrapBody).mockReset();
  vi.mocked(unwrapBody).mockImplementation(
    (r: { data?: unknown }) => (r?.data ?? {}) as never,
  );
  vi.mocked(reconcileAppsTabs).mockClear();
  useAppsStore.setState({
    filesByApp: {},
    branchesByApp: {},
    staleApps: {},
    apps: [],
    appsCacheByWorkspace: {},
    appsLoading: false,
    error: null,
  });
  useConsoleStore.setState({ tabs: {}, tabOrder: [], activeTabId: null });
  useUIStore.setState({ currentWorkspaceId: WS } as never);
});

describe("a workspace-wide change", () => {
  it("does not fan out across every app the window has cached", () => {
    cacheApps(30);
    const active = openAppTab("app7");
    useConsoleStore.setState({ activeTabId: active });

    useAppsStore.getState().markAllAppsStale();
    // The old handler looped here and issued ~3 requests per cached app.
    expect(useAppsStore.getState().staleApps["app0"]).toBe(true);
    expect(Object.keys(useAppsStore.getState().staleApps)).toHaveLength(30);
    expect(calls).toHaveLength(0);
  });

  it("costs the same whether the window cached 5 apps or 50", async () => {
    // The property the fix exists for: cost independent of cache size. A
    // batched endpoint would have kept this proportional, only with a smaller
    // constant.
    cacheApps(5);
    useConsoleStore.setState({ activeTabId: openAppTab("app1") });
    useAppsStore.getState().refreshAppIfStale(WS, "app1");
    useAppsStore.getState().markAllAppsStale();
    useAppsStore.getState().refreshAppIfStale(WS, "app1");
    const few = calls.length;
    // Let the first round's requests finish: a branch list still in flight
    // would be shared (below), which is not what this measures.
    await new Promise(resolve => setTimeout(resolve, 0));

    calls.length = 0;
    useAppsStore.setState({ filesByApp: {}, branchesByApp: {}, staleApps: {} });
    cacheApps(50);
    useAppsStore.getState().markAllAppsStale();
    useAppsStore.getState().refreshAppIfStale(WS, "app1");
    expect(calls.length).toBe(few);
  });
});

describe("the workspace branch list", () => {
  it("is one request however many apps ask at once", async () => {
    // The list is the workspace repo's, identical for every app; on
    // 2026-10-19 each open app fetched it separately (17 copies of the
    // slowest call in the API).
    await Promise.all(
      ["app0", "app1", "app2", "app3"].map(id =>
        useAppsStore.getState().fetchBranches(WS, id),
      ),
    );
    expect(calls.filter(p => p.endsWith("/branches"))).toHaveLength(1);
    for (const id of ["app0", "app1", "app2", "app3"]) {
      expect(useAppsStore.getState().branchesByApp[id]).toEqual([]);
    }

    // Once answered, the next ask is a new request: a push pokes right after
    // a commit and that refetch must see the commit.
    await useAppsStore.getState().fetchBranches(WS, "app0");
    expect(calls.filter(p => p.endsWith("/branches"))).toHaveLength(2);
  });
});

describe("staleness is drained, not left to rot", () => {
  it("refreshes an app when its tab becomes active", () => {
    cacheApps(3);
    const tab = openAppTab("app2");
    useAppsStore.getState().markAllAppsStale();
    expect(calls).toHaveLength(0);

    // Switching to the tab is what re-reads. This is the case that would
    // otherwise show pre-push state forever: the tab never unmounted, so
    // nothing else would have refetched it.
    useConsoleStore.setState({ activeTabId: tab });

    expect(calls.length).toBeGreaterThan(0);
    expect(useAppsStore.getState().staleApps["app2"]).toBeUndefined();
  });

  it("does nothing for an app that is not stale", () => {
    cacheApps(3);
    useAppsStore.getState().refreshAppIfStale(WS, "app1");
    expect(calls).toHaveLength(0);
  });

  it("leaves the other apps stale until they are looked at", () => {
    cacheApps(3);
    const tab = openAppTab("app0");
    useAppsStore.getState().markAllAppsStale();
    useConsoleStore.setState({ activeTabId: tab });

    const stale = useAppsStore.getState().staleApps;
    expect(stale["app0"]).toBeUndefined();
    expect(stale["app1"]).toBe(true);
    expect(stale["app2"]).toBe(true);
  });
});

describe("fetchApps after unlink", () => {
  it("clears apps and the persisted cache when GET /apps is 412", async () => {
    const stale = { id: "stale", slug: "stale", title: "Stale" };
    useAppsStore.setState({
      apps: [stale],
      appsCacheByWorkspace: { [WS]: [stale] },
      appsLoading: false,
      error: null,
    });
    vi.mocked(unwrapBody).mockImplementationOnce(() => {
      throw new ApiError("Connect a GitHub repository first", 412);
    });

    await useAppsStore.getState().fetchApps(WS);

    const s = useAppsStore.getState();
    expect(s.apps).toEqual([]);
    expect(s.appsCacheByWorkspace[WS]).toBeUndefined();
    expect(s.error).toBeNull();
    expect(s.appsLoading).toBe(false);
    expect(reconcileAppsTabs).toHaveBeenCalledWith(new Set());
  });
});

describe("fetchApps on load", () => {
  const listCalls = () =>
    calls.filter(p => p === "/api/workspaces/{workspaceId}/apps").length;

  it("shares one request among everyone asking at once", async () => {
    calls.length = 0;
    // The explorer, the URL sync, three restored app tabs, an editor.
    await Promise.all(
      Array.from({ length: 6 }, () => useAppsStore.getState().fetchApps(WS)),
    );
    expect(listCalls()).toBe(1);
    // Once it has landed, the next ask is a new request.
    await useAppsStore.getState().fetchApps(WS);
    expect(listCalls()).toBe(2);
  });

  it("a caller that just wrote gets one request after the in-flight one", async () => {
    calls.length = 0;
    const first = useAppsStore.getState().fetchApps(WS);
    const afterWrites = [
      useAppsStore.getState().fetchApps(WS, { fresh: true }),
      useAppsStore.getState().fetchApps(WS, { fresh: true }),
    ];
    await Promise.all([first, ...afterWrites]);
    expect(listCalls()).toBe(2);
  });
});

describe("the view token", () => {
  const APP = "6846e6a01b05af0948070999";
  const SHA = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";
  const tokenPosts = () =>
    (vi.mocked(api.POST).mock.calls as unknown as Array<[string]>).filter(
      ([path]) => path === "/api/workspaces/{workspaceId}/apps/{id}/view-token",
    );
  const answer = (sha = SHA, expiresAt = Date.now() + 30 * 60 * 1000) => ({
    data: {
      success: true,
      url: `/api/apps-preview/tok-${sha.slice(0, 4)}/`,
      sha,
      expiresAt,
      appId: APP,
    },
  });

  beforeEach(() => {
    vi.mocked(api.POST).mockReset();
    useAppsStore.setState({
      apps: [{ id: APP, slug: "renewals", publishedSha: SHA } as never],
      viewUrlByApp: {},
      viewUrlErrorByApp: {},
      viewTokenByApp: {},
    });
  });

  it("files a prefetch by slug under the app id, and the tab reuses it", async () => {
    let release: () => void = () => undefined;
    vi.mocked(api.POST).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () => resolve(answer() as never);
        }) as never,
    );
    const prefetch = useAppsStore
      .getState()
      .fetchViewUrl(WS, "renewals", { speculative: true });
    // The tab mounts while the prefetch is still in flight.
    const tab = useAppsStore
      .getState()
      .fetchViewUrl(WS, APP, { reuseFresh: true });
    release();
    await Promise.all([prefetch, tab]);

    expect(tokenPosts()).toHaveLength(1);
    expect(useAppsStore.getState().viewUrlByApp[APP]).toBe(
      "/api/apps-preview/tok-38ce/",
    );
  });

  it("asks again once a publish moved the app past the held token", async () => {
    vi.mocked(api.POST).mockResolvedValueOnce(answer() as never);
    await useAppsStore.getState().fetchViewUrl(WS, APP);
    useAppsStore.setState(s => {
      (s.apps[0] as { publishedSha?: string }).publishedSha = "b".repeat(40);
    });
    vi.mocked(api.POST).mockResolvedValueOnce(answer("b".repeat(40)) as never);
    await useAppsStore.getState().fetchViewUrl(WS, APP, { reuseFresh: true });
    expect(tokenPosts()).toHaveLength(2);
    expect(useAppsStore.getState().viewUrlByApp[APP]).toBe(
      "/api/apps-preview/tok-bbbb/",
    );
  });

  it("asks again when the held token is close to expiry", async () => {
    vi.mocked(api.POST).mockResolvedValueOnce(
      answer(SHA, Date.now() + 60 * 1000) as never,
    );
    await useAppsStore.getState().fetchViewUrl(WS, APP);
    vi.mocked(api.POST).mockResolvedValueOnce(answer() as never);
    await useAppsStore.getState().fetchViewUrl(WS, APP, { reuseFresh: true });
    expect(tokenPosts()).toHaveLength(2);
  });

  it("always asks when the caller did not opt into reuse (publish, retry)", async () => {
    vi.mocked(api.POST).mockResolvedValue(answer() as never);
    await useAppsStore.getState().fetchViewUrl(WS, APP);
    await useAppsStore.getState().fetchViewUrl(WS, APP);
    expect(tokenPosts()).toHaveLength(2);
  });

  it("records no error for a failed prefetch, but does for the tab's own ask", async () => {
    vi.mocked(api.POST).mockRejectedValue(new ApiError("nope", 404) as never);
    await useAppsStore
      .getState()
      .fetchViewUrl(WS, "renewals", { speculative: true });
    expect(useAppsStore.getState().viewUrlErrorByApp.renewals).toBeUndefined();
    await useAppsStore.getState().fetchViewUrl(WS, APP, { reuseFresh: true });
    expect(useAppsStore.getState().viewUrlErrorByApp[APP]).toBeDefined();
  });
});
