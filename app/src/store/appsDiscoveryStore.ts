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
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { api, ApiError, toErrorMessage, unwrapBody } from "../api";
import {
  upgradeCards,
  type ArchivedApp,
  type AppUsageStats,
  type DiscoveryApp,
  type DiscoverySearchHit,
  type RecentAppView,
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
  feed: FeedState;
  archived: {
    apps: ArchivedApp[];
    loaded: boolean;
    error: string | null;
  };
}

/**
 * The Apps home feed (GET /apps/feed): the Popular and New shelves, then
 * the Recommended grid, paged by an opaque cursor over an order the server
 * froze on the first page — so pages never repeat or skip an app.
 */
export interface FeedState {
  popular: DiscoveryApp[];
  fresh: DiscoveryApp[];
  items: DiscoveryApp[];
  nextCursor: string | null;
  /** Apps in the server's snapshot (shelves + Recommended). */
  total: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The snapshot expired (410): the feed has to start over. */
  expired: boolean;
  loadedAt: number | null;
}

interface FeedPageBody {
  popular?: DiscoveryApp[];
  fresh?: DiscoveryApp[];
  apps?: DiscoveryApp[];
  nextCursor?: string | null;
  total?: number;
}

/** Cards per Recommended page. */
export const FEED_PAGE_SIZE = 24;

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
  /** Start the feed over: a fresh ranking, shelves and the first page. */
  fetchFeed: (workspaceId: string) => Promise<void>;
  /** The next Recommended page; a no-op while loading or at the end. */
  fetchMoreFeed: (workspaceId: string) => Promise<void>;
  fetchArchived: (workspaceId: string) => Promise<void>;
  /** Move an archived app back; resolves to an error message, or null. */
  restoreArchived: (
    workspaceId: string,
    path: string,
  ) => Promise<string | null>;
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

const emptyFeed = (): FeedState => ({
  popular: [],
  fresh: [],
  items: [],
  nextCursor: null,
  total: 0,
  loaded: false,
  loading: false,
  error: null,
  expired: false,
  loadedAt: null,
});

/** Bumped on every restart, so a page from an older feed is dropped. */
const feedGeneration: Record<string, number> = {};

