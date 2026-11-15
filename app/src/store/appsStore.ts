/**
 * Apps store — git-backed apps.
 *
 * Backed by /api/workspaces/:id/apps (see api/src/apps/**). All file
 * reads resolve through the durable worktree layer on the server (bare repo +
 * private WIP refs), so everything here renders identically whether the
 * app's sandbox session is warm or was rebuilt after eviction.
 *
 * Repo linkage is probed once per workspace via /status-probe and
 * drives the sidebar rail icon; every route except the probe 404s while the
 * server flag is off.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { focusAppsTab } from "../apps-runtime/shell";
import { createAppsBoxSlice } from "./apps/box-slice";
import { createAppsCatalogSlice } from "./apps/catalog-slice";
import { createAppsFilesSlice } from "./apps/files-slice";
import { createAppsGitSlice } from "./apps/git-slice";
import { appUrlSlug } from "./apps/helpers";
import { initialAppsState } from "./apps/initial-state";
import { createAppsGithubSlice } from "./apps/github-slice";
import { createAppsPublishSlice } from "./apps/publish-slice";
import { activeAppId } from "./apps/runtime";
import type { AppsStore } from "./apps/types";
import { onRealtimeEvent } from "./lib/realtime-channel";

export {
  appRootOf,
  appUrlRef,
  appUrlSlug,
  devServerKeyMatches,
} from "./apps/helpers";
export type {
  AppMeta,
  AppFileEntry,
  AppEnvVar,
  AppChange,
  AppFileVersions,
  AppsBoxState,
  AppStatus,
  AppCommit,
  AppPublishState,
  AppCommitFile,
  AppCommitFileVersions,
  AppTerminalEntry,
  AppBranch,
  AppPreview,
  AppRepoBinding,
  AppGithubRepo,
  AppGithubInstallation,
} from "./apps/types";

// Actions live in slices under ./apps/; this module composes them, owns
// persistence (name, version, migrate and partialize are unchanged — a
// change would drop users' cached app lists) and the realtime reactions.
export const useAppsStore = create<AppsStore>()(
  persist(
    immer((...a) => ({
      ...initialAppsState,
      ...createAppsGithubSlice(...a),
      ...createAppsCatalogSlice(...a),
      ...createAppsFilesSlice(...a),
      ...createAppsGitSlice(...a),
      ...createAppsPublishSlice(...a),
      ...createAppsBoxSlice(...a),
    })),
    {
      name: "apps-store",
      version: 1,
      // v0 had the same persisted shape (the list cache): keep it rather
      // than letting zustand log an error and discard it.
      migrate: persisted => (persisted ?? {}) as never,
      // Only the list cache survives a reload; everything else is live
      // state that must come from the box or the API.
      partialize: s => ({ appsCacheByWorkspace: s.appsCacheByWorkspace }),
    },
  ),
);

// ── Realtime reactions (registered here so the apps domain owns them) ──

// Apps (git-backed): any durable change (agent turn, WIP flush, merge)
// pokes open windows; the store refetches from the API (git is the
// authority, so a refetch is always safe — openFile preserves dirty local
// edits and only refreshes clean buffers).
onRealtimeEvent("app.updated", "appsStore", (event, ctx) => {
  const workspaceId = ctx.workspaceId;
  if (!workspaceId) return;
  const v2 = useAppsStore.getState();
  // Explorer list (titles, new/deleted apps).
  void v2.fetchApps(workspaceId, { fresh: true });
  if (event.origin === "lifecycle") return;
  // A deploy from main changes what is live, not the files: refresh the
  // published chip (a failed deploy leaves the sha alone, so nothing else
  // would refetch the error it now carries).
  if (event.origin === "deploy") {
    if (event.appId && v2.publishStateByApp[event.appId]) {
      void v2.fetchPublishState(workspaceId, event.appId);
    }
    return;
  }

  // A NAMED app is refreshed immediately — one app, three requests, which is
  // what the event is for.
  if (event.appId) {
    refreshAppNow(workspaceId, event.appId);
    return;
  }

  // §10 monorepo: appId "" = workspace-wide (a workspace worktree changed; it
  // may span apps). This used to refresh every app the window had loaded, in
  // one tick. `filesByApp` is a cache that grows all session — it is pruned
  // only when an app is DELETED, never when a tab closes — so the burst scaled
  // with how long somebody had been working rather than with what they were
  // looking at. Measured in production: a single push produced 118 requests in
  // one second (33 files + 33 branches + 32 status + a list) against a ~10-15
  // baseline, and Cloud Run refused 65 of them while it scaled.
  //
  // So: mark them stale and refresh only what is on screen. Every other app
  // refetches when its tab is next activated, which is the first moment its
  // freshness matters to anyone.
  useAppsStore.getState().markAllAppsStale();
  const active = activeAppId();
  if (active) refreshAppNow(workspaceId, active);
});

/** Refresh one app's cached state now, ignoring whether it was marked stale. */
function refreshAppNow(workspaceId: string, appId: string): void {
  const v2 = useAppsStore.getState();
  useAppsStore.setState(s => {
    delete s.staleApps[appId];
  });
  if (v2.filesByApp[appId]) {
    void v2.fetchFiles(workspaceId, appId);
    void v2.fetchStatus(workspaceId, appId);
  }
  if (v2.branchesByApp[appId]) {
    void v2.fetchBranches(workspaceId, appId);
  }
  const selected = v2.selectedFile[appId];
  if (selected) {
    const entry = v2.fileContents[`${appId}\u0000${selected}`];
    if (entry && !entry.dirty) {
      void v2.openFile(workspaceId, appId, selected);
    }
  }
}

onRealtimeEvent("app.box-state", "appsStore", event => {
  useAppsStore.getState().applyBoxState(event.userId, event.state);
});

onRealtimeEvent("app.open-app", "appsStore", (event, ctx) => {
  // The user's own agent asked the UI to show an app. Scoped to the
  // requesting user — a teammate's agent must not steal this focus.
  if (!ctx.currentUserId || event.userId !== ctx.currentUserId) return;
  // The event's slug is the folder basename, which is a URL handle only for
  // a top-level app. Derive the tab's handle from the listing when the app
  // is known; an id-addressed tab always resolves.
  const known = useAppsStore.getState().apps.find(a => a.id === event.appId);
  focusAppsTab(
    event.appId,
    event.title ?? event.slug ?? "App",
    known ? appUrlSlug(known) : undefined,
  );
});
