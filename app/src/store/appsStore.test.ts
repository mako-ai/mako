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

vi.mock("../api", () => ({
  api: {
    GET: vi.fn(async (path: string) => {
      calls.push(path);
      return { data: { success: true, files: [], branches: [], status: {} } };
    }),
    POST: vi.fn(async () => ({ data: { success: true } })),
  },
  unwrapBody: (r: { data?: unknown }) => (r?.data ?? {}) as never,
  ApiError: class extends Error {},
  toErrorMessage: (e: unknown) => String(e),
}));
vi.mock("../apps-runtime/shell", () => ({
  focusAppsTab: vi.fn(),
  focusAppsFileTab: vi.fn(),
  reconcileAppsTabs: vi.fn(),
}));

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
  useAppsStore.setState({ filesByApp: {}, branchesByApp: {}, staleApps: {} });
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

  it("costs the same whether the window cached 5 apps or 50", () => {
    // The property the fix exists for: cost independent of cache size. A
    // batched endpoint would have kept this proportional, only with a smaller
    // constant.
    cacheApps(5);
    useConsoleStore.setState({ activeTabId: openAppTab("app1") });
    useAppsStore.getState().refreshAppIfStale(WS, "app1");
    useAppsStore.getState().markAllAppsStale();
    useAppsStore.getState().refreshAppIfStale(WS, "app1");
    const few = calls.length;

    calls.length = 0;
    useAppsStore.setState({ filesByApp: {}, branchesByApp: {}, staleApps: {} });
    cacheApps(50);
    useAppsStore.getState().markAllAppsStale();
    useAppsStore.getState().refreshAppIfStale(WS, "app1");
    expect(calls.length).toBe(few);
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
