/**
 * Command palette (Cmd/Ctrl+K).
 *
 * Default mode searches navigable entities (open tabs, consoles via the
 * server search endpoint, dashboards, apps, dbt projects, flows) plus the
 * top-matching commands. Typing `>` switches to commands-only mode
 * (VS Code style). Built on MUI primitives — no extra dependencies.
 */

import {
  Box,
  CircularProgress,
  Dialog,
  InputBase,
  Typography,
} from "@mui/material";
import { ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../contexts/auth-context";
import { useTheme as useAppTheme } from "../contexts/ThemeContext";
import { buildCommands } from "../lib/command-palette/commands";
import {
  consoleResultItems,
  searchApps,
  searchDashboards,
  searchDbtProjects,
  searchFlows,
  searchOpenTabs,
} from "../lib/command-palette/entity-search";
import {
  scoreItem,
  type PaletteItem,
  type PaletteRunContext,
} from "../lib/command-palette/types";
import { useAppStore } from "../store/appStore";
import { useCommandPaletteStore } from "../store/commandPaletteStore";
import { useDashboardTreeStore } from "../store/dashboardTreeStore";
import { useDbtStore } from "../store/dbtStore";
import { useFlowStore } from "../store/flowStore";
import { useUIStore } from "../store/uiStore";

const SEARCH_DEBOUNCE_MS = 200;

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
  const consoleResults = useCommandPaletteStore(state => state.consoleResults);
  const searching = useCommandPaletteStore(state => state.searching);
  const workspaceId = useUIStore(state => state.currentWorkspaceId);
  const { user } = useAuth();
  const { setMode } = useAppTheme();

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
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Reset transient state and warm entity lists whenever the palette opens.
  useEffect(() => {
    if (!open || !workspaceId) return;
    setQuery("");
    setSelectedIndex(0);
    pointerRef.current = null;
    const swallow = () => undefined;
    void useDashboardTreeStore.getState().fetchTree(workspaceId).catch(swallow);
    void useAppStore.getState().fetchList(workspaceId).catch(swallow);
    void useDbtStore.getState().fetchProjects(workspaceId).catch(swallow);
    void useFlowStore.getState().fetchFlows(workspaceId).catch(swallow);
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
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [open, workspaceId, commandMode, effectiveQuery]);

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

    return [
      ...searchOpenTabs(effectiveQuery),
      // Surface a few command hits in default mode for discoverability.
      ...scoredCommands
        .slice(0, effectiveQuery ? 3 : 4)
        .map(entry => entry.command),
      ...(effectiveQuery.length >= 2
        ? consoleResultItems(workspaceId, consoleResults)
        : []),
      ...searchDashboards(workspaceId, effectiveQuery),
      ...searchApps(workspaceId, effectiveQuery),
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
    if (count === 0) return;
    const isCtrl = (key: string) => event.ctrlKey && event.key === key;

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
      maxWidth="sm"
      // Without this, MUI restores focus to the previously focused element
      // (e.g. Monaco) when the dialog opens, defeating the input autofocus.
      disableRestoreFocus
      TransitionProps={{ onEntered: () => inputRef.current?.focus() }}
      onKeyDown={onDialogKeyDown}
      sx={{ "& .MuiDialog-container": { alignItems: "flex-start" } }}
      PaperProps={{ sx: { mt: "12vh", overflow: "hidden" } }}
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
          placeholder="Search consoles, dashboards, apps… type > for commands"
          onChange={event => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          sx={{ fontSize: 14 }}
        />
        {searching && <CircularProgress size={14} />}
      </Box>

      <Box ref={listRef} sx={{ maxHeight: 400, overflowY: "auto", py: 0.5 }}>
        {rows.length === 0 && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ px: 2, py: 2, textAlign: "center" }}
          >
            {effectiveQuery ? "No results" : "Start typing to search"}
          </Typography>
        )}
        {rows.map(row =>
          row.type === "header" ? (
            <Typography
              key={`header-${row.label}`}
              variant="caption"
              color="text.secondary"
              sx={{
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
                <Typography variant="caption" color="text.secondary" noWrap>
                  {row.item.subtitle}
                </Typography>
              )}
            </Box>
          ),
        )}
      </Box>
    </Dialog>
  );
}
