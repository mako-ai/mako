import { useEffect, useRef } from "react";
import { useUIStore } from "../store/uiStore";
import {
  selectTabBySettingsSection,
  useConsoleStore,
} from "../store/consoleStore";
import { useDashboardStore } from "../store/dashboardStore";
import { useAppStore } from "../store/appStore";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import { SECTION_LABELS, isSettingsSection } from "../pages/settings/sections";
import {
  focusAppBindingTab,
  focusAppFileTab,
  focusAppTab,
} from "../app-runtime/shell";
import { focusDashboardDataSourceTab } from "../dashboard-runtime/shell";

/** Encode a path that may contain slashes, keeping the slashes readable. */
function encodePathSegments(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

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
      case "dashboard-data-source": {
        const dashboardId = tab.metadata?.dashboardId as string | undefined;
        const dataSourceId = tab.metadata?.dataSourceId as string | undefined;
        return dashboardId && dataSourceId
          ? `/d/${dashboardId}/data/${dataSourceId}`
          : null;
      }
      case "table-data": {
        const schema = tab.metadata?.schema as string | undefined;
        const table = tab.metadata?.table as string | undefined;
        if (!tab.connectionId || !table) return null;
        const params = new URLSearchParams();
        if (tab.databaseName) params.set("db", tab.databaseName);
        if (tab.databaseId) params.set("dbid", tab.databaseId);
        const query = params.toString();
        return (
          `/t/${tab.connectionId}/${encodeURIComponent(schema || "public")}` +
          `/${encodeURIComponent(table)}${query ? `?${query}` : ""}`
        );
      }
      case "app": {
        const appId = tab.metadata?.appId as string | undefined;
        return appId ? `/a/${appId}` : null;
      }
      case "app-file": {
        const appId = tab.metadata?.appId as string | undefined;
        const path = tab.metadata?.path as string | undefined;
        return appId && path
          ? `/a/${appId}/file/${encodePathSegments(path)}`
          : null;
      }
      case "app-binding": {
        const appId = tab.metadata?.appId as string | undefined;
        const bindingId = tab.metadata?.bindingId as string | undefined;
        return appId && bindingId ? `/a/${appId}/data/${bindingId}` : null;
      }
      case "plan": {
        const chatId = tab.metadata?.chatId as string | undefined;
        return chatId ? `/p/${chatId}` : null;
      }
      case "settings":
        return tab.settingsSection
          ? `/settings/${tab.settingsSection}`
          : "/settings";
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

    // Regex patterns for routes (most specific first)
    const consoleMatch = path.match(/^\/c\/([a-zA-Z0-9-]+)/);
    const connectorMatch = path.match(/^\/cx\/([a-zA-Z0-9-]+)/);
    const flowMatch = path.match(/^\/f\/([a-zA-Z0-9-]+)/);
    const dashboardDataSourceMatch = path.match(
      /^\/d\/([a-zA-Z0-9-]+)\/data\/([a-zA-Z0-9-]+)/,
    );
    const dashboardMatch = path.match(/^\/d\/([a-zA-Z0-9-]+)\/?$/);
    const tableMatch = path.match(
      /^\/t\/([a-zA-Z0-9-]+)\/([^/]+)\/([^/]+)\/?$/,
    );
    const appFileMatch = path.match(/^\/a\/([a-zA-Z0-9-]+)\/file\/(.+)$/);
    const appBindingMatch = path.match(
      /^\/a\/([a-zA-Z0-9-]+)\/data\/([a-zA-Z0-9-]+)/,
    );
    const appMatch = path.match(/^\/a\/([a-zA-Z0-9-]+)\/?$/);
    const planMatch = path.match(/^\/p\/([a-zA-Z0-9-]+)/);
    const settingsSectionMatch = path.match(/^\/settings\/([a-z-]+)$/);
    const settingsMatch = path.match(/^\/settings\/?$/);

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
    } else if (dashboardDataSourceMatch) {
      // /d/:dashboardId/data/:dataSourceId
      const dashboardId = dashboardDataSourceMatch[1];
      const dataSourceId = dashboardDataSourceMatch[2];
      setLeftPane("dashboards");

      // Placeholder title — DashboardDataSourceEditor syncs the real name
      // onto the tab once the dashboard loads.
      focusDashboardDataSourceTab(dashboardId, dataSourceId, "Data source");
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
    } else if (tableMatch) {
      // /t/:connectionId/:schema/:table (+ ?db=<name>&dbid=<id>)
      const connectionId = tableMatch[1];
      const schema = decodeURIComponent(tableMatch[2]);
      const table = decodeURIComponent(tableMatch[3]);
      const params = new URLSearchParams(window.location.search);
      const databaseName = params.get("db") || undefined;
      const databaseId = params.get("dbid") || undefined;
      setLeftPane("databases");

      const existingTab = Object.values(useConsoleStore.getState().tabs).find(
        t =>
          t.kind === "table-data" &&
          t.connectionId === connectionId &&
          t.metadata?.schema === schema &&
          t.metadata?.table === table &&
          (t.databaseName || undefined) === databaseName,
      );

      if (existingTab) {
        setActiveTab(existingTab.id);
      } else {
        const id = openTab({
          title: table,
          content: "",
          kind: "table-data",
          connectionId,
          databaseId,
          databaseName,
          metadata: { schema, table },
        });
        setActiveTab(id);
      }
    } else if (appFileMatch) {
      // /a/:appId/file/:path
      const appId = appFileMatch[1];
      const filePath = appFileMatch[2]
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent)
        .join("/");
      setLeftPane("apps");
      focusAppFileTab(appId, filePath);
    } else if (appBindingMatch) {
      // /a/:appId/data/:bindingId
      const appId = appBindingMatch[1];
      const bindingId = appBindingMatch[2];
      setLeftPane("apps");

      // Placeholder title — AppBindingEditor syncs the real name onto the
      // tab once the app loads.
      focusAppBindingTab(appId, bindingId, "Data source");
    } else if (appMatch) {
      // /a/:appId
      const appId = appMatch[1];
      setLeftPane("apps");

      const existingTab = Object.values(useConsoleStore.getState().tabs).find(
        t => t.kind === "app" && t.metadata?.appId === appId,
      );

      if (existingTab) {
        setActiveTab(existingTab.id);
      } else {
        // Fetch the app to get its title, then open the tab
        useAppStore
          .getState()
          .fetchApp(currentWorkspace.id, appId)
          .then(app => {
            focusAppTab(appId, app?.title || "App");
          });
      }
    } else if (planMatch) {
      // /p/:chatId — plans only exist within a chat session, so we can only
      // focus a plan tab that is already present in this browser's state.
      const chatId = planMatch[1];
      const existingTab = Object.values(useConsoleStore.getState().tabs).find(
        t => t.kind === "plan" && t.metadata?.chatId === chatId,
      );
      if (existingTab) {
        setActiveTab(existingTab.id);
      }
    } else if (settingsSectionMatch) {
      // /settings/:section — open the explorer *and* focus the section's tab.
      const section = settingsSectionMatch[1];
      setLeftPane("settings");

      if (isSettingsSection(section)) {
        const existingTab = selectTabBySettingsSection(section)(
          useConsoleStore.getState(),
        );
        if (existingTab) {
          setActiveTab(existingTab.id);
        } else {
          const id = openTab({
            title: SECTION_LABELS[section],
            content: "",
            kind: "settings",
            settingsSection: section,
          });
          setActiveTab(id);
        }
      }
    } else if (settingsMatch) {
      // /settings — just show the explorer panel. No tab is forced open;
      // the user picks a section from the panel.
      setLeftPane("settings");
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

    // Compare against pathname + search: table URLs carry the database in a
    // query string, and switching to a tab without one must clear it.
    const currentPath = window.location.pathname + window.location.search;
    if (currentPath !== newPath) {
      window.history.replaceState(null, "", newPath);
    }
  }, [activeTabPath, activeView, user]);

  return null; // This component renders nothing
}
