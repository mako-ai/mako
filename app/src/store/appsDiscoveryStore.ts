/**
 * Apps discovery — what the Apps home and the explorer's Recently viewed /
 * Popular sections render: the discovery listing (owner, age, thumbnail,
 * health), the usage API's popularity and this person's recent views, and
 * the search results.
 *
 * Usage and recent views come from the usage API, which may not be deployed
 * everywhere yet. A 404 from either is not an error: the store records the
 * capability as unavailable and every popularity surface simply hides. The
 * next fetch asks again, so the sections appear as soon as the API does.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, ApiError, toErrorMessage, unwrapBody } from "../api";
import { apiClient } from "../lib/api-client";
import type {
  AppUsageStats,
  DiscoveryApp,
  DiscoverySearchHit,
  RecentAppView,
} from "../lib/apps-discovery";

/** The usage window the home calls "this month". */
export const USAGE_WINDOW_DAYS = 28;

export interface WorkspaceDiscovery {
  apps: DiscoveryApp[];
  appsLoaded: boolean;
  appsLoading: boolean;
  appsError: string | null;
  usage: Record<string, AppUsageStats>;
  /** null = not asked yet; false = the usage API is not there (404). */
  usageAvailable: boolean | null;
  recent: RecentAppView[];
  recentAvailable: boolean | null;
}

interface SearchState {
  workspaceId: string | null;
  query: string;
  results: DiscoverySearchHit[];
  loading: boolean;
  error: string | null;
}

interface AppsDiscoveryState {
  byWorkspace: Record<string, WorkspaceDiscovery>;
  search: SearchState;
}

interface AppsDiscoveryActions {
  fetchDiscovery: (workspaceId: string) => Promise<void>;
  fetchUsage: (workspaceId: string) => Promise<void>;
  fetchRecent: (workspaceId: string) => Promise<void>;
  /** Run a search; a newer call supersedes an older one in flight. */
  searchApps: (workspaceId: string, query: string) => Promise<void>;
  clearSearch: () => void;
  reset: () => void;
}

const emptyWorkspace = (): WorkspaceDiscovery => ({
  apps: [],
  appsLoaded: false,
  appsLoading: false,
  appsError: null,
  usage: {},
  usageAvailable: null,
  recent: [],
  recentAvailable: null,
});

const EMPTY_WORKSPACE: WorkspaceDiscovery = emptyWorkspace();

const emptySearch = (): SearchState => ({
  workspaceId: null,
  query: "",
  results: [],
  loading: false,
  error: null,
});

export const selectDiscovery =
  (workspaceId: string | undefined) =>
  (s: AppsDiscoveryState): WorkspaceDiscovery =>
    (workspaceId && s.byWorkspace[workspaceId]) || EMPTY_WORKSPACE;

/** The usage API is not deployed here: hide, do not complain. */
const isMissingEndpoint = (e: unknown) =>
  e instanceof ApiError && (e.status === 404 || e.status === 405);

let searchSeq = 0;

export const useAppsDiscoveryStore = create<
  AppsDiscoveryState & AppsDiscoveryActions
>()(
  immer(set => {
    const ws = (state: AppsDiscoveryState, workspaceId: string) =>
      (state.byWorkspace[workspaceId] ??= emptyWorkspace());

    return {
      byWorkspace: {},
      search: emptySearch(),

      fetchDiscovery: async workspaceId => {
        set(s => {
          const w = ws(s, workspaceId);
          w.appsLoading = true;
          w.appsError = null;
        });
        try {
          const body = unwrapBody(
            await api.GET("/api/workspaces/{workspaceId}/apps/discovery", {
              params: { path: { workspaceId } },
            }),
          ) as { apps?: DiscoveryApp[] };
          set(s => {
            const w = ws(s, workspaceId);
            w.apps = body.apps ?? [];
            w.appsLoaded = true;
            w.appsLoading = false;
          });
        } catch (e) {
          set(s => {
            const w = ws(s, workspaceId);
            w.appsLoading = false;
            w.appsError = toErrorMessage(e, "Could not load apps");
          });
        }
      },

      fetchUsage: async workspaceId => {
        try {
          const body = await apiClient.get<{ apps?: AppUsageStats[] }>(
            `/workspaces/${workspaceId}/apps/usage`,
            { days: String(USAGE_WINDOW_DAYS) },
          );
          set(s => {
            const w = ws(s, workspaceId);
            w.usage = Object.fromEntries(
              (body.apps ?? []).map(a => [a.appId, a]),
            );
            w.usageAvailable = true;
          });
        } catch (e) {
          set(s => {
            const w = ws(s, workspaceId);
            // Missing API: hide popularity. Any other failure keeps what we
            // had — a flaky request must not blank a working shelf.
            if (isMissingEndpoint(e)) {
              w.usage = {};
              w.usageAvailable = false;
            } else if (w.usageAvailable === null) {
              w.usageAvailable = false;
            }
          });
        }
      },

      fetchRecent: async workspaceId => {
        try {
          const body = await apiClient.get<{ apps?: RecentAppView[] }>(
            `/workspaces/${workspaceId}/apps/recent`,
            { limit: "20" },
          );
          set(s => {
            const w = ws(s, workspaceId);
            w.recent = body.apps ?? [];
            w.recentAvailable = true;
          });
        } catch (e) {
          set(s => {
            const w = ws(s, workspaceId);
            if (isMissingEndpoint(e)) {
              w.recent = [];
              w.recentAvailable = false;
            } else if (w.recentAvailable === null) {
              w.recentAvailable = false;
            }
          });
        }
      },

      searchApps: async (workspaceId, query) => {
        const q = query.trim();
        const seq = ++searchSeq;
        if (!q) {
          set(s => {
            s.search = { ...emptySearch(), workspaceId };
          });
          return;
        }
        set(s => {
          s.search.workspaceId = workspaceId;
          s.search.query = q;
          s.search.loading = true;
          s.search.error = null;
        });
        try {
          const body = unwrapBody(
            await api.GET("/api/workspaces/{workspaceId}/apps/search", {
              params: { path: { workspaceId }, query: { q, limit: 50 } },
            }),
          ) as { apps?: DiscoverySearchHit[] };
          if (seq !== searchSeq) return;
          set(s => {
            s.search.results = body.apps ?? [];
            s.search.loading = false;
          });
        } catch (e) {
          if (seq !== searchSeq) return;
          set(s => {
            s.search.loading = false;
            s.search.results = [];
            s.search.error = toErrorMessage(e, "Search failed");
          });
        }
      },

      clearSearch: () =>
        set(s => {
          searchSeq++;
          s.search = emptySearch();
        }),

      reset: () =>
        set(s => {
          searchSeq++;
          s.byWorkspace = {};
          s.search = emptySearch();
        }),
    };
  }),
);
