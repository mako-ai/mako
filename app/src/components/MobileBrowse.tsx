/**
 * The phone's Browse tab.
 *
 * Two levels. HOME is what the desktop rail never had: search (the command
 * palette), a Recent list across every kind, and a grid of the explorers.
 * EXPLORER is one explorer's panel — the same component the desktop left
 * pane renders — under a back button. Tapping a node there opens a tab,
 * and App.tsx switches to View.
 */
import { startTransition, useCallback } from "react";
import {
  Box,
  ButtonBase,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  ChevronLeft as BackIcon,
  ChevronRight as OpenIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
} from "lucide-react";
import { SidebarUserMenu } from "./Sidebar";
import { topNavigationItems, type NavigationView } from "../lib/explorer-nav";
import { useAuth } from "../contexts/auth-context";
import { useWorkspace } from "../contexts/workspace-context";
import { useUIStore, selectActiveExplorer } from "../store/uiStore";
import { useConsoleStore } from "../store/consoleStore";
import { useCommandPaletteStore } from "../store/commandPaletteStore";
import {
  useRecentsStore,
  selectRecents,
  type RecentEntry,
} from "../store/recentsStore";
import { tabKindIcon } from "../lib/entity-icons";
import { relativeTime } from "../lib/relative-time";
import { tabKindEntityLabel } from "../lib/entity-labels";
import { focusDashboardTab } from "../dashboard-runtime/shell";
import { focusNotebookTab } from "../notebook-runtime/shell";
import { focusAppsTab } from "../apps-runtime/shell";

const EXPLORER_LABELS: Partial<Record<NavigationView, string>> =
  Object.fromEntries(topNavigationItems.map(i => [i.view, i.label]));

function Identity() {
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      {currentWorkspace?.name && (
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            lineHeight: 1.2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {currentWorkspace.name}
        </Typography>
      )}
      {user?.email && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            display: "block",
            lineHeight: 1.2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {user.email}
        </Typography>
      )}
    </Box>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Typography
      variant="caption"
      sx={{
        display: "block",
        px: 1,
        pb: 0.5,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "text.secondary",
      }}
    >
      {children}
    </Typography>
  );
}

function RecentRow({
  entry,
  onOpen,
}: {
  entry: RecentEntry;
  onOpen: (entry: RecentEntry) => void;
}) {
  const Icon = tabKindIcon(entry.kind);
  return (
    <ButtonBase
      onClick={() => onOpen(entry)}
      sx={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        minHeight: 48,
        px: 1,
        py: 0.75,
        borderRadius: 1,
        textAlign: "left",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: 1,
          border: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.secondary",
          flexShrink: 0,
        }}
      >
        <Icon size={18} strokeWidth={1.5} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
          {entry.title}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {tabKindEntityLabel(entry.kind)} · {relativeTime(entry.at)}
        </Typography>
      </Box>
      <OpenIcon size={18} strokeWidth={1.5} style={{ opacity: 0.6 }} />
    </ButtonBase>
  );
}