const emptyWorkspace = (): WorkspaceDiscovery => ({
  apps: [],
  appsLoaded: false,
  appsLoading: false,
  appsError: null,
  usage: {},
  usageAvailable: null,
  recent: [],
  recentAvailable: null,
  feed: emptyFeed(),
  archived: { apps: [], loaded: false, error: null },
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
  persist(
    immer((set, get) => {
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
                params: { path: { workspaceId }, query: { limit: 48 } },
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

        fetchFeed: async workspaceId => {
          const gen = (feedGeneration[workspaceId] =
            (feedGeneration[workspaceId] ?? 0) + 1);
          set(s => {
            const w = ws(s, workspaceId);
            w.feed = { ...emptyFeed(), loading: true };
          });
          try {
            const body = unwrapBody(
              await api.GET("/api/workspaces/{workspaceId}/apps/feed", {
                params: {
                  path: { workspaceId },
                  query: { limit: FEED_PAGE_SIZE },
                },
              }),
            ) as FeedPageBody;
            if (gen !== feedGeneration[workspaceId]) return;
            set(s => {
              const w = ws(s, workspaceId);
              // Posters and owners for the persisted listing when the feed
              // beats /discovery (it usually does on a busy prod load).
              if (!w.appsLoaded) {
                w.apps = upgradeCards(w.apps, [
                  ...(body.popular ?? []),
                  ...(body.fresh ?? []),
                  ...(body.apps ?? []),
                ]);
              }
              const f = w.feed;
              f.popular = body.popular ?? [];
              f.fresh = body.fresh ?? [];
              f.items = body.apps ?? [];
              f.nextCursor = body.nextCursor ?? null;
              f.total = body.total ?? 0;
              f.loaded = true;
              f.loading = false;
              f.loadedAt = Date.now();
            });
          } catch (e) {
            if (gen !== feedGeneration[workspaceId]) return;
            set(s => {
              const f = ws(s, workspaceId).feed;
              f.loading = false;
              f.error = toErrorMessage(e, "Could not load apps");
            });
          }
        },

        fetchMoreFeed: async workspaceId => {
          const current = get().byWorkspace[workspaceId]?.feed;
          if (!current?.nextCursor || current.loading || current.expired) {
            return;
          }
          const cursor = current.nextCursor;
          const gen = feedGeneration[workspaceId];
          set(s => {
            const f = ws(s, workspaceId).feed;
            f.loading = true;
            f.error = null;
          });
          try {
            const body = unwrapBody(
              await api.GET("/api/workspaces/{workspaceId}/apps/feed", {
                params: {
                  path: { workspaceId },
                  query: { cursor, limit: FEED_PAGE_SIZE },
                },
              }),
            ) as FeedPageBody;
            if (gen !== feedGeneration[workspaceId]) return;
            set(s => {
              const f = ws(s, workspaceId).feed;
              // The server never repeats an app; this only guards a retry.
              const have = new Set(f.items.map(a => a.id));
              f.items.push(...(body.apps ?? []).filter(a => !have.has(a.id)));
              f.nextCursor = body.nextCursor ?? null;
              f.loading = false;
            });
          } catch (e) {
            if (gen !== feedGeneration[workspaceId]) return;
            set(s => {
              const f = ws(s, workspaceId).feed;
              f.loading = false;
              if (e instanceof ApiError && e.status === 410) {
                f.expired = true;
              } else {
                f.error = toErrorMessage(e, "Could not load more apps");
              }
            });
          }
        },

        fetchArchived: async workspaceId => {
          try {
            const body = unwrapBody(
              await api.GET("/api/workspaces/{workspaceId}/apps/archived", {
                params: { path: { workspaceId } },
              }),
            ) as { apps?: ArchivedApp[] };
            set(s => {
              ws(s, workspaceId).archived = {
                apps: body.apps ?? [],
                loaded: true,
                error: null,
              };
            });
          } catch (e) {
            set(s => {
              const a = ws(s, workspaceId).archived;
              // An older API without the route: no chip, no complaint.
              a.loaded = true;
              a.error = isMissingEndpoint(e)
                ? null
                : toErrorMessage(e, "Could not load archived apps");
            });
          }
        },

        restoreArchived: async (workspaceId, path) => {
          try {
            unwrapBody(
              await api.POST(
                "/api/workspaces/{workspaceId}/apps/archived/restore",
                { params: { path: { workspaceId } }, body: { path } },
              ),
            );
          } catch (e) {
            return toErrorMessage(e, "Could not restore the app");
          }
          set(s => {
            const a = ws(s, workspaceId).archived;
            a.apps = a.apps.filter(x => x.path !== path);
          });
          // Back on main: the list, the explorer and the feed pick it up.
          const self = get();
          void self.fetchDiscovery(workspaceId);
          void self.fetchFeed(workspaceId);
          return null;
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
    {
      name: "apps-discovery-store",
      version: 1,
      // The Apps home paints from the last listing (titles, thumbnails,
      // owners, popularity) while the live requests run: a cold API under
      // load takes seconds, and the page should not be blank meanwhile.
      // Only that snapshot survives; everything else is live state.
      partialize: s => ({
        byWorkspace: Object.fromEntries(
          Object.entries(
            s.byWorkspace as Record<string, WorkspaceDiscovery>,
          ).map(([id, w]) => [id, { apps: w.apps, usage: w.usage }]),
        ),
      }),
      merge: (persisted, current) => {
        const saved = (
          persisted as {
            byWorkspace?: Record<
              string,
              Pick<WorkspaceDiscovery, "apps" | "usage">
            >;
          } | null
        )?.byWorkspace;
        if (!saved) return current;
        const byWorkspace: Record<string, WorkspaceDiscovery> = {};
        for (const [id, w] of Object.entries(saved)) {
          byWorkspace[id] = {
            ...emptyWorkspace(),
            apps: Array.isArray(w?.apps) ? w.apps : [],
            usage: w?.usage && typeof w.usage === "object" ? w.usage : {},
          };
        }
        return { ...current, byWorkspace };
      },
    },
  ),
);
