import { useEffect, useRef, useState } from "react";
import { Snackbar } from "@mui/material";
import { useUIStore } from "../store/uiStore";
import { useConsoleStore } from "../store/consoleStore";
import { useDashboardStore } from "../store/dashboardStore";
import { useAppsStore } from "../store/appsStore";
import {
  closeAppsTabsFor,
  focusAppsFileTab,
  focusAppsTab,
} from "../apps-runtime/shell";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import { SECTION_LABELS, isSettingsSection } from "../pages/settings/sections";
import {
  focusDbtConsoleTab,
  focusDbtFileTab,
  focusDbtJobTab,
  focusDbtRunsTab,
} from "../dbt-runtime/shell";
import { useDbtStore } from "../store/dbtStore";
import { useMcpStore } from "../store/mcpStore";
import {
  focusDashboardDataSourceTab,
  focusDashboardTab,
} from "../dashboard-runtime/shell";
import { focusFlowTabById } from "../flow-runtime/shell";
import { focusNotebookTab } from "../notebook-runtime/shell";
import {
  TAB_DEEP_LINK_PATTERNS,
  decodePathSegments,
  tabUrlPath,
} from "../lib/tab-routing";

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
  // Dead-link feedback: a URL that no longer resolves (deleted app) used to
  // silently rewrite to "/" — the page just "lost" what the user asked for.
  const [deadLinkNotice, setDeadLinkNotice] = useState<string | null>(null);
  const { currentWorkspace } = useWorkspace();
  const { user } = useAuth();
  const loadConsole = useConsoleStore(state => state.loadConsole);
  const focusOrOpenTab = useConsoleStore(state => state.focusOrOpenTab);

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

    // Reload vs deep link, and they deserve opposite answers. The URL follows
    // the active TAB, so on a plain reload the handlers below would move the
    // left pane to the tab's home view — silently overriding the persisted
    // pane, which is how reloading with an app tab open bounced you off the
    // Source Control panel (and, less visibly, off every other view). A
    // reload keeps your workbench where it was; a link someone sent you still
    // takes you to the thing.
    const isReload =
      (
        performance.getEntriesByType(
          "navigation",
        )[0] as PerformanceNavigationTiming
      )?.type === "reload";
    const paneBeforeHydration = useUIStore.getState().leftPane;

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
    const appMatch = path.match(TAB_DEEP_LINK_PATTERNS["app"]);
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

      // A source-connection tab keeps its id in `content`; the name is
      // fetched by SourceConnectionTab, so the title is a placeholder until it loads.
      focusOrOpenTab(
        { kind: "connectors", where: t => t.content === connectorId },
        () => ({
          title: "Source connection",
          content: connectorId,
          kind: "connectors",
        }),
      );
    } else if (flowMatch) {
      // /f/:flowId
      const flowId = flowMatch[1];
      setLeftPane("flows");

      focusFlowTabById(flowId);
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

      // Focus if open; else resolve the title, then open (focusDashboardTab
      // dedupes again in case a tab appeared while the list was loading).
      if (!focusOrOpenTab({ kind: "dashboard", metadata: { dashboardId } })) {
        useDashboardStore
          .getState()
          .fetchDashboards(currentWorkspace.id)
          .then(dashboards => {
            const dashboard = dashboards.find(d => d._id === dashboardId);
            focusDashboardTab(dashboardId, dashboard?.title || "Dashboard");
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

      focusOrOpenTab(
        {
          kind: "table-data",
          metadata: { schema, table },
          where: t =>
            t.connectionId === connectionId &&
            (t.databaseName || undefined) === databaseName,
        },
        () => ({
          title: table,
          content: "",
          kind: "table-data",
          connectionId,
          databaseId,
          databaseName,
          metadata: { schema, table },
        }),
      );
    } else if (appFileMatch) {
      // /a/:appId/file/:path — Apps file editor
      const appId = appFileMatch[1];
      const filePath = decodePathSegments(appFileMatch[2]);
      setLeftPane("apps");
      void useAppsStore
        .getState()
        .fetchApps(currentWorkspace.id)
        .then(() => {
          const app = useAppsStore
            .getState()
            .apps.find(a => a.id === appId || a.slug === appId);
          if (!app) {
            closeAppsTabsFor(appId);
            window.history.replaceState(null, "", "/");
            setDeadLinkNotice(
              "That app link doesn't resolve anymore — the app may have been deleted or renamed.",
            );
            return;
          }
          focusAppsFileTab(app.id, filePath, app.slug);
        });
    } else if (appMatch) {
      // /a/:appId — Apps (git-backed, experimental)
      const appId = appMatch[1];
      setLeftPane("apps");
      const store = useAppsStore.getState();
      void store.fetchApps(currentWorkspace.id).then(() => {
        // The path segment may be a slug (the app's folder in the repo) or a
        // legacy Mongo id. Resolve either; the outgoing sync then rewrites the
        // URL to the slug form, so old links upgrade themselves.
        const app = useAppsStore
          .getState()
          .apps.find(a => a.id === appId || a.slug === appId);
        if (!app) {
          // The link points at an app that is gone, or lives in another
          // workspace. Opening a tab anyway rendered the whole workspace view
          // — breadcrumb, terminal, a live Publish button — around nothing,
          // and reloading restored the same dead id, so the page looked
          // permanently stuck. Clear it and fall back to the list instead.
          closeAppsTabsFor(appId);
          window.history.replaceState(null, "", "/");
          setDeadLinkNotice(
            "That app link doesn't resolve anymore — the app may have been deleted or renamed.",
          );
          return;
        }
        focusAppsTab(app.id, app.title, app.slug);
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

      // Focus if open; else resolve the title, then open (focusDbtJobTab
      // dedupes again in case a tab appeared while jobs were loading).
      if (
        !focusOrOpenTab({ kind: "dbt-job", metadata: { projectId, jobId } })
      ) {
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
      focusOrOpenTab({ kind: "plan", metadata: { chatId } });
    } else if (settingsSectionMatch) {
      // /settings/:section — open the explorer *and* focus the section's tab.
      const section = settingsSectionMatch[1];
      setLeftPane("settings");

      if (isSettingsSection(section)) {
        focusOrOpenTab(
          { kind: "settings", where: t => t.settingsSection === section },
          () => ({
            title: SECTION_LABELS[section],
            content: "",
            kind: "settings",
            settingsSection: section,
          }),
        );
      }
    } else if (settingsMatch) {
      // /settings — just show the explorer panel. No tab is forced open;
      // the user picks a section from the panel.
      setLeftPane("settings");
    }

    if (isReload) {
      // The tab handlers above still opened/focused the right tab; only the
      // pane choice is restored.
      setLeftPane(paneBeforeHydration);
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

  // Renders nothing except the dead-link notice.
  return (
    <Snackbar
      open={deadLinkNotice !== null}
      autoHideDuration={6000}
      onClose={() => setDeadLinkNotice(null)}
      message={deadLinkNotice ?? ""}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
    />
  );
}
