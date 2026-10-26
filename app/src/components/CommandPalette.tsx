/**
 * Command palette (Cmd/Ctrl+K).
 *
 * Default mode searches navigable entities (open tabs, apps, consoles via
 * the server search endpoint, dbt projects, flows) plus the top-matching
 * commands. Apps match instantly on the loaded list and are refined by the
 * server's app search (tables, owner, usage); with no query the palette
 * shows Recently viewed and Popular apps. Cmd/Ctrl+Enter opens the Apps
 * home searching for the query. Typing `>` switches to commands-only mode
 * (VS Code style). Built on MUI primitives — no extra dependencies.
 */

import {
  Box,
  CircularProgress,
  Dialog,
  IconButton,
  InputBase,
  Typography,
} from "@mui/material";
import { ChevronRight, Search, X as ClearIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../contexts/auth-context";
import { useTheme as useAppTheme } from "../contexts/ThemeContext";
import { buildCommands } from "../lib/command-palette/commands";
import {
  consoleResultItems,
  searchDbtProjects,
  searchFlows,
  searchOpenTabs,
} from "../lib/command-palette/entity-search";
import {
  scoreItem,
  type PaletteItem,
  type PaletteRunContext,
} from "../lib/command-palette/types";
import {
  appPaletteItems,
  mergeAppResults,
  rankAppsLocally,
  type PaletteApp,
} from "../lib/command-palette/app-search";
import {
  ownerHandle,
  popularApps,
  recentlyViewedApps,
} from "../lib/apps-discovery";
import { focusAppsHomeTab } from "../apps-runtime/shell";
import { appFrameForMessage } from "../lib/app-frame";
import { useCommandPaletteStore } from "../store/commandPaletteStore";
import {
  selectDiscovery,
  useAppsDiscoveryStore,
} from "../store/appsDiscoveryStore";
import { useAppsStore } from "../store/appsStore";
import { useDbtStore } from "../store/dbtStore";
import { useFlowStore } from "../store/flowStore";
import { useUIStore } from "../store/uiStore";
import { useIsMobile } from "../hooks/useIsMobile";

const SEARCH_DEBOUNCE_MS = 200;
const APP_RESULTS = 6;
const RECENT_APPS = 5;
const POPULAR_APPS = 3;

type Row =
  | { type: "header"; label: string }
  | { type: "item"; item: PaletteItem; index: number };

function groupIntoRows(items: PaletteItem[]): Row[] {
  const rows: Row[] = [];
  let lastSection: string | null = null;
  items.forEach((item, index) => {
    if (item.section !== lastSection) {
      rows.push({ type: "header", label: item.section });
      lastSection = item.section;
    }
    rows.push({ type: "item", item, index });
  });
  return rows;
}

export default function CommandPalette() {
  const open = useCommandPaletteStore(state => state.open);
  // On a phone the palette IS the search screen (Browse's search field opens
  // it), so it takes the whole viewport instead of floating as a dialog.
  const isMobile = useIsMobile();
  const consoleResults = useCommandPaletteStore(state => state.consoleResults);
  const searching = useCommandPaletteStore(state => state.searching);
  const workspaceId = useUIStore(state => state.currentWorkspaceId);
  const { user } = useAuth();
  const { setMode } = useAppTheme();
  const appsList = useAppsStore(state => state.apps);
  const discovery = useAppsDiscoveryStore(
    selectDiscovery(workspaceId ?? undefined),
  );
  const appSearch = useAppsDiscoveryStore(state => state.searches.palette);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Last pointer position — selection follows the mouse only when it really
  // moves, not when items re-render underneath a stationary cursor (the
  // cmdk behavior). Null until the first move after opening.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const isSuperAdmin = Boolean(
    (user as { isSuperAdmin?: boolean } | null | undefined)?.isSuperAdmin,
  );
  const commandMode = query.startsWith(">");
  const effectiveQuery = (commandMode ? query.slice(1) : query).trim();

  // Global Cmd/Ctrl+K binding (capture phase so it wins over Monaco).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopPropagation();
        useCommandPaletteStore.getState().togglePalette();
      }
    };
    // An app on its own origin is a cross-origin frame: while it has focus
    // its keystrokes never reach this window, so the SDK forwards the
    // shortcut instead. Only an app frame on this page is believed.
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; key?: unknown } | null;
      if (data?.type !== "mako-app:shortcut" || data.key !== "mod+k") return;
      if (!appFrameForMessage(event)) return;
      // Take focus back from the frame, or the palette's input cannot.
      window.focus();
      useCommandPaletteStore.getState().togglePalette();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  // Reset transient state and warm entity lists whenever the palette opens.
  useEffect(() => {
    if (!open || !workspaceId) return;
    setQuery("");
    setSelectedIndex(0);
    pointerRef.current = null;
    const swallow = () => undefined;
    void useDbtStore.getState().fetchProjects(workspaceId).catch(swallow);
    void useFlowStore.getState().fetchFlows(workspaceId).catch(swallow);
    // Apps: the list for the instant match (usually already loaded by the
    // explorer), and this person's recent + popular for the empty state.
    if (useAppsStore.getState().apps.length === 0) {
      void useAppsStore.getState().fetchApps(workspaceId).catch(swallow);
    }
    const discoveryStore = useAppsDiscoveryStore.getState();
    void discoveryStore.fetchRecent(workspaceId);
    void discoveryStore.fetchUsage(workspaceId);
    discoveryStore.clearSearch("palette");
  }, [open, workspaceId]);

  // Debounced server-side console search (default mode only).
  useEffect(() => {
    if (!open || !workspaceId) return;
    if (commandMode || effectiveQuery.length < 2) {
      useCommandPaletteStore.getState().clearConsoleResults();
      return;
    }
    const timeout = setTimeout(() => {
      void useCommandPaletteStore
        .getState()
        .searchConsoles(workspaceId, effectiveQuery);
      void useAppsDiscoveryStore
        .getState()
        .searchApps(workspaceId, effectiveQuery, "palette");
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [open, workspaceId, commandMode, effectiveQuery]);

  // Every app this person can see, in the palette's terms: the discovery
  // listing when it is loaded (it knows owners), else the explorer's list.
  const paletteApps = useMemo<PaletteApp[]>(() => {
    if (discovery.appsLoaded) {
      return discovery.apps.map(app => ({
        id: app.id,
        title: app.title,
        description: app.description,
        path: app.path,
        slug: app.slug,
        owner: ownerHandle(app) ?? undefined,
      }));
    }
    return appsList.map(app => ({
      id: app.id,
      title: app.title,
      description: app.description,
      path: app.path,
      slug: app.slug,
    }));
  }, [discovery.appsLoaded, discovery.apps, appsList]);

  const items = useMemo<PaletteItem[]>(() => {
    if (!open || !workspaceId) return [];

    const commands = buildCommands({ isSuperAdmin });
    const scoredCommands = commands
      .map(command => ({
        command,
        score: scoreItem(effectiveQuery, command.title, command.keywords),
      }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    if (commandMode) {
      return scoredCommands.map(entry => entry.command);
    }

    let appItems: PaletteItem[];
    if (!effectiveQuery) {
      const recent = recentlyViewedApps(
        paletteApps,
        discovery.recent,
        RECENT_APPS,
      );
      const recentIds = new Set(recent.map(a => a.id));
      const popular = popularApps(
        paletteApps.filter(a => !recentIds.has(a.id)),
        discovery.usage,
        POPULAR_APPS,
      );
      appItems = [
        ...appPaletteItems(recent, "Recently viewed apps"),
        ...appPaletteItems(popular, "Popular apps"),
      ];
    } else {
      const local = rankAppsLocally(
        paletteApps,
        effectiveQuery,
        discovery.usage,
        APP_RESULTS,
      );
      const serverAnswered =
        appSearch.workspaceId === workspaceId &&
        appSearch.query === effectiveQuery &&
        !appSearch.loading &&
        !appSearch.error;
      const server = serverAnswered
        ? appSearch.results.map(hit => ({
            id: hit.id,
            title: hit.title,
            description: hit.description,
            path: hit.path,
            slug: hit.slug,
            owner: ownerHandle(hit) ?? undefined,
            related: hit.matches?.includes("related") ?? false,
          }))
        : null;
      appItems = appPaletteItems(
        mergeAppResults(local, server, APP_RESULTS),
        "Apps",
      );
    }

    return [
      ...searchOpenTabs(effectiveQuery),
      ...(effectiveQuery ? appItems : []),
      // Surface a few command hits in default mode for discoverability.
      ...scoredCommands
        .slice(0, effectiveQuery ? 3 : 4)
        .map(entry => entry.command),
      ...(effectiveQuery ? [] : appItems),
      ...(effectiveQuery.length >= 2
        ? consoleResultItems(workspaceId, consoleResults)
        : []),
      ...searchDbtProjects(effectiveQuery),
      ...searchFlows(workspaceId, effectiveQuery),
    ];
  }, [
    open,
    workspaceId,
    commandMode,
    effectiveQuery,
    consoleResults,
    isSuperAdmin,
    paletteApps,
    discovery.recent,
    discovery.usage,
    appSearch,
  ]);

  const rows = useMemo(() => groupIntoRows(items), [items]);

  // Clamp selection when the result set shrinks.
  useEffect(() => {
    setSelectedIndex(index => Math.min(index, Math.max(items.length - 1, 0)));
  }, [items.length]);

  // Keep the selected row visible.
  useEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-palette-index="${selectedIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const runItem = useCallback(
    (item: PaletteItem) => {
      if (!workspaceId) return;
      const ctx: PaletteRunContext = { workspaceId, setThemeMode: setMode };
      useCommandPaletteStore.getState().closePalette();
      item.run(ctx);
    },
    [workspaceId, setMode],
  );

  // Bound at the dialog level (not the input) so navigation works no matter
  // where focus ends up. Supports the cmdk staples: arrows (with wrap),
  // Home/End, and emacs-style Ctrl+N/P.
  const onDialogKeyDown = (event: React.KeyboardEvent) => {
    const count = items.length;
    const isCtrl = (key: string) => event.ctrlKey && event.key === key;
    // Works with no results too: "nothing here, show me everything".
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      !commandMode &&
      effectiveQuery
    ) {
      // Secondary action: the full Apps home, already searching.
      event.preventDefault();
      useAppsDiscoveryStore.getState().setHomeQuery(effectiveQuery);
      useCommandPaletteStore.getState().closePalette();
      focusAppsHomeTab();
      return;
    }
    if (count === 0) return;

    if (event.key === "ArrowDown" || isCtrl("n")) {
      event.preventDefault();
      setSelectedIndex(index => (index + 1) % count);
    } else if (event.key === "ArrowUp" || isCtrl("p")) {
      event.preventDefault();
      setSelectedIndex(index => (index - 1 + count) % count);
    } else if (event.key === "Home" && !query) {
      event.preventDefault();
      setSelectedIndex(0);
    } else if (event.key === "End" && !query) {
      event.preventDefault();
      setSelectedIndex(count - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[selectedIndex];
      if (item) runItem(item);
    }
  };

  if (!workspaceId) return null;

  return (
    <Dialog
      open={open}
      onClose={() => useCommandPaletteStore.getState().closePalette()}
      fullWidth
      fullScreen={isMobile}
      maxWidth="sm"
      // Without this, MUI restores focus to the previously focused element
      // (e.g. Monaco) when the dialog opens, defeating the input autofocus.
      disableRestoreFocus
      onKeyDown={onDialogKeyDown}
      sx={{ "& .MuiDialog-container": { alignItems: "flex-start" } }}
      slotProps={{
        transition: { onEntered: () => inputRef.current?.focus() },
        paper: { sx: { mt: "12vh", overflow: "hidden" } },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          py: 1.25,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        {commandMode ? <ChevronRight size={16} /> : <Search size={16} />}
        <InputBase
          autoFocus
          fullWidth
          inputRef={inputRef}
          value={query}
          placeholder="Search consoles, apps… type > for commands"
          onChange={event => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          sx={{ fontSize: 14 }}
        />
        {searching || appSearch.loading ? (
          <CircularProgress size={14} />
        ) : query ? (
          <IconButton
            size="small"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              setSelectedIndex(0);
              inputRef.current?.focus();
            }}
          >
            <ClearIcon size={14} />
          </IconButton>
        ) : null}
      </Box>

      <Box ref={listRef} sx={{ maxHeight: 400, overflowY: "auto", py: 0.5 }}>
        {rows.length === 0 && (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              px: 2,
              py: 2,
              textAlign: "center",
            }}
          >
            {effectiveQuery ? "No results" : "Start typing to search"}
          </Typography>
        )}
        {rows.map(row =>
          row.type === "header" ? (
            <Typography
              key={`header-${row.label}`}
              variant="caption"
              sx={{
                color: "text.secondary",
                display: "block",
                px: 2,
                pt: 1,
                pb: 0.25,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {row.label}
            </Typography>
          ) : (
            <Box
              key={row.item.id}
              data-palette-index={row.index}
              onClick={() => runItem(row.item)}
              // preventDefault keeps the search input focused through clicks.
              onMouseDown={event => event.preventDefault()}
              onMouseMove={event => {
                const prev = pointerRef.current;
                pointerRef.current = { x: event.clientX, y: event.clientY };
                if (
                  prev &&
                  prev.x === event.clientX &&
                  prev.y === event.clientY
                ) {
                  return;
                }
                if (prev) setSelectedIndex(row.index);
              }}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.25,
                px: 2,
                py: 0.75,
                cursor: "pointer",
                bgcolor:
                  row.index === selectedIndex
                    ? "action.selected"
                    : "transparent",
              }}
            >
              <row.item.icon size={15} />
              <Typography variant="body2" noWrap sx={{ flex: 1 }}>
                {row.item.title}
              </Typography>
              {"subtitle" in row.item && row.item.subtitle && (
                <Typography
                  variant="caption"
                  noWrap
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {row.item.subtitle}
                </Typography>
              )}
            </Box>
          ),
        )}
      </Box>
      {!commandMode && effectiveQuery && !isMobile && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            px: 2,
            py: 0.75,
            borderTop: 1,
            borderColor: "divider",
            display: "block",
          }}
        >
          {/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"}+Enter to
          search all apps in Apps home
        </Typography>
      )}
    </Dialog>
  );
}
