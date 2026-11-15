/**
 * The user's sandbox ("box"): pushed box state, dev-server liveness,
 * env vault, bindings, terminals and sandbox stats.
 */
import { api, unwrapBody } from "../../api";
import { appRootOf, devServerKeyMatches } from "./helpers";
import type { AppEnvVar } from "./types";
import type { AppsSlice } from "./slice";

type Keys =
  | "fetchSandboxStats"
  | "recycleSandbox"
  | "stopDev"
  | "fetchAppEnv"
  | "setAppEnvVar"
  | "deleteAppEnvVar"
  | "fetchAppBindings"
  | "materializeAppBinding"
  | "fetchRunningDevApps"
  | "killTerminalSession"
  | "checkDevStatus"
  | "markDevServing"
  | "markDevDown"
  | "setCurrentUserId"
  | "applyBoxState"
  | "fetchDevLog"
  | "clearError";

export const createAppsBoxSlice: AppsSlice<Keys> = (set, get) => ({
  fetchSandboxStats: async (workspaceId, appId) => {
    const body = unwrapBody(
      await api.GET("/api/workspaces/{workspaceId}/apps/{id}/sandbox", {
        params: { path: { workspaceId, id: appId } },
      }),
    );
    return (body ?? null) as Record<string, unknown> | null;
  },

  recycleSandbox: async (workspaceId, appId) => {
    await api.POST("/api/workspaces/{workspaceId}/apps/{id}/sandbox/recycle", {
      params: { path: { workspaceId, id: appId } },
    });
  },

  stopDev: async (workspaceId, appId) => {
    // Kill ALL sessions server-side, not just the dev one: leaving old
    // shells alive meant re-entering dev mode reattached a museum of
    // terminals with their history. Best effort — an unreachable API
    // still flips the UI, and the box agent reconciles the dot.
    try {
      await api.DELETE(
        "/api/workspaces/{workspaceId}/apps/{id}/terminal-sessions",
        { params: { path: { workspaceId, id: appId } } },
      );
    } catch {
      // Best effort.
    }
    try {
      localStorage.removeItem(`apps-shells:${appId}`);
      localStorage.removeItem(`apps-term-active:${appId}`);
    } catch {
      // Best effort.
    }
    get().markDevDown(appId);
    get().setEditing(workspaceId, appId, false);
  },

  fetchAppEnv: async (workspaceId, appId) => {
    const body = unwrapBody(
      await api.GET("/api/workspaces/{workspaceId}/apps/{id}/env", {
        params: { path: { workspaceId, id: appId } },
      }),
    ) as { vars?: AppEnvVar[] };
    return body.vars ?? [];
  },

  setAppEnvVar: async (workspaceId, appId, input) => {
    const body = unwrapBody(
      await api.PUT("/api/workspaces/{workspaceId}/apps/{id}/env", {
        params: { path: { workspaceId, id: appId } },
        body: input,
      }),
    ) as { vars?: AppEnvVar[] };
    return body.vars ?? [];
  },

  deleteAppEnvVar: async (workspaceId, appId, key) => {
    unwrapBody(
      await api.DELETE("/api/workspaces/{workspaceId}/apps/{id}/env/{key}", {
        params: { path: { workspaceId, id: appId, key } },
      }),
    );
  },

  fetchAppBindings: async (workspaceId, appId) => {
    const body = unwrapBody(
      await api.GET("/api/workspaces/{workspaceId}/apps/{id}/bindings", {
        params: { path: { workspaceId, id: appId } },
      }),
    ) as { bindings?: Array<Record<string, unknown> & { name: string }> };
    return body.bindings ?? [];
  },

  materializeAppBinding: async (workspaceId, appId, name) => {
    return unwrapBody(
      await api.POST(
        "/api/workspaces/{workspaceId}/apps/{id}/bindings/{name}/materialize",
        { params: { path: { workspaceId, id: appId, name } } },
      ),
    ) as Record<string, unknown>;
  },

  fetchRunningDevApps: async workspaceId => {
    const appId = get().apps[0]?.id;
    if (!appId) return;
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/{id}/dev-servers", {
          params: { path: { workspaceId, id: appId } },
        }),
      ) as { running?: string[] };
      // A poll answered before a recycle must not overwrite the offline
      // push that arrived while it was in flight (§13.11: pushes win).
      if (get().boxStatus === "offline") return;
      set(s => {
        s.runningDevApps = body.running ?? [];
      });
    } catch {
      // Advisory dots; a failed probe changes nothing.
    }
  },

  killTerminalSession: async (workspaceId, appId, termId) => {
    try {
      await api.DELETE(
        "/api/workspaces/{workspaceId}/apps/{id}/terminal-sessions/{termId}",
        { params: { path: { workspaceId, id: appId, termId } } },
      );
    } catch {
      // Best effort — an unreachable API still lets the tab close; the
      // sandbox-side reaper collects orphans later.
    }
  },

  checkDevStatus: async (workspaceId, appId) => {
    try {
      const body = unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/apps/{id}/dev-preview/status",
          { params: { path: { workspaceId, id: appId } } },
        ),
      ) as { serving?: boolean; url?: string; reachable?: boolean };
      // Stale probe vs offline push: the push wins (§13.11). A response
      // computed before the box died must not repaint dead-sandbox URLs.
      if (get().boxStatus === "offline") return;
      const url = body.url;
      if (body.serving && url) {
        // Discovery: a dev server is ALREADY running for this app (started
        // in another tab, another browser, or before a reload that lost
        // client state). Show it — do not make the user "start" a thing
        // that is running.
        get().markDevServing(appId, url, body.reachable);
        return;
      }
      if (body.serving === false) get().markDevDown(appId);
    } catch {
      // Advisory: an unreachable probe must not kill a working preview.
    }
  },

  markDevServing: (appId, url, reachable) => {
    try {
      localStorage.setItem(`apps-devurl:${appId}`, url);
    } catch {
      // Best effort.
    }
    set(s => {
      const current = s.previewByApp[appId];
      if (current?.building) return;
      if (current?.url !== url) {
        s.previewByApp[appId] = {
          url,
          building: false,
          error: null,
          builtAt: Date.now(),
          mode: "dev",
          reachable,
        };
        s.viewMode[appId] = "preview";
      } else if (current && current.reachable !== reachable) {
        current.reachable = reachable;
      }
    });
  },

  markDevDown: appId => {
    try {
      localStorage.removeItem(`apps-devurl:${appId}`);
    } catch {
      // Best effort.
    }
    set(s => {
      const preview = s.previewByApp[appId];
      // A launch in flight (building) is not "down": the snapshot that
      // arrived mid-boot simply predates the server.
      if (preview?.mode === "dev" && !preview.building) {
        s.previewByApp[appId] = {
          url: null,
          building: false,
          // PRESERVE a boot failure: the next 15s status poll used to
          // land here and wipe the error — the red "last start failed"
          // state lived for seconds, then vanished as if nothing
          // happened. Down is down; the error explains WHY.
          error: preview.error ?? null,
        };
      }
    });
  },

  setCurrentUserId: userId => {
    set(s => {
      s.currentUserId = userId;
    });
  },

  applyBoxState: (userId, state) => {
    const { currentUserId, apps } = get();
    // Diagnostics: `localStorage["apps-debug"] = "1"` records every
    // pushed snapshot on window.__appsBoxEvents for inspection.
    try {
      if (localStorage.getItem("apps-debug")) {
        const w = window as Window & {
          __appsBoxEvents?: unknown[];
        };
        (w.__appsBoxEvents ??= []).push({
          at: Date.now(),
          userId,
          currentUserId,
          state,
        });
      }
    } catch {
      // Best effort.
    }
    // Unknown identity = drop, not accept: while /me is still resolving in
    // a multi-user workspace, a TEAMMATE's box push must not paint this
    // client's dots and previews.
    if (!currentUserId || userId !== currentUserId) return;
    // Reactive box identity/liveness for the sandbox panel and, crucially,
    // preview coherence: a second browser learns the box's id and status the
    // instant they change, not on a poll.
    set(s => {
      if (state.status) s.boxStatus = state.status;
      if (state.sandboxId !== undefined) s.boxSandboxId = state.sandboxId;
      if (state.terminals != null) s.boxTerminals = state.terminals;
    });
    if (state.status === "offline") {
      // The box is gone — every dev-server URL now points at a dead sandbox.
      // Drop them so open previews flip to the launch state immediately
      // instead of showing E2B's "sandbox not found".
      set(s => {
        s.runningDevApps = [];
        s.boxTerminals = [];
      });
      for (const app of apps) get().markDevDown(app.id);
      // markDevDown only clears keys for apps we KNOW about; if this push
      // beat fetchApps, the loop above ran over nothing and stale URLs
      // survive into the next session. Purge the namespace wholesale —
      // every remembered dev URL died with the machine.
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k?.startsWith("apps-devurl:")) localStorage.removeItem(k);
        }
      } catch {
        // Best effort.
      }
      return;
    }
    if (state.devServers) {
      const servers = state.devServers;
      set(s => {
        s.runningDevApps = servers.map(d => d.slug);
      });
      for (const app of apps) {
        const entry = servers.find(d => devServerKeyMatches(d.slug, app));
        if (entry?.url) {
          get().markDevServing(app.id, entry.url, entry.reachable);
        } else get().markDevDown(app.id);
      }
    }
    if (state.branch !== null || state.changes !== null) {
      set(s => {
        for (const app of apps) {
          const prev = s.statusByApp[app.id];
          const repoChanges = state.changes ?? prev?.repoChanges ?? [];
          s.statusByApp[app.id] = {
            branch: state.branch ?? prev?.branch ?? "main",
            baseSha: state.head ?? prev?.baseSha ?? "",
            branchHead: prev?.branchHead ?? null,
            ahead: state.ahead ?? prev?.ahead ?? 0,
            changes: repoChanges.filter(c =>
              c.path.startsWith(`${appRootOf(app)}/`),
            ),
            repoChanges,
            offline: false,
          };
        }
      });
    }
  },

  fetchDevLog: async (workspaceId, appId, offset) => {
    try {
      const body = unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/apps/{id}/dev-preview/log",
          {
            params: {
              path: { workspaceId, id: appId },
              query: { offset },
            },
          },
        ),
      ) as { size?: number; chunk?: string };
      return { size: body.size ?? 0, chunk: body.chunk ?? "" };
    } catch {
      // Polling: one missed beat is fine; the next one catches up.
      return { size: offset, chunk: "" };
    }
  },

  clearError: () => {
    set(s => {
      s.error = null;
    });
  },
});
