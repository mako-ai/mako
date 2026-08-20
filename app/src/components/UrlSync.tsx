import { useEffect, useRef } from "react";
import { useUIStore } from "../store/uiStore";
import {
  selectTabBySettingsSection,
  useConsoleStore,
} from "../store/consoleStore";
import { useDashboardStore } from "../store/dashboardStore";
import { useAppStore } from "../store/appStore";
import { useAppsV2Store } from "../store/appsV2Store";
import {
  closeAppsV2TabsFor,
  focusAppsV2FileTab,
  focusAppsV2Tab,
} from "../apps-v2-runtime/shell";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import { SECTION_LABELS, isSettingsSection } from "../pages/settings/sections";
import {
  focusAppBindingTab,
  focusAppFileTab,
  focusAppTab,
} from "../app-runtime/shell";
import {
  focusDbtConsoleTab,
  focusDbtFileTab,
  focusDbtJobTab,
  focusDbtRunsTab,
} from "../dbt-runtime/shell";
import { useDbtStore } from "../store/dbtStore";
import { useMcpStore } from "../store/mcpStore";
import { focusDashboardDataSourceTab } from "../dashboard-runtime/shell";
import { focusNotebookTab } from "../notebook-runtime/shell";
import {
  TAB_DEEP_LINK_PATTERNS,
  decodePathSegments,
  tabUrlPath,
} from "../lib/tab-routing";
import { appLocationFromHostSearch } from "../app-runtime/app-location";

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
    return tabUrlPath(id, tab);
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

  // Capture MCP OAuth callback flags (?oauth_connected / ?oauth_error) into
  // the store before the URL-sync effect below rewrites the address bar and
  // strips them. The MCP settings section consumes the captured outcome.
  useEffect(() => {
    useMcpStore.getState().captureOAuthReturn();
  }, []);

  // --- Hydration: Restore state from URL on mount ---
  useEffect(() => {
    // Don't hydrate if not authenticated or no workspace
    if (isHydrated.current || !currentWorkspace || !user) return;

    const path = window.location.pathname;

    // Route patterns live in lib/tab-routing.ts next to the URL builders so
    // the two directions stay in sync (most specific matched first below).
    const consoleMatch = path.match(TAB_DEEP_LINK_PATTERNS.console);
    const connectorMatch = path.match(TAB_DEEP_LINK_PATTERNS.connectors);
    const flowMatch = path.match(TAB_DEEP_LINK_PATTERNS["flow-editor"]);
    const dashboardDataSourceMatch = path.match(
      TAB_DEEP_LINK_PATTERNS["dashboard-data-source"],
    );
    const dashboardMatch = path.match(TAB_DEEP_LINK_PATTERNS.dashboard);
    const tableMatch = path.match(TAB_DEEP_LINK_PATTERNS["table-data"]);
    const appFileMatch = path.match(TAB_DEEP_LINK_PATTERNS["app-file"]);
    const appBindingMatch = path.match(TAB_DEEP_LINK_PATTERNS["app-binding"]);
    const appMatch = path.match(TAB_DEEP_LINK_PATTERNS.app);
    const appV2FileMatch = path.match(TAB_DEEP_LINK_PATTERNS["app-v2-file"]);
    const appV2Match = path.match(TAB_DEEP_LINK_PATTERNS["app-v2"]);
    const dbtFileMatch = path.match(TAB_DEEP_LINK_PATTERNS["dbt-file"]);
    const dbtJobMatch = path.match(TAB_DEEP_LINK_PATTERNS["dbt-job"]);
    const dbtRunsMatch = path.match(TAB_DEEP_LINK_PATTERNS["dbt-runs"]);
    const dbtConsoleMatch = path.match(TAB_DEEP_LINK_PATTERNS["dbt-console"]);
    const notebookMatch = path.match(TAB_DEEP_LINK_PATTERNS.notebook);
    const planMatch = path.match(TAB_DEEP_LINK_PATTERNS.plan);
    const settingsSectionMatch = path.match(TAB_DEEP_LINK_PATTERNS.settings);
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
      const filePath = decodePathSegments(appFileMatch[2]);
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
      // /a/:appId (+ the running app's own location: readable query params and
      // its pathname carried in the reserved `_path` param).
      const appId = appMatch[1];
      setLeftPane("apps");

      const appLocation = appLocationFromHostSearch(window.location.search);

      const existingTab = Object.values(useConsoleStore.getState().tabs).find(
        t => t.kind === "app" && t.metadata?.appId === appId,
      );

      if (existingTab) {
        focusAppTab(appId, existingTab.title, appLocation);
      } else {
        // Fetch the app to get its title, then open the tab
        useAppStore
          .getState()
          .fetchApp(currentWorkspace.id, appId)
          .then(app => {
            focusAppTab(appId, app?.title || "App", appLocation);
          });
      }
    } else if (appV2FileMatch) {
      // /a2/:appId/file/:path — Apps v2 file editor
      const appId = appV2FileMatch[1];
      const filePath = decodePathSegments(appV2FileMatch[2]);
      setLeftPane("apps-v2");
      void useAppsV2Store
        .getState()
        .fetchApps(currentWorkspace.id)
        .then(() => {
          const app = useAppsV2Store
            .getState()
            .apps.find(a => a.id === appId || a.slug === appId);
          if (!app) {
            closeAppsV2TabsFor(appId);
            window.history.replaceState(null, "", "/");
            return;
          }
          focusAppsV2FileTab(app.id, filePath, app.slug);
        });
    } else if (appV2Match) {
      // /a2/:appId — Apps v2 (git-backed, experimental)
      const appId = appV2Match[1];
      setLeftPane("apps-v2");
      const store = useAppsV2Store.getState();
      void store.fetchApps(currentWorkspace.id).then(() => {
        // The path segment may be a slug (the app's folder in the repo) or a
        // legacy Mongo id. Resolve either; the outgoing sync then rewrites the
        // URL to the slug form, so old links upgrade themselves.
        const app = useAppsV2Store
          .getState()
          .apps.find(a => a.id === appId || a.slug === appId);
        if (!app) {
          // The link points at an app that is gone, or lives in another
          // workspace. Opening a tab anyway rendered the whole workspace view
          // — breadcrumb, terminal, a live Publish button — around nothing,
          // and reloading restored the same dead id, so the page looked
          // permanently stuck. Clear it and fall back to the list instead.
          closeAppsV2TabsFor(appId);
          window.history.replaceState(null, "", "/");
          return;
        }
        focusAppsV2Tab(app.id, app.title, app.slug);
      });
    } else if (dbtFileMatch) {
      // /x/:projectId/file/:path
      const projectId = dbtFileMatch[1];
      const filePath = decodePathSegments(dbtFileMatch[2]);
      setLeftPane("dbt");
      // Helper dedupes against an existing tab and sets the active project.
      focusDbtFileTab(projectId, filePath);
    } else if (dbtJobMatch) {
      // /x/:projectId/job/:jobId
      const projectId = dbtJobMatch[1];
      const jobId = dbtJobMatch[2];
      setLeftPane("dbt");

      const existingTab = Object.values(useConsoleStore.getState().tabs).find(
        t =>
          t.kind === "dbt-job" &&
          t.metadata?.projectId === projectId &&
          t.metadata?.jobId === jobId,
      );

      if (existingTab) {
        setActiveTab(existingTab.id);
      } else {
        // Fetch jobs to resolve the title, then open the tab (placeholder
        // title until then). focusDbtJobTab dedupes if a tab already exists.
        useDbtStore
          .getState()
          .fetchJobs(currentWorkspace.id, projectId)
          .then(() => {
            const job = useDbtStore
              .getState()
              .jobsByProject[projectId]?.find(j => j._id === jobId);
            focusDbtJobTab(projectId, jobId, job?.name || "Job");
          });
      }
    } else if (dbtRunsMatch) {
      // /x/:projectId/runs
      const projectId = dbtRunsMatch[1];
      setLeftPane("dbt");
      focusDbtRunsTab(projectId, "Runs");
    } else if (dbtConsoleMatch) {
      // /x/:projectId — the project Console is the project home.
      const projectId = dbtConsoleMatch[1];
      setLeftPane("dbt");
      focusDbtConsoleTab(projectId, "Console");
    } else if (notebookMatch) {
      // /n/:notebookId — focusNotebookTab dedupes against an existing tab and
      // activates it. NotebookRenderer loads the doc by id and syncs the real
      // name onto the tab, so a placeholder title is fine on cold load.
      const notebookId = notebookMatch[1];
      setLeftPane("notebooks");
      focusNotebookTab(notebookId, "Untitled notebook");
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
