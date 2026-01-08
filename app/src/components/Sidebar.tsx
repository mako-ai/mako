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
  CircleUserRound as UserIcon,
} from "lucide-react";
import { useAppStore, AppView } from "../store";
import { useConsoleStore } from "../store/consoleStore";
import { useAuth } from "../contexts/auth-context";
import { useState } from "react";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";
import { useConnectorStore } from "../store/connectorStore";
import { useFlowStore } from "../store/flowStore";
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
type NavigationView = AppView | "views" | "settings" | "flows";

const topNavigationItems: { view: NavigationView; icon: any; label: string }[] =
  [
    { view: "databases", icon: DatabaseIcon, label: "Databases" },
    { view: "consoles", icon: ConsoleIcon, label: "Consoles" },
    { view: "flows", icon: FlowsIcon, label: "Flows" },
    { view: "connectors", icon: DataSourceIcon, label: "Connectors" },
  ];

const bottomNavigationItems: {
  view: NavigationView;
  icon: any;
  label: string;
}[] = [{ view: "settings", icon: SettingsIcon, label: "Settings" }];

function Sidebar() {
  const { activeView, setActiveView } = useAppStore();
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
      // Track logout event
      trackEvent("logout");
      resetIdentity();

      // Clear all local storage to prevent data leaks
      localStorage.clear();

      // Clear all store data from memory before logout
      useConnectorCatalogStore.getState().clearTypes();
      useConnectorStore.getState().clearDrafts();
      useConsoleStore.getState().clearAllConsoles(); // This triggers actions in appStore, but reset() below is more comprehensive

      // Full store resets
      useAppStore.getState().reset();
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
      view === "flows"
    ) {
      setActiveView(view as AppView);
    }

    // Only certain views should automatically open (or focus) a tab in the editor.
    // Currently we want settings to open a tab, but data sources should just switch the left pane.
    if (view === "settings") {
      const { findTabByKind, addConsoleTab, setActiveConsole } =
        useConsoleStore.getState();

      const existing = findTabByKind(
        view === "settings" ? "settings" : "connectors",
      );
      if (existing) {
        setActiveConsole(existing.id);
      } else {
        const id = addConsoleTab({
          title: view === "settings" ? "Settings" : "Connectors",
          content: "", // Will be replaced with actual forms later
          initialContent: "",
          kind: view === "settings" ? "settings" : "connectors",
        });
        setActiveConsole(id);
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
            const isActive = activeView === item.view;

            return (
              <Tooltip key={item.view} title={item.label} placement="right">
                <NavButton
                  isActive={isActive}
                  onClick={() => handleNavigation(item.view as NavigationView)}
                >
                  <Icon size={24} strokeWidth={1.5} />
                </NavButton>
              </Tooltip>
            );
          })}
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
            const isActive = activeView === item.view;

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
          >
            {/* Workspace Switcher in User Menu */}
            <Box sx={{ px: 2, py: 1, minWidth: 250 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
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