export default function MobileBrowse({
  explorer,
}: {
  /** The active explorer's panel — the same element the desktop pane shows. */
  explorer: React.ReactNode;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const browseView = useUIStore(state => state.mobileBrowseView);
  const setBrowseView = useUIStore(state => state.setMobileBrowseView);
  const activeExplorer = useUIStore(selectActiveExplorer);
  const setLeftPane = useUIStore(state => state.setLeftPane);
  const openLeftPane = useUIStore(state => state.openLeftPane);
  const setMobileConsolePane = useUIStore(state => state.setMobileConsolePane);
  const openPalette = useCommandPaletteStore(state => state.openPalette);
  const recents = useRecentsStore(selectRecents(workspaceId));
  const removeRecent = useRecentsStore(state => state.remove);

  const enterExplorer = useCallback(
    (view: NavigationView) => {
      startTransition(() => {
        setLeftPane(view as Exclude<NavigationView, "views">);
        openLeftPane();
        setBrowseView("explorer");
      });
    },
    [setLeftPane, openLeftPane, setBrowseView],
  );

  // Reopen by kind. Consoles are fetched from the server (their content is
  // not in the entry); the others are focus-or-open with what the entry
  // carries. App.tsx switches to View once a tab becomes active.
  const openRecent = useCallback(
    (entry: RecentEntry) => {
      if (!workspaceId) return;
      switch (entry.kind) {
        case "console": {
          setMobileConsolePane("query");
          void useConsoleStore
            .getState()
            .openConsoleFromServer(workspaceId, entry.id)
            .then(() => {
              // The server no longer has it: the entry is stale, drop it.
              if (!useConsoleStore.getState().tabs[entry.id]) {
                removeRecent(workspaceId, "console", entry.id);
              }
            });
          break;
        }
        case "dashboard":
          focusDashboardTab(entry.id, entry.title);
          break;
        case "notebook":
          focusNotebookTab(entry.id, entry.title);
          break;
        case "app":
          focusAppsTab(entry.id, entry.title, entry.slug);
          break;
      }
    },
    [workspaceId, setMobileConsolePane, removeRecent],
  );

  if (browseView === "explorer") {
    const label =
      (activeExplorer && EXPLORER_LABELS[activeExplorer as NavigationView]) ??
      (activeExplorer === "settings" ? "Settings" : "Explore");
    return (
      <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            px: 0.5,
            minHeight: 52,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <IconButton
            aria-label="Back to Browse"
            onClick={() => setBrowseView("home")}
            sx={{ width: 44, height: 44 }}
          >
            <BackIcon size={22} strokeWidth={1.5} />
          </IconButton>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
            {label}
          </Typography>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{explorer}</Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      {/* Workspace + user, and the way into Settings. */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          pt: 1.25,
          pb: 0.75,
        }}
      >
        <SidebarUserMenu tooltipPlacement="bottom" />
        <Identity />
        <Tooltip title="Settings">
          <IconButton
            aria-label="Settings"
            onClick={() => enterExplorer("settings")}
            sx={{ width: 40, height: 40 }}
          >
            <SettingsIcon size={20} strokeWidth={1.5} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Search = the command palette: consoles (server search), dashboards,
          flows, projects and open tabs, one field. */}
      <Box sx={{ px: 1.5, pb: 1 }}>
        <ButtonBase
          onClick={openPalette}
          aria-label="Search"
          sx={{
            width: "100%",
            height: 40,
            borderRadius: 20,
            bgcolor: "action.hover",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            gap: 1,
            px: 1.75,
            color: "text.secondary",
          }}
        >
          <SearchIcon size={18} strokeWidth={1.5} />
          <Typography variant="body2" color="text.secondary" noWrap>
            Search consoles, dashboards, apps…
          </Typography>
        </ButtonBase>
      </Box>

      {recents.length > 0 && (
        <Box sx={{ px: 1, pt: 1 }}>
          <SectionLabel>Recent</SectionLabel>
          {recents.map(entry => (
            <RecentRow
              key={`${entry.kind}:${entry.id}`}
              entry={entry}
              onOpen={openRecent}
            />
          ))}
        </Box>
      )}

      <Box sx={{ px: 1, pt: recents.length > 0 ? 2 : 1, pb: 2 }}>
        <SectionLabel>Explore</SectionLabel>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 1,
            px: 0.5,
          }}
        >
          {topNavigationItems.map(item => {
            const Icon = item.icon;
            return (
              <ButtonBase
                key={item.view}
                onClick={() => enterExplorer(item.view)}
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 0.75,
                  minHeight: 64,
                  px: 0.5,
                  py: 1,
                  borderRadius: 1,
                  border: 1,
                  borderColor: "divider",
                  bgcolor: "background.paper",
                  color: "text.primary",
                }}
              >
                <Box sx={{ color: "text.secondary", display: "flex" }}>
                  <Icon size={20} strokeWidth={1.5} />
                </Box>
                <Typography
                  variant="caption"
                  noWrap
                  sx={{ maxWidth: "100%", fontSize: "0.72rem" }}
                >
                  {item.label}
                </Typography>
              </ButtonBase>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
