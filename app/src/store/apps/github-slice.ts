/**
 * Repo connection: GitHub installations, repos and branches; the
 * workspace's repo bindings and the create-capability probe.
 */
import { api, unwrapBody, toErrorMessage as message } from "../../api";
import { refreshGitDerivedExplorers } from "./helpers";
import type {
  AppRepoBinding,
  AppGithubRepo,
  AppGithubInstallation,
} from "./types";
import type { AppsSlice } from "./slice";

type Keys =
  | "probeEnabled"
  | "fetchGithubStatus"
  | "getGitHubInstallUrl"
  | "fetchGithubBranches"
  | "getGitHubSyncUrl"
  | "fetchGithubRepos"
  | "connectRepo"
  | "disconnectRepo"
  | "disconnectGithubInstallation";

export const createAppsGithubSlice: AppsSlice<Keys> = (set, get) => ({
  probeEnabled: async workspaceId => {
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/status-probe", {
          params: { path: { workspaceId } },
        }),
      ) as {
        canCreate?: boolean;
        repos?: AppRepoBinding[];
      };
      set(s => {
        s.canCreate = Boolean(body?.canCreate);
        s.repos = body?.repos ?? [];
      });
    } catch {
      // Transient failure: keep whatever linkage state we had.
    }
  },

  fetchGithubStatus: async workspaceId => {
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/github-status", {
          params: { path: { workspaceId } },
        }),
      ) as {
        installations?: AppGithubInstallation[];
        appSlug?: string | null;
        repos?: AppRepoBinding[];
      };
      set(s => {
        s.repos = body.repos ?? [];
        s.canCreate = (body.repos ?? []).length > 0;
      });
      return {
        installations: body.installations ?? [],
        appSlug: body.appSlug ?? null,
      };
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to load GitHub status");
      });
      return { installations: [], appSlug: null };
    }
  },

  getGitHubInstallUrl: async workspaceId => {
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/repo/github/install-url", {
          params: { path: { workspaceId } },
        }),
      ) as { url?: string };
      return body.url ?? null;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to start GitHub App install");
      });
      return null;
    }
  },

  fetchGithubBranches: async (workspaceId, owner, repo, installationId) => {
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/repo/github/branches", {
          params: {
            path: { workspaceId },
            query: {
              owner,
              repo,
              ...(installationId ? { installationId } : {}),
            },
          },
        }),
      ) as { branches?: string[] };
      return body.branches ?? [];
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to list branches");
      });
      return [];
    }
  },

  getGitHubSyncUrl: async workspaceId => {
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/github-sync-url", {
          params: { path: { workspaceId } },
        }),
      ) as { url?: string };
      return body.url ?? null;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to start GitHub sync");
      });
      return null;
    }
  },

  fetchGithubRepos: async (workspaceId, installationId) => {
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/github-repos", {
          params: {
            path: { workspaceId },
            query: { installationId },
          },
        }),
      ) as { repos?: AppGithubRepo[] };
      return body.repos ?? [];
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to list repositories");
      });
      return [];
    }
  },

  connectRepo: async (workspaceId, input) => {
    try {
      const body = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/apps/link", {
          params: { path: { workspaceId } },
          body: input,
        }),
      ) as {
        repo?: AppRepoBinding;
        adoption?: "imported" | "seeded" | "reconnected" | "fresh" | "deferred";
      };
      set(s => {
        s.canCreate = true;
        if (body.repo) {
          s.repos = [
            ...s.repos.filter(
              r => !(r.owner === body.repo?.owner && r.repo === body.repo.repo),
            ),
            body.repo,
          ];
        }
      });
      // An import can make apps appear instantly; refetch either way.
      refreshGitDerivedExplorers(workspaceId, id =>
        get().fetchApps(id, { fresh: true }),
      );
      return { ok: true, adoption: body.adoption };
    } catch (e) {
      return { ok: false, error: message(e, "Failed to connect repo") };
    }
  },

  disconnectRepo: async (workspaceId, owner, repo) => {
    try {
      unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/apps/unlink", {
          params: { path: { workspaceId } },
          body: { owner, repo },
        }),
      );
      set(s => {
        s.repos = s.repos.filter(r => !(r.owner === owner && r.repo === repo));
      });
      // canCreate follows the probe — no GitHub binding means no creates.
      void get().probeEnabled(workspaceId);
      refreshGitDerivedExplorers(workspaceId, id =>
        get().fetchApps(id, { fresh: true }),
      );
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to disconnect repo");
      });
    }
  },

  disconnectGithubInstallation: async (workspaceId, installationId) => {
    try {
      unwrapBody(
        await api.DELETE(
          "/api/workspaces/{workspaceId}/apps/github-installations/{installationId}",
          { params: { path: { workspaceId, installationId } } },
        ),
      );
      return { ok: true as const };
    } catch (e) {
      return {
        ok: false as const,
        error: message(e, "Failed to disconnect installation"),
      };
    }
  },
});
