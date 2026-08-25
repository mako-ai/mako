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
import { CHAT_ICON as ChatIcon, EXPLORER_ICONS } from "../lib/entity-icons";
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
import { useAppsV2Store } from "../store/appsV2Store";
import { useWorkspace } from "../contexts/workspace-context";
import { trackEvent, resetIdentity } from "../lib/analytics";
import { useIsMobile } from "../hooks/useIsMobile";

const NavButton = styled(Button, {
  shouldForwardProp: prop => prop !== "isActive",
})<{ isActive?: boolean }>(({ theme, isActive }) => ({
  minWidth: 40,
  width: 40,
  height: 40,
  padding: 0,
  borderRadius: 8,
  backgroundColor: isActive ? theme.palette.action.selected : "transparent",
  color: isActive ? theme.palette.text.primary : theme.palette.text.secondary,
  "&:hover": {
    backgroundColor: isActive
      ? theme.palette.action.selected
      : theme.palette.action.hover,
  },
  transition: "all 0.2s ease",
}));

// Views that can appear in the sidebar navigation. Extends the core AppView
// union with additional sidebar-specific entries that don't directly map to
// a left-pane view managed by the app store.
type NavigationView =
  | "databases"
  | "consoles"
  | "connectors"
  | "flows"
  | "dashboards"
  | "apps"
  | "notebooks"
  | "apps-v2"
  | "dbt"
  | "source-control"
  | "settings"
  | "views";

const topNavigationItems: {
  view: NavigationView;
  icon: any;
  label: string;
}[] = [
  { view: "databases", icon: EXPLORER_ICONS.databases, label: "Databases" },
  // The workspace repository, VS Code style — second in the rail, the same
  // neighbourhood VS Code keeps its SCM icon in.
  {
    view: "source-control",
    icon: EXPLORER_ICONS["source-control"],
    label: "Source Control",
  },
  { view: "consoles", icon: EXPLORER_ICONS.consoles, label: "Consoles" },
  { view: "flows", icon: EXPLORER_ICONS.flows, label: "Flows" },
  { view: "dbt", icon: EXPLORER_ICONS.dbt, label: "Transforms" },
  { view: "connectors", icon: EXPLORER_ICONS.connectors, label: "Connectors" },
  { view: "dashboards", icon: EXPLORER_ICONS.dashboards, label: "Dashboards" },
  { view: "apps", icon: EXPLORER_ICONS.apps, label: "Apps" },
  { view: "notebooks", icon: EXPLORER_ICONS.notebooks, label: "Notebooks" },
  // Apps v2 (git-backed, experimental) — shown only when the server flag is
  // on (useAppsV2Visible probes /apps-v2/status-probe per workspace).
  { view: "apps-v2", icon: EXPLORER_ICONS["apps-v2"], label: "Apps v2" },
];

/**
 * Probe + report whether the Apps v2 rail entry should be visible. Both the
 * desktop rail and the mobile drawer nav filter on this so v1 and v2 can run
 * side by side while v2 is rolled out.
 */
function useAppsV2Visible(): boolean {
  const { currentWorkspace } = useWorkspace();
  const enabled = useAppsV2Store(state => state.enabled);
  const probeEnabled = useAppsV2Store(state => state.probeEnabled);
  useEffect(() => {
    if (currentWorkspace?.id && enabled === undefined) {
      void probeEnabled(currentWorkspace.id);
    }
  }, [currentWorkspace?.id, enabled, probeEnabled]);
  return enabled === true;
}

const bottomNavigationItems: {
  view: NavigationView;
  icon: any;
  label: string;
}[] = [{ view: "settings", icon: EXPLORER_ICONS.settings, label: "Settings" }];

const preloadDashboardsExplorer = () => {
  void import("./DashboardsExplorer");
};

/**
 * Avatar button + dropdown (workspace switcher + sign out). Shared between the
 * desktop rail and the mobile AppBar / explorer drawer so logout and workspace
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

/**
 * Horizontal explorer switcher for the mobile drawer header. Reuses the same
 * nav item definitions as the desktop rail and switches which explorer the
 * drawer body (App.tsx `renderLeftPane`) shows. The drawer stays open so the
 * user can browse explorers; selecting a tree node closes it (handled in
 * App.tsx).
 */
export function SidebarMobileExplorerNav() {
  const activeExplorer = useUIStore(selectActiveExplorer);
  const setLeftPane = useUIStore(state => state.setLeftPane);
  const openLeftPane = useUIStore(state => state.openLeftPane);
  const appsV2Visible = useAppsV2Visible();

  const items = [...topNavigationItems, ...bottomNavigationItems].filter(
    item =>
      (item.view !== "apps-v2" && item.view !== "source-control") ||
      appsV2Visible,
  );

  return (
    <Box
      sx={{
        display: "grid",
        // Wrap every destination into an even grid so nothing scrolls off
        // the right edge or gets clipped mid-label on a phone.
        gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))",
        gap: 0.25,
        px: 0.5,
        py: 0.25,
      }}
    >
      {items.map(item => {
        const Icon = item.icon;
        const isActive = activeExplorer === item.view;
        return (
          <Button
            key={item.view}
            onClick={() => {
              startTransition(() => {
                setLeftPane(item.view as Exclude<NavigationView, "views">);
                openLeftPane();
              });
            }}
            onTouchStart={
              item.view === "dashboards" ? preloadDashboardsExplorer : undefined
            }
            sx={{
              flexDirection: "column",
              alignItems: "center",
              gap: 0.25,
              minWidth: 0,
              width: "100%",
              px: 0.5,
              py: 0.5,
              borderRadius: 1.5,
              color: isActive ? "primary.main" : "text.secondary",
              backgroundColor: isActive ? "action.selected" : "transparent",
            }}
          >
            <Icon size={18} strokeWidth={1.5} />
            <Typography
              variant="caption"
              sx={{
                fontSize: "0.6rem",
                lineHeight: 1.1,
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item.label}
            </Typography>
          </Button>
        );
      })}
    </Box>
  );
}

function Sidebar() {
  // `activeExplorer` is the explorer that's actually visible on the left
  // (null when the pane is collapsed). Use this — not `leftPane`, which is
  // the last-selected view retained across collapse — to decide which icon
  // is highlighted, so collapsing the pane clears the highlight.
  const activeExplorer = useUIStore(selectActiveExplorer);
  const leftPaneOpen = useUIStore(state => state.leftPaneOpen);
  const rightPaneOpen = useUIStore(state => state.rightPaneOpen);
  const setLeftPane = useUIStore(state => state.setLeftPane);
  const openLeftPane = useUIStore(state => state.openLeftPane);
  const openRightPane = useUIStore(state => state.openRightPane);
  const isMobile = useIsMobile();
  const appsV2Visible = useAppsV2Visible();

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
  // and explorer Drawer rendered by App.tsx (which reuse the helpers above).
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
          {topNavigationItems
            .filter(
              item =>
                (item.view !== "apps-v2" && item.view !== "source-control") ||
                appsV2Visible,
            )
            .map(item => {
              const Icon = item.icon;
              const isActive = activeExplorer === item.view;

              return (
                <Tooltip key={item.view} title={item.label} placement="right">
                  <NavButton
                    isActive={isActive}
                    onClick={() =>
                      handleNavigation(item.view as NavigationView)
                    }
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

            return (
              <Tooltip key={item.view} title={item.label} placement="right">
                <NavButton
                  isActive={isActive}
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
