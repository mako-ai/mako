import { useEffect, useRef } from "react";
import { useUIStore } from "../store/uiStore";
import { selectTabByKind, useConsoleStore } from "../store/consoleStore";
import { useDashboardStore } from "../store/dashboardStore";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";

/**
 * UrlSync component
 *
 * Responsibilities:
 * 1. Hydration (One-time on mount):
 *    Parses the initial URL and dispatches actions to restore state (open tabs, set view).
 *    This allows deep linking to specific resources.
 *
 * 2. Synchronization (Continuous):
 *    Listens to store changes (active tab, active view) and updates the URL silently
 *    using window.history.replaceState(). This prevents React Router from triggering
 *    unnecessary re-renders.
 */
export function UrlSync() {
  const { currentWorkspace } = useWorkspace();
  const { user } = useAuth();
  const loadConsole = useConsoleStore(state => state.loadConsole);
  const openTab = useConsoleStore(state => state.openTab);
  const setActiveTab = useConsoleStore(state => state.setActiveTab);

  // Derive the URL path for the currently active tab as a primitive string.
  // Returning a primitive means zustand's default Object.is comparison skips
  // re-renders on unrelated state changes (e.g. keystrokes updating tab
  // content), so this component only re-renders when the URL actually needs
  // to change.
  const activeTabPath = useConsoleStore(state => {
    const id = state.activeTabId;
    if (!id) return null;
    const tab = state.tabs[id];
    if (!tab) return null;
    switch (tab.kind) {
      case undefined:
      case "console":
        return `/c/${id}`;
      case "connectors":
        return typeof tab.content === "string" && tab.content
          ? `/cx/${tab.content}`
          : null;
      case "flow-editor":
        return tab.metadata?.flowId ? `/f/${tab.metadata.flowId}` : null;
      case "dashboard":
        return tab.metadata?.dashboardId
          ? `/d/${tab.metadata.dashboardId}`
          : null;
      case "settings":
        return "/settings";
      default:
        return null;
    }
  });

  const activeView = useUIStore(state => state.leftPane);
  const setLeftPane = useUIStore(state => state.setLeftPane);

  // Ref to track if hydration has occurred to prevent double-hydration
  const isHydrated = useRef(false);

  // Reset hydration state when user logs out
  useEffect(() => {
    if (!user) {
      isHydrated.current = false;
    }
  }, [user]);

  // --- Hydration: Restore state from URL on mount ---
  useEffect(() => {
    // Don't hydrate if not authenticated or no workspace
    if (isHydrated.current || !currentWorkspace || !user) return;

    const path = window.location.pathname;

    // Regex patterns for routes
    const consoleMatch = path.match(/^\/c\/([a-zA-Z0-9-]+)/);
    const connectorMatch = path.match(/^\/cx\/([a-zA-Z0-9-]+)/);
    const flowMatch = path.match(/^\/f\/([a-zA-Z0-9-]+)/);
    const dashboardMatch = path.match(/^\/d\/([a-zA-Z0-9-]+)/);
    const settingsMatch = path.match(/^\/settings/);

    if (consoleMatch) {
      // /c/:consoleId
      const consoleId = consoleMatch[1];
      setLeftPane("consoles");

      // If the console isn't already open, try to load it
      // loadConsole handles checking existence internally
      loadConsole(currentWorkspace.id, consoleId);
    } else if (connectorMatch) {
      // /cx/:connectorId
      const connectorId = connectorMatch[1];
      setLeftPane("connectors");

      // Check if we already have a tab for this connector
      const existingTab = Object.values(useConsoleStore.getState().tabs).find(
        t => t.kind === "connectors" && t.content === connectorId,
      );

      if (existingTab) {
        setActiveTab(existingTab.id);
      } else {
        // Create a new tab for this connector
        // We don't have the name yet, it will be fetched by ConnectorTab
        const id = openTab({
          title: "Connector", // Will be updated when entity loads
          content: connectorId,
          kind: "connectors",
        });
        setActiveTab(id);
      }
    } else if (flowMatch) {
      // /f/:flowId
      const flowId = flowMatch[1];
      setLeftPane("flows");

      // Check for existing tab
      const existingTab = Object.values(useConsoleStore.getState().tabs).find(
        t => t.kind === "flow-editor" && t.metadata?.flowId === flowId,
      );

      if (existingTab) {
        setActiveTab(existingTab.id);
      } else {
        const id = openTab({
          title: "Flow",
          content: "",
          kind: "flow-editor",
          metadata: { flowId },
        });
        setActiveTab(id);
      }
    } else if (dashboardMatch) {
      // /d/:dashboardId
      const dashboardId = dashboardMatch[1];
      setLeftPane("dashboards");

      const existingTab = Object.values(useConsoleStore.getState().tabs).find(
        t => t.kind === "dashboard" && t.metadata?.dashboardId === dashboardId,
      );

      if (existingTab) {
        setActiveTab(existingTab.id);
      } else {
        // Fetch dashboards to get the title, then open tab
        useDashboardStore
          .getState()
          .fetchDashboards(currentWorkspace.id)
          .then(dashboards => {
            const dashboard = dashboards.find(d => d._id === dashboardId);
            const id = openTab({
              title: dashboard?.title || "Dashboard",
              content: "",
              kind: "dashboard",
              metadata: { dashboardId },
            });
            setActiveTab(id);
          });
      }
    } else if (settingsMatch) {
      // /settings
      setLeftPane("settings");

      // Open settings tab if not open
      const existingTab = selectTabByKind("settings")(
        useConsoleStore.getState(),
      );
      if (existingTab) {
        setActiveTab(existingTab.id);
      } else {
        const id = openTab({
          title: "Settings",
          content: "",
          kind: "settings",
        });
        setActiveTab(id);
      }
    }

    isHydrated.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace, user]); // Only run when workspace is ready and user is authenticated

  // --- Synchronization: Update URL when state changes ---
  //
  // The URL follows the active tab (the document open in the editor), not the
  // left-pane view. That way switching between tabs — or opening the app with
  // a persisted active tab while the left pane is on a different view — still
  // produces a shareable /c/:id (or /d/:id, /f/:id, /cx/:id) URL.
  //
  // `activeTabPath` is a primitive string derived inside the zustand selector,
  // so this effect only fires when the URL it would produce actually changes
  // (not on every keystroke in the editor).
  useEffect(() => {
    // Don't sync until after hydration or if user is not authenticated
    if (!isHydrated.current || !user) return;

    let newPath = activeTabPath ?? "/";

    // View-only fallback: if no active tab owns the URL but the user is on
    // the settings view, still reflect that so /settings is shareable.
    if (newPath === "/" && activeView === "settings") {
      newPath = "/settings";
    }

    if (window.location.pathname !== newPath) {
      window.history.replaceState(null, "", newPath);
    }
  }, [activeTabPath, activeView, user]);

  return null; // This component renders nothing
}
