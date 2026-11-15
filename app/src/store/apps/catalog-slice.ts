/**
 * The app list and its folders: fetch (de-duplicated + cached), create,
 * move, delete, share, verify.
 */
import {
  api,
  unwrapBody,
  ApiError,
  toErrorMessage as message,
} from "../../api";
import { healAppsTabs, reconcileAppsTabs } from "../../apps-runtime/shell";
import { appUrlSlug } from "./helpers";
import { appsListFetches } from "./runtime";
import type { AppMeta } from "./types";
import type { AppsSlice } from "./slice";

type Keys =
  | "fetchApps"
  | "setAppAccess"
  | "createApp"
  | "moveApp"
  | "createAppFolder"
  | "moveAppFolder"
  | "deleteAppFolder"
  | "stampAppId"
  | "setAppVerified"
  | "shareAppWithWorkspace"
  | "deleteApp";

export const createAppsCatalogSlice: AppsSlice<Keys> = (set, get) => ({
  fetchApps: (workspaceId, options) => {
    const current = appsListFetches.get(workspaceId);
    if (current) {
      if (!options?.fresh) return current.run;
      current.again ??= current.run
        .catch(() => undefined)
        .then(() => get().fetchApps(workspaceId));
      return current.again;
    }
    const load = async () => {
      set(s => {
        // Instant paint from the persisted list while the request runs; a
        // cache miss (first visit) shows the skeleton instead.
        const cached = s.appsCacheByWorkspace[workspaceId];
        if (cached && s.apps.length === 0) s.apps = cached;
        s.appsLoading = true;
        s.error = null;
      });
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps", {
            params: { path: { workspaceId } },
          }),
        ) as {
          apps?: AppMeta[];
          folders?: string[];
          personalRoot?: string;
        };
        const apps = body.apps ?? [];
        set(s => {
          s.apps = apps;
          s.folders = body.folders ?? [];
          s.personalRoot = body.personalRoot ?? null;
          s.appsCacheByWorkspace[workspaceId] = apps;
          s.appsLoading = false;
        });
        // Drop tabs pointing at apps this workspace does not have, so a
        // deleted app cannot leave a working-looking workspace view behind.
        reconcileAppsTabs(new Set(apps.map(a => a.id)));
        // And keep the survivors' URL handles current: a push that moved
        // an app changes what its tabs' links should say.
        healAppsTabs(new Map(apps.map(a => [a.id, appUrlSlug(a)])));
      } catch (e) {
        // GET /apps is 412 without a GitHub binding. That is an empty
        // explorer (disconnect, never linked), not a load failure. Keeping
        // the previous list and persisted cache left the sidebar populated
        // after unlink.
        const githubRequired = e instanceof ApiError && e.status === 412;
        if (githubRequired) {
          set(s => {
            s.apps = [];
            s.folders = [];
            s.personalRoot = null;
            delete s.appsCacheByWorkspace[workspaceId];
            s.appsLoading = false;
            s.error = null;
          });
          reconcileAppsTabs(new Set());
          return;
        }
        set(s => {
          s.appsLoading = false;
          // A 404 here means the flag is off — not an error worth surfacing.
          if (!(e instanceof ApiError && e.status === 404)) {
            s.error = message(e, "Failed to load apps");
          }
        });
      }
    };
    const run = load().finally(() => {
      if (appsListFetches.get(workspaceId)?.run === run) {
        appsListFetches.delete(workspaceId);
      }
    });
    appsListFetches.set(workspaceId, { run, again: null });
    return run;
  },

  setAppAccess: async (workspaceId, appId, access) => {
    // Optimistic: the row moves sections immediately; server truth on error.
    set(s => {
      const app = s.apps.find(a => a.id === appId);
      if (app) app.access = access;
    });
    try {
      unwrapBody(
        await api.PATCH("/api/workspaces/{workspaceId}/apps/{id}/access", {
          params: { path: { workspaceId, id: appId } },
          body: { access },
        }),
      );
    } catch {
      void get().fetchApps(workspaceId, { fresh: true });
    }
  },

  createApp: async (workspaceId, title, description, folder) => {
    try {
      const body = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/apps", {
          params: { path: { workspaceId } },
          body: { title, description, ...(folder ? { folder } : {}) },
        }),
      ) as { app?: AppMeta };
      if (body.app) {
        set(s => {
          s.apps.unshift(body.app as AppMeta);
        });
        return body.app;
      }
      return null;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to create app");
      });
      return null;
    }
  },

  moveApp: async (workspaceId, appId, folder, name) => {
    try {
      const body = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/apps/{id}/move", {
          params: { path: { workspaceId, id: appId } },
          body: { folder, ...(name ? { name } : {}) },
        }),
      ) as { to?: string; app?: AppMeta };
      // Optimistic enough: the server answered with the new location, so
      // the row moves now and the full list catches up right behind it.
      set(s => {
        const app = s.apps.find(a => a.id === appId);
        if (app && body.to) {
          app.path = body.to;
          app.slug = body.to.split("/").pop();
          app.scope = body.to.startsWith("users/") ? "private" : "workspace";
        }
      });
      const moved = get().apps.find(a => a.id === appId);
      if (moved) healAppsTabs(new Map([[appId, appUrlSlug(moved)]]));
      void get().fetchApps(workspaceId, { fresh: true });
      return true;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to move app");
      });
      return false;
    }
  },

  createAppFolder: async (workspaceId, path) => {
    try {
      unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/apps/folders", {
          params: { path: { workspaceId } },
          body: { path },
        }),
      );
      set(s => {
        if (!s.folders.includes(path)) s.folders.push(path);
      });
      void get().fetchApps(workspaceId, { fresh: true });
      return true;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to create folder");
      });
      return false;
    }
  },

  moveAppFolder: async (workspaceId, path, to) => {
    try {
      unwrapBody(
        await api.PATCH("/api/workspaces/{workspaceId}/apps/folders", {
          params: { path: { workspaceId } },
          body: { path, to },
        }),
      );
      await get().fetchApps(workspaceId, { fresh: true });
      return true;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to move folder");
      });
      return false;
    }
  },

  deleteAppFolder: async (workspaceId, path) => {
    try {
      unwrapBody(
        await api.DELETE("/api/workspaces/{workspaceId}/apps/folders", {
          params: { path: { workspaceId }, query: { path } },
        }),
      );
      set(s => {
        s.folders = s.folders.filter(
          f => f !== path && !f.startsWith(`${path}/`),
        );
      });
      return true;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to delete folder");
      });
      return false;
    }
  },

  stampAppId: async (workspaceId, appId) => {
    try {
      unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/apps/{id}/stamp-id", {
          params: { path: { workspaceId, id: appId } },
        }),
      );
      await get().fetchApps(workspaceId, { fresh: true });
      return true;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to stamp the app id");
      });
      return false;
    }
  },

  setAppVerified: async (workspaceId, appId, verified) => {
    try {
      unwrapBody(
        await api.PUT("/api/workspaces/{workspaceId}/apps/{id}/verified", {
          params: { path: { workspaceId, id: appId } },
          body: { verified },
        }),
      );
      set(s => {
        const app = s.apps.find(a => a.id === appId);
        if (app) app.verified = verified;
      });
      // The Apps home renders the badge from its own discovery list.
      void import("../appsDiscoveryStore").then(({ useAppsDiscoveryStore }) =>
        useAppsDiscoveryStore.getState().fetchDiscovery(workspaceId),
      );
      return true;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to change verification");
      });
      return false;
    }
  },

  shareAppWithWorkspace: async (workspaceId, appId, description) => {
    try {
      const body = unwrapBody(
        await api.POST(
          "/api/workspaces/{workspaceId}/apps/{id}/share-with-workspace",
          {
            params: { path: { workspaceId, id: appId } },
            body: { description },
          },
        ),
      ) as { to?: string };
      set(s => {
        const app = s.apps.find(a => a.id === appId);
        if (app && body.to) {
          app.path = body.to;
          app.slug = body.to.split("/").pop();
          app.scope = "workspace";
          app.access = "workspace";
          app.description = description;
        }
      });
      const moved = get().apps.find(a => a.id === appId);
      if (moved) healAppsTabs(new Map([[appId, appUrlSlug(moved)]]));
      void get().fetchApps(workspaceId, { fresh: true });
      return true;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to share the app with the workspace");
      });
      return false;
    }
  },

  deleteApp: async (workspaceId, appId) => {
    try {
      unwrapBody(
        await api.DELETE("/api/workspaces/{workspaceId}/apps/{id}", {
          params: { path: { workspaceId, id: appId } },
        }),
      );
      set(s => {
        s.apps = s.apps.filter(a => a.id !== appId);
        delete s.filesByApp[appId];
        delete s.statusByApp[appId];
        delete s.historyByApp[appId];
        delete s.publishStateByApp[appId];
        delete s.terminalByApp[appId];
        delete s.previewByApp[appId];
      });
      return true;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to delete app");
      });
      return false;
    }
  },

  // Browsing leaves it out and never touches a sandbox — that is what keeps
  // opening an app cheap, and working while its sandbox is asleep.
});
