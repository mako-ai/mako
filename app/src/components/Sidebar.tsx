import {
  Box,
  Button,
  Tooltip,
  styled,
  Menu,
  MenuItem,
  Typography,
  Divider,
} from "@mui/material";
import { Logout as LogoutIcon } from "@mui/icons-material";
import { CircleUserRound as UserIcon } from "lucide-react";
import { CHAT_ICON as ChatIcon } from "../lib/entity-icons";
import { selectActiveExplorer, useUIStore } from "../store/uiStore";
import { useConsoleStore } from "../store/consoleStore";
import { useAuth } from "../contexts/auth-context";
import { startTransition, useEffect, useState } from "react";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";
import { useConnectorStore } from "../store/connectorStore";
import { useFlowStore } from "../store/flowStore";
import { useChatStore } from "../store/chatStore";
import { useExplorerStore } from "../store/explorerStore";
import { useRepoStore } from "../store/repoStore";
import { useWorkspace } from "../contexts/workspace-context";
import { trackEvent, resetIdentity } from "../lib/analytics";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  topNavigationItems,
  bottomNavigationItems,
  type NavigationView,
} from "../lib/explorer-nav";
import { tabRevealTarget } from "../lib/explorer-reveal";

/**
 * The rail answers TWO questions, and conflating them is confusing.
 *
 * `isActive` is "this explorer's panel is the one on screen". `ownsActiveTab`
 * is "the tab you are looking at lives in here". They are independent by
 * design — browsing the Databases tree while editing a console is a real
 * workflow, and a reload deliberately restores the panel you had rather than
 * the one the URL implies (see UrlSync's isReload note).
 *
 * With only the selected-background state, a rail showing Settings while the
 * address bar said /apps/ubiflow read as "Settings is the active app". So the
 * two facts now look different: selected background for the open panel, brand
 * colour for the explorer holding the open tab.
 */
const NavButton = styled(Button, {
  shouldForwardProp: prop => prop !== "isActive" && prop !== "ownsActiveTab",
})<{ isActive?: boolean; ownsActiveTab?: boolean }>(
  ({ theme, isActive, ownsActiveTab }) => ({
    minWidth: 40,
    width: 40,
    height: 40,
    padding: 0,
    borderRadius: 8,
    backgroundColor: isActive ? theme.palette.action.selected : "transparent",
    color: isActive
      ? theme.palette.text.primary
      : ownsActiveTab
        ? theme.palette.primary.main
        : theme.palette.text.secondary,
    "&:hover": {
      backgroundColor: isActive
        ? theme.palette.action.selected
        : theme.palette.action.hover,
    },
    transition: "all 0.2s ease",
  }),
);

// Views that can appear in the sidebar navigation. Extends the core AppView
// union with additional sidebar-specific entries that don't directly map to
// a left-pane view managed by the app store.

/**
 * Is the workspace checkout dirty? VS Code's SCM badge, reduced to a dot.
 *
 * Status is repo-wide (any app id reaches it), lives in the store so a
 * commit made in the Source Control panel clears the dot instantly, and is
 * refreshed here on a slow poll so the dot is honest even while no panel
 * that fetches status is open. Reads come from the box when it is running
 * and from the last commit when it is not — the poll never boots a machine.
 */
function useRepoDirty(): boolean {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const fetchStatus = useRepoStore(state => state.fetchStatus);
  const dirty = useRepoStore(state =>
    workspaceId
      ? (state.statusByWorkspace[workspaceId]?.repoChanges?.length ?? 0) > 0
      : false,
  );
  useEffect(() => {
    if (!workspaceId) return;
    void fetchStatus(workspaceId);
    const timer = setInterval(() => void fetchStatus(workspaceId), 30_000);
    return () => clearInterval(timer);
  }, [workspaceId, fetchStatus]);
  return dirty;
}

const preloadDashboardsExplorer = () => {
  void import("./DashboardsExplorer");
};

/**
 * Avatar button + dropdown (workspace switcher + sign out). Shared between the
 * desktop rail and the mobile Browse pane header so logout and workspace
 * switching behave identically everywhere.
 */
