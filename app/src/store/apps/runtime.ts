/**
 * Module-level apps runtime shared by the slices: request de-duplication
 * (app list, view tokens, branches) and the tab-activation stale drain.
 * Not reactive and never persisted.
 */
import { api, unwrapBody } from "../../api";
import { useConsoleStore } from "../consoleStore";
import { getCurrentWorkspaceId } from "../workspaceStore";
import type { AppBranch } from "./types";

export const fileKey = (appId: string, path: string) => `${appId}\u0000${path}`;

/**
 * The app-list request on the wire per workspace (fetchApps), and the one
 * trailing request `fresh` callers queue behind it.
 */
export const appsListFetches = new Map<
  string,
  { run: Promise<void>; again: Promise<void> | null }
>();

/**
 * View-token requests in flight, by `${workspaceId}:${ref}`. Browser-local by
 * nature (one tab's own requests); the server keeps no state for them.
 */
export const viewTokenRequests = new Map<string, Promise<void>>();
/** A held token is reused only with this much of its 30 minutes left. */
export const VIEW_TOKEN_REUSE_MARGIN_MS = 5 * 60 * 1000;

/**
 * The branch list is the WORKSPACE repo's, identical for every app, so apps
 * asking at the same time share one request. Before this, each open app
 * fetched it separately — on 2026-10-19 that was 17 copies of the slowest
 * call in the API. No freshness window on top: a push pokes right after a
 * commit, and that refetch must see the commit (the server caches by branch
 * tips, so asking again is cheap).
 */
export const branchesInFlight = new Map<string, Promise<AppBranch[]>>();

export function loadWorkspaceBranches(
  workspaceId: string,
  appId: string,
): Promise<AppBranch[]> {
  const existing = branchesInFlight.get(workspaceId);
  if (existing) return existing;
  const run = (async () => {
    const body = unwrapBody(
      await api.GET("/api/workspaces/{workspaceId}/apps/{id}/branches", {
        params: { path: { workspaceId, id: appId } },
      }),
    ) as { branches?: AppBranch[] };
    return body.branches ?? [];
  })().finally(() => {
    if (branchesInFlight.get(workspaceId) === run) {
      branchesInFlight.delete(workspaceId);
    }
  });
  branchesInFlight.set(workspaceId, run);
  return run;
}

/** After a checkout or merge, a request already in flight predates it. */
export function forgetInFlightBranches(workspaceId: string): void {
  branchesInFlight.delete(workspaceId);
}

/** Same source notebookStore reads, so the app shell has one answer. */
export function currentWorkspaceId(): string | null {
  return getCurrentWorkspaceId();
}

/** The app the user is actually looking at, if the active tab is an app. */
export function activeAppId(): string | null {
  const console = useConsoleStore.getState();
  const tab = console.activeTabId ? console.tabs[console.activeTabId] : null;
  if (!tab || tab.kind !== "app") return null;
  const appId = (tab.metadata as { appId?: unknown } | undefined)?.appId;
  return typeof appId === "string" && appId ? appId : null;
}

/**
 * Draining the stale set is what makes marking safe.
 *
 * Without it, "invalidate, don't refetch" trades a request storm for a
 * correctness bug: someone switching back to a tab that never unmounted would
 * be shown state from before the push, silently and indefinitely. Activation
 * is the right trigger rather than mount, precisely because the tab that
 * stayed mounted is the one that would otherwise never re-read.
 *
 * Registered on first use rather than at import. Subscribing at module scope
 * made importing this store fail outright wherever consoleStore is mocked
 * without a `subscribe` — a real breakage (UrlSync's suite) caused by a side
 * effect that had no reason to run before anything could be stale.
 */
let activationDrainRegistered = false;
export function ensureActivationDrain(
  refreshAppIfStale: (workspaceId: string, appId: string) => void,
): void {
  if (activationDrainRegistered) return;
  if (typeof useConsoleStore.subscribe !== "function") return;
  activationDrainRegistered = true;
  useConsoleStore.subscribe((state, previous) => {
    if (state.activeTabId === previous.activeTabId) return;
    const appId = activeAppId();
    if (!appId) return;
    const workspaceId = currentWorkspaceId();
    if (!workspaceId) return;
    refreshAppIfStale(workspaceId, appId);
  });
}
