/**
 * Apps home — the full-screen catalogue that answers "which app should I
 * open?" for a workspace where everyone builds apps.
 *
 * "All" is a feed, YouTube-style: a Popular row, a New row, then a
 * Recommended grid that scrolls on until every app the viewer can see has
 * been shown exactly once. The ranking and the paging are the server's
 * (GET /apps/feed): it freezes the order on the first page, so scrolling
 * never repeats or skips an app. Filter chips switch the grid to
 * Recently viewed, Mine or Needs attention; typing in the search box
 * replaces it with results.
 *
 * Opening a card notes its shelf and position (app-open-placement), which
 * the usage beacon attaches to the view's `open` — click-through per
 * position, computable later from the raw usage log.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Search as SearchIcon } from "lucide-react";
import { useWorkspace } from "../../contexts/workspace-context";
import { useAuth } from "../../contexts/auth-context";
import {
  FEED_PAGE_SIZE,
  selectDiscovery,
  useAppsDiscoveryStore,
} from "../../store/appsDiscoveryStore";
import { appUrlSlug, useAppsStore } from "../../store/appsStore";
import { focusAppsTab } from "../../apps-runtime/shell";
import {
  attentionReasons,
  discoveryFromMeta,
  isMyApp,
  provisionalFeed,
  recentlyViewedApps,
  type AttentionReason,
  type DiscoveryApp,
} from "../../lib/apps-discovery";
import { notePlacement, type AppOpenShelf } from "../../lib/app-open-placement";
import AppCard, { AppCardSkeleton } from "./AppCard";

/** A feed older than this is re-ranked when the home is shown again. */
const FEED_MAX_AGE_MS = 10 * 60_000;
const RECENT_LIMIT = 48;
/** Cards on a shelf row, and how many skeletons hold its place. */
const SHELF_SIZE = 10;
const SHELF_SKELETONS = 5;

type Filter = "all" | "recent" | "mine" | "attention";

const GRID_SX = {
  display: "grid",
  gap: 1.5,
  gridTemplateColumns: {
    xs: "repeat(auto-fill, minmax(160px, 1fr))",
    sm: "repeat(auto-fill, minmax(220px, 1fr))",
  },
} as const;

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: "baseline", mb: 1.25 }}
    >
      <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {hint && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {hint}
        </Typography>
      )}
    </Stack>
  );
}

/**
 * One horizontally scrolling row. Every card is on the page (reachable by
 * scrolling the row, or by Tab, which scrolls it into view) — the feed's
 * "each app once" counts them as shown.
 */
function ShelfRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Box component="section" aria-label={title} sx={{ mb: 3.5 }}>
      <SectionTitle title={title} hint={hint} />
      <Box
        role="list"
        sx={{
          display: "grid",
          gridAutoFlow: "column",
          gridAutoColumns: { xs: "72%", sm: "240px" },
          gap: 1.5,
          overflowX: "auto",
          overscrollBehaviorX: "contain",
          scrollSnapType: "x proximity",
          pb: 1,
          "& > *": { scrollSnapAlign: "start" },
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

export default function AppsHome() {
  const { currentWorkspace } = useWorkspace();
  const { user } = useAuth();
  const workspaceId = currentWorkspace?.id;
  const discovery = useAppsDiscoveryStore(selectDiscovery(workspaceId));
  const feed = discovery.feed;
  const search = useAppsDiscoveryStore(s => s.searches.home);
  const fetchDiscovery = useAppsDiscoveryStore(s => s.fetchDiscovery);
  const fetchUsage = useAppsDiscoveryStore(s => s.fetchUsage);
  const fetchRecent = useAppsDiscoveryStore(s => s.fetchRecent);
  const fetchFeed = useAppsDiscoveryStore(s => s.fetchFeed);
  const fetchMoreFeed = useAppsDiscoveryStore(s => s.fetchMoreFeed);
  const searchApps = useAppsDiscoveryStore(s => s.searchApps);
  // In the store, so the palette can open this tab already searching.
  const query = useAppsDiscoveryStore(s => s.homeQuery);
  const setQuery = useAppsDiscoveryStore(s => s.setHomeQuery);
  const [filter, setFilter] = useState<Filter>("all");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // The next page waits for the person to scroll (or for a first page too
  // short to scroll): the first paint needs one page, not three.
  const [scrolled, setScrolled] = useState(false);
  // The explorer's app list, persisted: names to paint before /discovery.
  const explorerApps = useAppsStore(s =>
    s.apps.length > 0
      ? s.apps
      : workspaceId
        ? s.appsCacheByWorkspace[workspaceId]
        : undefined,
  );

  useEffect(() => {
    if (!workspaceId) return;
    void fetchDiscovery(workspaceId);
    void fetchUsage(workspaceId);
    void fetchRecent(workspaceId);
    const current =
      useAppsDiscoveryStore.getState().byWorkspace[workspaceId]?.feed;
    if (!current?.loadedAt || Date.now() - current.loadedAt > FEED_MAX_AGE_MS) {
      void fetchFeed(workspaceId);
    }
  }, [workspaceId, fetchDiscovery, fetchUsage, fetchRecent, fetchFeed]);

  // Debounced: a search re-reads the index server-side on every call.
  useEffect(() => {
    if (!workspaceId) return;
    const timer = setTimeout(
      () => void searchApps(workspaceId, query, "home"),
      200,
    );
    return () => clearTimeout(timer);
  }, [workspaceId, query, searchApps]);

  const searching = query.trim().length > 0;
  const feedMode = filter === "all" && !searching;
  const canLoadMore =
    feedMode && scrolled && !!feed.nextCursor && !feed.loading && !feed.expired;

  // Best-known apps, richest source first: the live (or persisted) discovery
  // listing, else the explorer's cached list. Cards upgrade in place as the
  // richer sources arrive (same key = same id).
  const knownApps = useMemo(
    () =>
      discovery.apps.length > 0
        ? discovery.apps
        : (explorerApps ?? []).map(discoveryFromMeta),
    [discovery.apps, explorerApps],
  );
  const provisional = useMemo(
    () =>
      provisionalFeed(knownApps, discovery.usage, {
        shelf: SHELF_SIZE,
        page: FEED_PAGE_SIZE,
      }),
    [knownApps, discovery.usage],
  );
  const usageKnown = Object.keys(discovery.usage).length > 0;

  useEffect(() => {
    if (knownApps.length === 0 && !feed.loaded) return;
    try {
      if (
        performance.getEntriesByName("apps-home:names", "mark").length === 0
      ) {
        performance.mark("apps-home:names");
      }
    } catch {
      // No Performance API.
    }
  }, [knownApps.length, feed.loaded]);

  // A first page that does not fill the scroller can never be scrolled:
  // let the sentinel load more on its own then.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrolled || !feed.loaded) return;
    if (el.scrollHeight <= el.clientHeight + 200) setScrolled(true);
  }, [feed.loaded, feed.items.length, scrolled]);

  const loadMore = useCallback(() => {
    if (workspaceId) void fetchMoreFeed(workspaceId);
  }, [workspaceId, fetchMoreFeed]);

  // The sentinel below the grid pulls the next page well before it is
  // reached. Its root is the home's own scroller (not the viewport), so the
  // margin applies where the scrolling happens.
  useEffect(() => {
    const target = sentinelRef.current;
    if (!canLoadMore || !target) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) loadMore();
      },
      { root: scrollRef.current, rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [canLoadMore, loadMore, feed.items.length]);

  const lists = useMemo(() => {
    const apps = discovery.apps;
    const me = { id: user?.id, email: user?.email };
    const mine = apps
      .filter(a => isMyApp(a, me))
      .sort((a, b) => a.title.localeCompare(b.title));
    return {
      recent:
        discovery.recentAvailable === true
          ? recentlyViewedApps(apps, discovery.recent, RECENT_LIMIT)
          : [],
      mine,
      attention: mine
        .map(app => ({ app, reasons: attentionReasons(app) }))
        .filter(x => x.reasons.length > 0),
    };
  }, [discovery, user?.id, user?.email]);

  if (!workspaceId) return null;

  const card = (
    app: DiscoveryApp,
    shelf: AppOpenShelf,
    position: number,
    extra?: { matches?: string[]; attention?: AttentionReason[] },
  ) => (
    <Box
      key={app.id}
      role={shelf === "popular" || shelf === "new" ? "listitem" : undefined}
      sx={{ minWidth: 0 }}
    >
      <AppCard
        workspaceId={workspaceId}
        app={app}
        usage={discovery.usage[app.id]}
        onOpen={a => {
          notePlacement(a.id, { surface: "home", shelf, position });
          focusAppsTab(a.id, a.title, appUrlSlug(a));
        }}
        {...extra}
      />
    </Box>
  );

  const shownInFeed =
    feed.popular.length + feed.fresh.length + feed.items.length;
  const chips: Array<{ key: Filter; label: string; count?: number }> = [
    { key: "all", label: "All" },
    ...(discovery.recentAvailable === true && lists.recent.length > 0
      ? [
          {
            key: "recent" as const,
            label: "Recently viewed",
            count: lists.recent.length,
          },
        ]
      : []),
    ...(lists.mine.length > 0
      ? [{ key: "mine" as const, label: "Mine", count: lists.mine.length }]
      : []),
    ...(lists.attention.length > 0
      ? [
          {
            key: "attention" as const,
            label: "Needs attention",
            count: lists.attention.length,
          },
        ]
      : []),
  ];
  const chooseFilter = (key: Filter) => {
    setFilter(key);
    if (searching) setQuery("");
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const skeletonRow = (title: string) => (
    <ShelfRow title={title}>
      {Array.from({ length: SHELF_SKELETONS }, (_, i) => (
        <Box key={i} role="listitem" sx={{ minWidth: 0 }}>
          <AppCardSkeleton />
        </Box>
      ))}
    </ShelfRow>
  );

  // Before the ranked feed answers: the same layout, from what is known —
  // shelves (or their reserved skeleton rows) and a first grid of cards,
  // never a spinner.
  const renderProvisional = () => (
    <Box aria-busy="true">
      {usageKnown && provisional.popular.length > 0 ? (
        <ShelfRow title="Popular" hint="Opened most by others this month">
          {provisional.popular.map((app, i) => card(app, "popular", i))}
        </ShelfRow>
      ) : (
        skeletonRow("Popular")
      )}
      {provisional.fresh.length > 0 ? (
        <ShelfRow title="New" hint="First published this week">
          {provisional.fresh.map((app, i) => card(app, "new", i))}
        </ShelfRow>
      ) : (
        skeletonRow("New")
      )}
      <Box component="section" aria-label="Recommended">
        <SectionTitle
          title="Recommended"
          hint="From what you and your teammates use"
        />
        <Box sx={GRID_SX}>
          {provisional.items.map((app, i) => card(app, "recommended", i))}
          {Array.from(
            { length: provisional.items.length > 0 ? 4 : 12 },
            (_, i) => (
              <AppCardSkeleton key={`skeleton-${i}`} />
            ),
          )}
        </Box>
      </Box>
    </Box>
  );

  const renderFeed = () => {
    if (!feed.loaded && !feed.error) return renderProvisional();
    if (feed.error && !feed.loaded) {
      return (
        <Stack spacing={1} sx={{ alignItems: "flex-start" }}>
          <Typography variant="body2" sx={{ color: "error.main" }}>
            {feed.error}
          </Typography>
          <Button size="small" onClick={() => void fetchFeed(workspaceId)}>
            Try again
          </Button>
        </Stack>
      );
    }
    if (feed.loaded && shownInFeed === 0) {
      return (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          No apps yet. Create one from the Apps explorer, or ask the agent to
          build one.
        </Typography>
      );
    }
    const done = feed.loaded && !feed.nextCursor && !feed.expired;
    return (
      <>
        {feed.popular.length > 0 && (
          <ShelfRow title="Popular" hint="Opened most by others this month">
            {feed.popular.map((app, i) => card(app, "popular", i))}
          </ShelfRow>
        )}
        {feed.fresh.length > 0 && (
          <ShelfRow title="New" hint="First published this week">
            {feed.fresh.map((app, i) => card(app, "new", i))}
          </ShelfRow>
        )}
        {(feed.items.length > 0 || feed.nextCursor) && (
          <Box component="section" aria-labelledby="apps-recommended">
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: "baseline", mb: 1.25 }}
            >
              <Typography
                id="apps-recommended"
                variant="subtitle1"
                component="h2"
                sx={{ fontWeight: 600 }}
              >
                Recommended
              </Typography>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                From what you and your teammates use
              </Typography>
            </Stack>
            <Box
              role="feed"
              aria-busy={feed.loading}
              aria-labelledby="apps-recommended"
              sx={GRID_SX}
            >
              {feed.items.map((app, i) => (
                <Box
                  key={app.id}
                  component="article"
                  aria-posinset={i + 1}
                  aria-setsize={feed.nextCursor ? -1 : feed.items.length}
                  aria-label={app.title}
                  sx={{ minWidth: 0 }}
                >
                  <AppCard
                    workspaceId={workspaceId}
                    app={app}
                    usage={discovery.usage[app.id]}
                    onOpen={a => {
                      notePlacement(a.id, {
                        surface: "home",
                        shelf: "recommended",
                        position: i,
                      });
                      focusAppsTab(a.id, a.title, appUrlSlug(a));
                    }}
                  />
                </Box>
              ))}
              {feed.loading &&
                Array.from({ length: Math.min(8, FEED_PAGE_SIZE) }, (_, i) => (
                  <AppCardSkeleton key={`skeleton-${i}`} />
                ))}
            </Box>
          </Box>
        )}
        <Box
          ref={sentinelRef}
          sx={{ display: "flex", justifyContent: "center", py: 3 }}
        >
          {feed.expired ? (
            <Stack spacing={1} sx={{ alignItems: "center" }}>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                This feed is out of date.
              </Typography>
              <Button size="small" onClick={() => void fetchFeed(workspaceId)}>
                Refresh
              </Button>
            </Stack>
          ) : feed.error ? (
            <Stack spacing={1} sx={{ alignItems: "center" }}>
              <Typography variant="body2" sx={{ color: "error.main" }}>
                {feed.error}
              </Typography>
              <Button size="small" onClick={loadMore}>
                Try again
              </Button>
            </Stack>
          ) : feed.nextCursor ? (
            // Scrolling loads on its own; the button is for keyboards and
            // screen readers (and the one-in-a-million missed intersection).
            <Button
              size="small"
              variant="text"
              disabled={feed.loading}
              onClick={loadMore}
            >
              {feed.loading ? "Loading…" : "Show more apps"}
            </Button>
          ) : done ? (
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {`You've seen all ${shownInFeed} apps`}
            </Typography>
          ) : null}
        </Box>
      </>
    );
  };

  const renderList = (
    items: Array<{ app: DiscoveryApp; reasons?: AttentionReason[] }>,
    shelf: AppOpenShelf,
    empty: string,
  ) =>
    items.length === 0 ? (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {empty}
      </Typography>
    ) : (
      <Box sx={GRID_SX}>
        {items.map(({ app, reasons }, i) =>
          card(app, shelf, i, reasons ? { attention: reasons } : undefined),
        )}
      </Box>
    );

  return (
    <Box
      ref={scrollRef}
      onScroll={scrolled ? undefined : () => setScrolled(true)}
      sx={{ height: "100%", overflow: "auto", bgcolor: "background.default" }}
    >
      <Box
        sx={{
          maxWidth: 1280,
          mx: "auto",
          px: { xs: 2, sm: 3 },
          py: { xs: 2, sm: 3 },
        }}
      >
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          sx={{
            alignItems: { xs: "stretch", sm: "center" },
            justifyContent: "space-between",
            mb: 2,
          }}
        >
          <Box>
            <Typography variant="h6" component="h1" sx={{ fontWeight: 600 }}>
              Apps
            </Typography>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {knownApps.length > 0
                ? `${knownApps.length} apps in ${currentWorkspace?.name ?? "this workspace"}`
                : "\u00a0"}
            </Typography>
          </Box>
          <TextField
            size="small"
            placeholder="Search apps, owners, tables…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape") setQuery("");
            }}
            sx={{ width: { xs: "100%", sm: 360 } }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon size={16} />
                  </InputAdornment>
                ),
                endAdornment: search.loading ? (
                  <InputAdornment position="end">
                    <CircularProgress size={14} />
                  </InputAdornment>
                ) : undefined,
              },
              htmlInput: { "aria-label": "Search apps" },
            }}
          />
        </Stack>

        <Stack
          direction="row"
          role="toolbar"
          aria-label="Filter apps"
          spacing={1}
          sx={{
            mb: 2.5,
            overflowX: "auto",
            pb: 0.5,
            "& .MuiChip-root": { flexShrink: 0 },
          }}
        >
          {chips.map(chip => {
            const selected = !searching && filter === chip.key;
            return (
              <Chip
                key={chip.key}
                label={
                  chip.count !== undefined
                    ? `${chip.label} · ${chip.count}`
                    : chip.label
                }
                clickable
                color={selected ? "primary" : "default"}
                variant={selected ? "filled" : "outlined"}
                onClick={() => chooseFilter(chip.key)}
                aria-pressed={selected}
              />
            );
          })}
        </Stack>

        {discovery.appsError && (
          <Typography variant="body2" sx={{ color: "error.main", mb: 2 }}>
            {discovery.appsError}
          </Typography>
        )}

        <Box aria-live="polite" sx={visuallyHidden}>
          {feedMode && feed.loaded
            ? feed.nextCursor
              ? `Showing ${shownInFeed} of ${feed.total} apps`
              : `All ${shownInFeed} apps shown`
            : ""}
        </Box>

        {searching ? (
          search.query && !search.loading && search.results.length === 0 ? (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {search.error ?? `No apps match “${search.query}”.`}
            </Typography>
          ) : (
            <Box component="section" aria-label="Search results">
              <SectionTitle
                title="Results"
                hint={
                  search.results.length > 0
                    ? `${search.results.length} match${search.results.length === 1 ? "" : "es"}`
                    : undefined
                }
              />
              <Box sx={GRID_SX}>
                {search.results.map((hit, i) =>
                  card(hit, "search", i, { matches: hit.matches }),
                )}
              </Box>
            </Box>
          )
        ) : filter === "recent" ? (
          renderList(
            lists.recent.map(app => ({ app })),
            "recent",
            "You have not opened any apps lately.",
          )
        ) : filter === "mine" ? (
          renderList(
            lists.mine.map(app => ({ app })),
            "mine",
            "You have no apps yet.",
          )
        ) : filter === "attention" ? (
          renderList(
            lists.attention,
            "attention",
            "Nothing needs your attention.",
          )
        ) : (
          renderFeed()
        )}
      </Box>
    </Box>
  );
}

const visuallyHidden = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;