export function SidebarUserMenu({
  tooltipPlacement = "right",
}: {
  tooltipPlacement?: "right" | "bottom" | "top" | "left";
}) {
  const { user, logout } = useAuth();
  const [userMenuAnchorEl, setUserMenuAnchorEl] = useState<null | HTMLElement>(
    null,
  );
  const isUserMenuOpen = Boolean(userMenuAnchorEl);

  const handleUserMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setUserMenuAnchorEl(event.currentTarget);
  };

  const handleUserMenuClose = () => {
    setUserMenuAnchorEl(null);
  };

  const handleLogout = async () => {
    handleUserMenuClose();
    try {
      trackEvent("logout");
      resetIdentity();

      // Clear all local storage to prevent data leaks
      localStorage.clear();

      // Clear all store data from memory before logout
      useConnectorCatalogStore.getState().clearTypes();
      useConnectorStore.getState().clearDrafts();
      useConsoleStore.getState().clearAllConsoles();

      // Full store resets
      useUIStore.getState().reset();
      useExplorerStore.getState().reset();
      useChatStore.getState().reset();
      useFlowStore.getState().reset();

      await logout();

      // Use full page reload to ensure clean state and avoid race conditions with 401 handlers
      window.location.href = "/login";
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  return (
    <>
      <Tooltip title="User Menu" placement={tooltipPlacement}>
        <NavButton onClick={handleUserMenuOpen}>
          <UserIcon strokeWidth={1.5} />
        </NavButton>
      </Tooltip>

      <Menu
        anchorEl={userMenuAnchorEl}
        open={isUserMenuOpen}
        onClose={handleUserMenuClose}
        anchorOrigin={{
          vertical: "top",
          horizontal: "right",
        }}
        transformOrigin={{
          vertical: "bottom",
          horizontal: "right",
        }}
        PaperProps={{
          sx: {
            minWidth: 300,
          },
        }}
      >
        {/* Workspace Switcher in User Menu */}
        <Box sx={{ px: 1.5, py: 1.25, minWidth: 0 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mb: 0.75, display: "block", letterSpacing: 0.2 }}
          >
            Workspace
          </Typography>
          <WorkspaceSwitcher />
        </Box>
        <Divider />

        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Signed in as
          </Typography>
          <Typography variant="body2" fontWeight="medium">
            {user?.email}
          </Typography>
        </Box>
        <Divider />
        <MenuItem onClick={handleLogout}>
          <LogoutIcon sx={{ mr: 1, fontSize: 20 }} />
          Sign out
        </MenuItem>
      </Menu>
    </>
  );
}

function Sidebar() {
  // `activeExplorer` is the explorer that's actually visible on the left
  // (null when the pane is collapsed). Use this — not `leftPane`, which is
  // the last-selected view retained across collapse — to decide which icon
  // is highlighted, so collapsing the pane clears the highlight.
  const activeExplorer = useUIStore(selectActiveExplorer);
  // Which explorer holds the tab currently in the editor. Returns a primitive
  // so this only re-renders when the answer actually changes, not on every
  // keystroke in the tab. Tabs with no sidebar home (settings, plans) map to
  // null and mark nothing.
  const activeTabExplorer = useConsoleStore(state => {
    const id = state.activeTabId;
    const tab = id ? state.tabs[id] : null;
    return tabRevealTarget(tab)?.explorer ?? null;
  });
  const leftPaneOpen = useUIStore(state => state.leftPaneOpen);
  const rightPaneOpen = useUIStore(state => state.rightPaneOpen);
  const setLeftPane = useUIStore(state => state.setLeftPane);
  const openLeftPane = useUIStore(state => state.openLeftPane);
  const openRightPane = useUIStore(state => state.openRightPane);
  const isMobile = useIsMobile();
  const repoDirty = useRepoDirty();

  const handleNavigation = (view: NavigationView) => {
    // Settings now behaves like any other explorer: clicking the cog opens
    // the SettingsExplorer panel in the left rail. A tab is only opened once
    // the user picks a specific sub-section from that panel.
    if (view !== "views") {
      startTransition(() => {
        setLeftPane(view);

        if (!leftPaneOpen) {
          openLeftPane();
        }
      });
    }
  };

  // On mobile the 52px rail is hidden; navigation moves to the BottomNavigation
  // and Browse pane rendered by App.tsx (which reuse the helpers above).
  if (isMobile) return null;

  return (
    <Box
      sx={{
        width: 52,
        height: "100vh",
        borderRight: "1px solid",
        borderColor: "divider",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {/* Navigation Items */}
      <Box
        sx={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
        }}
      >
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            p: 0.5,
            gap: 0.5,
            alignItems: "center",
          }}
        >
          {topNavigationItems.map(item => {
            const Icon = item.icon;
            const isActive = activeExplorer === item.view;
            const ownsActiveTab = activeTabExplorer === item.view;

            return (
              <Tooltip
                key={item.view}
                title={
                  ownsActiveTab && !isActive
                    ? `${item.label} — holds the open tab`
                    : item.label
                }
                placement="right"
              >
                <NavButton
                  isActive={isActive}
                  ownsActiveTab={ownsActiveTab}
                  // Stable hooks for tests: the two states are otherwise only
                  // visible as emotion-generated colours.
                  data-view={item.view}
                  data-open-explorer={isActive ? "true" : "false"}
                  data-owns-active-tab={ownsActiveTab ? "true" : "false"}
                  onClick={() => handleNavigation(item.view as NavigationView)}
                  onMouseEnter={
                    item.view === "dashboards"
                      ? preloadDashboardsExplorer
                      : undefined
                  }
                  onFocus={
                    item.view === "dashboards"
                      ? preloadDashboardsExplorer
                      : undefined
                  }
                  onTouchStart={
                    item.view === "dashboards"
                      ? preloadDashboardsExplorer
                      : undefined
                  }
                >
                  <Icon size={24} strokeWidth={1.5} />
                  {item.view === "source-control" && repoDirty && (
                    <Box
                      component="span"
                      aria-label="Uncommitted changes"
                      sx={{
                        position: "absolute",
                        top: 6,
                        right: 6,
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        bgcolor: "error.main",
                        // Ring in the rail background so the dot reads as
                        // sitting ON the icon rather than touching it.
                        boxShadow: theme =>
                          `0 0 0 2px ${theme.palette.background.paper}`,
                        pointerEvents: "none",
                      }}
                    />
                  )}
                </NavButton>
              </Tooltip>
            );
          })}

          {!rightPaneOpen && (
            <Tooltip title="Open Chat" placement="right">
              <NavButton onClick={openRightPane}>
                <ChatIcon size={24} strokeWidth={1.5} />
              </NavButton>
            </Tooltip>
          )}
        </Box>

        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            p: 0.25,
            gap: 0.25,
            alignItems: "center",
          }}
        >
          {/* User Menu (avatar + workspace switcher + sign out) */}
          <SidebarUserMenu />

          {/* Settings */}
          {bottomNavigationItems.map(item => {
            const Icon = item.icon;
            // Settings is now a real explorer — track `activeExplorer` like
            // every other rail so collapsing the pane clears the highlight.
            const isActive = activeExplorer === item.view;
            const ownsActiveTab = activeTabExplorer === item.view;

            return (
              <Tooltip
                key={item.view}
                title={
                  ownsActiveTab && !isActive
                    ? `${item.label} — holds the open tab`
                    : item.label
                }
                placement="right"
              >
                <NavButton
                  isActive={isActive}
                  ownsActiveTab={ownsActiveTab}
                  // Stable hooks for tests: the two states are otherwise only
                  // visible as emotion-generated colours.
                  data-view={item.view}
                  data-open-explorer={isActive ? "true" : "false"}
                  data-owns-active-tab={ownsActiveTab ? "true" : "false"}
                  onClick={() => handleNavigation(item.view as NavigationView)}
                >
                  <Icon strokeWidth={1.5} />
                </NavButton>
              </Tooltip>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

export default Sidebar;
