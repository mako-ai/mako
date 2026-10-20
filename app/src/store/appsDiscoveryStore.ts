/**
 * Apps discovery — what the Apps home, the explorer's Recently viewed /
 * Popular sections and the command palette's Apps results render: the
 * discovery listing (owner, age, thumbnail, health), the usage API's
 * popularity and this person's recent views, and app search.
 *
 * Usage and recent views come from the usage API. A 404 from either (an
 * older API) is not an error: the store records the capability as
 * unavailable and every popularity surface simply hides.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, ApiError, toErrorMessage, unwrapBody } from "../api";
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

/**
 * Who is searching. The Apps home and the command palette search
 * independently, so one's results never show up under the other's query.
 */
export type AppSearchScope = "home" | "palette";

export interface AppSearchState {
  workspaceId: string | null;
  query: string;
  results: DiscoverySearchHit[];
  loading: boolean;
  error: string | null;
}

interface AppsDiscoveryState {
  byWorkspace: Record<string, WorkspaceDiscovery>;
  searches: Record<AppSearchScope, AppSearchState>;
  /** The Apps home's search box — set by the palette's "open in Apps home". */
  homeQuery: string;
}

interface AppsDiscoveryActions {
  fetchDiscovery: (workspaceId: string) => Promise<void>;
  fetchUsage: (workspaceId: string) => Promise<void>;
  fetchRecent: (workspaceId: string) => Promise<void>;
  /** Run a search; a newer call in the same scope supersedes an older one. */
  searchApps: (
    workspaceId: string,
    query: string,
    scope?: AppSearchScope,
  ) => Promise<void>;
  clearSearch: (scope?: AppSearchScope) => void;
  setHomeQuery: (query: string) => void;
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

const emptySearch = (): AppSearchState => ({
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

const searchSeq: Record<AppSearchScope, number> = { home: 0, palette: 0 };

export const useAppsDiscoveryStore = create<
  AppsDiscoveryState & AppsDiscoveryActions
>()(
  immer(set => {
    const ws = (state: AppsDiscoveryState, workspaceId: string) =>
      (state.byWorkspace[workspaceId] ??= emptyWorkspace());

    return {
      byWorkspace: {},
      searches: { home: emptySearch(), palette: emptySearch() },
      homeQuery: "",

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
          const body = unwrapBody(
            await api.GET("/api/workspaces/{workspaceId}/apps/usage", {
              params: {
                path: { workspaceId },
                query: { days: USAGE_WINDOW_DAYS },
              },
            }),
          ) as { apps?: AppUsageStats[] };
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
          const body = unwrapBody(
            await api.GET("/api/workspaces/{workspaceId}/apps/recent", {
              params: { path: { workspaceId }, query: { limit: 20 } },
            }),
          ) as { apps?: RecentAppView[] };
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

      searchApps: async (workspaceId, query, scope = "home") => {
        const q = query.trim();
        const seq = ++searchSeq[scope];
        if (!q) {
          set(s => {
            s.searches[scope] = { ...emptySearch(), workspaceId };
          });
          return;
        }
        set(s => {
          const st = s.searches[scope];
          st.workspaceId = workspaceId;
          st.query = q;
          st.loading = true;
          st.error = null;
        });
        try {
          const body = unwrapBody(
            await api.GET("/api/workspaces/{workspaceId}/apps/search", {
              params: { path: { workspaceId }, query: { q, limit: 50 } },
            }),
          ) as { apps?: DiscoverySearchHit[] };
          if (seq !== searchSeq[scope]) return;
          set(s => {
            s.searches[scope].results = body.apps ?? [];
            s.searches[scope].loading = false;
          });
        } catch (e) {
          if (seq !== searchSeq[scope]) return;
          set(s => {
            const st = s.searches[scope];
            st.loading = false;
            st.results = [];
            st.error = toErrorMessage(e, "Search failed");
          });
        }
      },

      clearSearch: (scope = "home") =>
        set(s => {
          searchSeq[scope]++;
          s.searches[scope] = emptySearch();
        }),

      setHomeQuery: query =>
        set(s => {
          s.homeQuery = query;
        }),

      reset: () =>
        set(s => {
          searchSeq.home++;
          searchSeq.palette++;
          s.byWorkspace = {};
          s.searches = { home: emptySearch(), palette: emptySearch() };
          s.homeQuery = "";
        }),
    };
  }),
);
