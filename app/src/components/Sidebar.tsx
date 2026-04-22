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
import {
  Settings as SettingsIcon,
  SquareChevronRight as ConsoleIcon,
  Database as DatabaseIcon,
  Plug as DataSourceIcon,
  ArrowLeftRight as FlowsIcon,
  ChartPie as DashboardIcon,
  CircleUserRound as UserIcon,
  MessageCircleMore as ChatIcon,
} from "lucide-react";
import { selectActiveExplorer, useUIStore } from "../store/uiStore";
import { selectTabByKind, useConsoleStore } from "../store/consoleStore";
import { useAuth } from "../contexts/auth-context";
import { startTransition, useState } from "react";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";
import { useConnectorStore } from "../store/connectorStore";
import { useFlowStore } from "../store/flowStore";
import { useChatStore } from "../store/chatStore";
import { useExplorerStore } from "../store/explorerStore";
import { trackEvent, resetIdentity } from "../lib/analytics";

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
  | "settings"
  | "views";

const topNavigationItems: { view: NavigationView; icon: any; label: string }[] =
  [
    { view: "databases", icon: DatabaseIcon, label: "Databases" },
    { view: "consoles", icon: ConsoleIcon, label: "Consoles" },
    { view: "flows", icon: FlowsIcon, label: "Flows" },
    { view: "connectors", icon: DataSourceIcon, label: "Connectors" },
    { view: "dashboards", icon: DashboardIcon, label: "Dashboards" },
  ];

const bottomNavigationItems: {
  view: NavigationView;
  icon: any;
  label: string;
}[] = [{ view: "settings", icon: SettingsIcon, label: "Settings" }];

function Sidebar() {
  // `activeExplorer` is the explorer that's actually visible on the left
  // (null when the pane is collapsed). Use this — not `leftPane`, which is
  // the last-selected view retained across collapse — to decide which icon
  // is highlighted, so collapsing the pane clears the highlight.
  const activeExplorer = useUIStore(selectActiveExplorer);
  const leftPane = useUIStore(state => state.leftPane);
  const leftPaneOpen = useUIStore(state => state.leftPaneOpen);
  const rightPaneOpen = useUIStore(state => state.rightPaneOpen);
  const setLeftPane = useUIStore(state => state.setLeftPane);
  const openLeftPane = useUIStore(state => state.openLeftPane);
  const openRightPane = useUIStore(state => state.openRightPane);
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

  const preloadDashboardsExplorer = () => {
    void import("./DashboardsExplorer");
  };

  const handleLogout = async () => {
    handleUserMenuClose();
    try {
      // Track logout event
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

  const handleNavigation = (view: NavigationView) => {
    // Update the left pane only for views that the store recognises.
    if (
      view === "databases" ||
      view === "consoles" ||
      view === "connectors" ||
      view === "flows" ||
      view === "dashboards"
    ) {
      startTransition(() => {
        setLeftPane(
          view as
            | "databases"
            | "consoles"
            | "connectors"
            | "flows"
            | "dashboards",
        );

        if (!leftPaneOpen) {
          openLeftPane();
        }
      });
    }

    // Only certain views should automatically open (or focus) a tab in the editor.
    // Currently we want settings to open a tab, but data sources should just switch the left pane.
    if (view === "settings") {
      const { openTab, setActiveTab } = useConsoleStore.getState();

      const existing = selectTabByKind(
        view === "settings" ? "settings" : "connectors",
      )(useConsoleStore.getState());
      if (existing) {
        setActiveTab(existing.id);
      } else {
        const id = openTab({
          title: view === "settings" ? "Settings" : "Connectors",
          content: "", // Will be replaced with actual forms later
          kind: view === "settings" ? "settings" : "connectors",
        });
        setActiveTab(id);
      }
    }
  };

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

            return (
              <Tooltip key={item.view} title={item.label} placement="right">
                <NavButton
                  isActive={isActive}
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
          {/* User Menu */}
          <Tooltip title="User Menu" placement="right">
            <NavButton onClick={handleUserMenuOpen}>
              <UserIcon strokeWidth={1.5} />
            </NavButton>
          </Tooltip>

          {/* Settings */}
          {bottomNavigationItems.map(item => {
            const Icon = item.icon;
            // Settings opens as an editor tab, not a left-pane explorer, so
            // it tracks `leftPane` (set to "settings" from the /settings URL)
            // rather than `activeExplorer`.
            const isActive = leftPane === item.view;

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
        </Box>
      </Box>
    </Box>
  );
}

export default Sidebar;
