/**
 * Apps home — the full-screen catalogue that answers "which app should I
 * open?" for a workspace where everyone builds apps. Shelves, in order:
 * Popular this month, New this week, Recently viewed by me, My apps, and
 * (for the owner) Needs attention — plus a search over title, description,
 * folder, owner and the warehouse tables each app reads.
 *
 * Popularity and recent views come from the usage API; where it is not
 * deployed those two shelves hide and the rest still work.
 */
import { useEffect, useMemo } from "react";
import {
  Box,
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
  selectDiscovery,
  useAppsDiscoveryStore,
} from "../../store/appsDiscoveryStore";
import { appUrlSlug } from "../../store/appsStore";
import { focusAppsTab } from "../../apps-runtime/shell";
import {
  attentionReasons,
  isMyApp,
  newApps,
  popularApps,
  recentlyViewedApps,
  type DiscoveryApp,
} from "../../lib/apps-discovery";
import AppCard from "./AppCard";

const SHELF_LIMIT = 8;
const NEW_WINDOW_DAYS = 7;

function Shelf({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Box component="section" sx={{ mb: 4 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "baseline", mb: 1.25 }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        {hint && (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {hint}
          </Typography>
        )}
      </Stack>
      <Box
        sx={{
          display: "grid",
          gap: 1.5,
          gridTemplateColumns: {
            xs: "repeat(auto-fill, minmax(160px, 1fr))",
            sm: "repeat(auto-fill, minmax(220px, 1fr))",
          },
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
  const search = useAppsDiscoveryStore(s => s.searches.home);
  const fetchDiscovery = useAppsDiscoveryStore(s => s.fetchDiscovery);
  const fetchUsage = useAppsDiscoveryStore(s => s.fetchUsage);
  const fetchRecent = useAppsDiscoveryStore(s => s.fetchRecent);
  const searchApps = useAppsDiscoveryStore(s => s.searchApps);
  // In the store, so the palette can open this tab already searching.
  const query = useAppsDiscoveryStore(s => s.homeQuery);
  const setQuery = useAppsDiscoveryStore(s => s.setHomeQuery);

  useEffect(() => {
    if (!workspaceId) return;
    void fetchDiscovery(workspaceId);
    void fetchUsage(workspaceId);
    void fetchRecent(workspaceId);
  }, [workspaceId, fetchDiscovery, fetchUsage, fetchRecent]);

  // Debounced: a search re-reads the index server-side on every call.
  useEffect(() => {
    if (!workspaceId) return;
    const timer = setTimeout(
      () => void searchApps(workspaceId, query, "home"),
      200,
    );
    return () => clearTimeout(timer);
  }, [workspaceId, query, searchApps]);

  const open = (app: DiscoveryApp) =>
    focusAppsTab(app.id, app.title, appUrlSlug(app));

  const shelves = useMemo(() => {
    const apps = discovery.apps;
    const me = { id: user?.id, email: user?.email };
    const mine = apps
      .filter(a => isMyApp(a, me))
      .sort((a, b) => a.title.localeCompare(b.title));
    return {
      popular:
        discovery.usageAvailable === true
          ? popularApps(apps, discovery.usage, SHELF_LIMIT)
          : [],
      fresh: newApps(apps, NEW_WINDOW_DAYS).slice(0, SHELF_LIMIT),
      recent:
        discovery.recentAvailable === true
          ? recentlyViewedApps(apps, discovery.recent, SHELF_LIMIT)
          : [],
      mine,
      attention: mine
        .map(app => ({ app, reasons: attentionReasons(app) }))
        .filter(x => x.reasons.length > 0),
    };
  }, [discovery, user?.id, user?.email]);

  if (!workspaceId) return null;
  const searching = query.trim().length > 0;
  const card = (app: DiscoveryApp, extra?: { matches?: string[] }) => (
    <AppCard
      key={app.id}
      workspaceId={workspaceId}
      app={app}
      usage={discovery.usage[app.id]}
      onOpen={open}
      {...extra}
    />
  );
  const nothing =
    discovery.appsLoaded &&
    shelves.popular.length +
      shelves.fresh.length +
      shelves.recent.length +
      shelves.mine.length ===
      0;

  return (
    <Box
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
            mb: 3,
          }}
        >
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Apps
            </Typography>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {discovery.appsLoaded
                ? `${discovery.apps.length} apps in ${currentWorkspace?.name ?? "this workspace"}`
                : "Loading apps…"}
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

        {discovery.appsError && (
          <Typography variant="body2" sx={{ color: "error.main", mb: 2 }}>
            {discovery.appsError}
          </Typography>
        )}

        {searching ? (
          search.query && !search.loading && search.results.length === 0 ? (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {search.error ?? `No apps match “${search.query}”.`}
            </Typography>
          ) : (
            <Shelf
              title="Results"
              hint={
                search.results.length > 0
                  ? `${search.results.length} match${search.results.length === 1 ? "" : "es"}`
                  : undefined
              }
            >
              {search.results.map(hit => card(hit, { matches: hit.matches }))}
            </Shelf>
          )
        ) : !discovery.appsLoaded && discovery.appsLoading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <>
            {shelves.popular.length > 0 && (
              <Shelf title="Popular this month" hint="Opened most by others">
                {shelves.popular.map(app => card(app))}
              </Shelf>
            )}
            {shelves.fresh.length > 0 && (
              <Shelf title="New this week">
                {shelves.fresh.map(app => card(app))}
              </Shelf>
            )}
            {shelves.recent.length > 0 && (
              <Shelf title="Recently viewed by me">
                {shelves.recent.map(app => card(app))}
              </Shelf>
            )}
            {shelves.mine.length > 0 && (
              <Shelf title="My apps" hint={`${shelves.mine.length}`}>
                {shelves.mine.map(app => card(app))}
              </Shelf>
            )}
            {shelves.attention.length > 0 && (
              <Shelf
                title="Needs attention"
                hint="Your apps with a failed deploy, failing data or stale data"
              >
                {shelves.attention.map(({ app, reasons }) => (
                  <AppCard
                    key={app.id}
                    workspaceId={workspaceId}
                    app={app}
                    usage={discovery.usage[app.id]}
                    attention={reasons}
                    onOpen={open}
                  />
                ))}
              </Shelf>
            )}
            {nothing && (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                No apps yet. Create one from the Apps explorer, or ask the agent
                to build one.
              </Typography>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
