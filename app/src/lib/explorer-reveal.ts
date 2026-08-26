/**
 * Explorer reveal mapping — single source of truth for "which sidebar explorer
 * owns a tab, and what tree-node id should be highlighted / scrolled to".
 *
 * Used by:
 *  - the tab-switch auto-scroll effect (App.tsx), which reveals the focused
 *    tab's row *only* when its owning explorer is already open;
 *  - clickable breadcrumbs (EntityBreadcrumbs.tsx), which switch to the owning
 *    explorer and then reveal the row.
 *
 * The `nodeId`s here MUST match the ids each explorer builds for its
 * `ResourceTree` nodes — see the per-case notes. The app separators are
 * exported and imported by `AppsExplorer` so the two never drift.
 */
import type { ConsoleTab, TabKind } from "../store/lib/types";

// App ResourceTree node-id encoding (kept in sync with AppsExplorer, which
// imports these). App node: "<appId>"; file: "<appId>::file::<path>";
// binding: "<appId>::binding::<bindingId>".
export const APP_FILE_SEP = "::file::";
export const APP_DIR_SEP = "::dir::";
export const APP_BINDING_SEP = "::binding::";
export const DASHBOARD_DATA_SOURCE_SEP = "::dashboard-data-source::";

// dbt (Transforms) ResourceTree node-id encoding (kept in sync with
// DbtExplorer, which imports these). Project node: "<projectId>";
// dir: "<projectId>::dir::<path>"; file: "<projectId>::file::<path>";
// job: "<projectId>::job::<jobId>"; runs: "<projectId>::runs::".
export const DBT_FILE_SEP = "::file::";
export const DBT_DIR_SEP = "::dir::";
export const DBT_JOB_SEP = "::job::";
export const DBT_RUNS_SEP = "::runs::";

/** Left-pane explorers that support reveal/scroll-to-row. */
export type RevealExplorer =
  | "consoles"
  | "dashboards"
  | "apps"
  | "apps-v2"
  | "connectors"
  | "flows"
  | "dbt"
  | "notebooks";

export interface ExplorerRevealTarget {
  explorer: RevealExplorer;
  /** Id of the `ResourceTree` node to expand-to, highlight and scroll into view. */
  nodeId: string;
}

/**
 * Resolve the explorer + tree-node a tab lives in, or `null` for tabs that
 * have no sidebar home (e.g. settings, plans) or that can't be addressed yet.
 *
 * The switch is exhaustive over `TabKind` so adding a new kind forces a
 * deliberate decision here (mirrors the tab-routing / breadcrumb guards).
 */
export function tabRevealTarget(
  tab: ConsoleTab | null | undefined,
): ExplorerRevealTarget | null {
  if (!tab) return null;
  const kind: NonNullable<TabKind> = tab.kind ?? "console";
  const meta = tab.metadata ?? {};

  switch (kind) {
    case "console":
      // Console rows in the Consoles explorer use the console (tab) id.
      return { explorer: "consoles", nodeId: tab.id };
    case "dashboard": {
      const id = meta.dashboardId as string | undefined;
      return id ? { explorer: "dashboards", nodeId: id } : null;
    }
    case "dashboard-data-source": {
      const dashboardId = meta.dashboardId as string | undefined;
      const dataSourceId = meta.dataSourceId as string | undefined;
      return dashboardId && dataSourceId
        ? {
            explorer: "dashboards",
            nodeId: `${dashboardId}${DASHBOARD_DATA_SOURCE_SEP}${dataSourceId}`,
          }
        : null;
    }
    case "app": {
      const appId = meta.appId as string | undefined;
      return appId ? { explorer: "apps", nodeId: appId } : null;
    }
    case "app-file": {
      const appId = meta.appId as string | undefined;
      const path = meta.path as string | undefined;
      return appId && path
        ? { explorer: "apps", nodeId: `${appId}${APP_FILE_SEP}${path}` }
        : null;
    }
    case "app-binding": {
      const appId = meta.appId as string | undefined;
      const bindingId = meta.bindingId as string | undefined;
      return appId && bindingId
        ? { explorer: "apps", nodeId: `${appId}${APP_BINDING_SEP}${bindingId}` }
        : null;
    }
    case "app-v2": {
      // Apps v2 explorer app rows are keyed by the project id.
      const appId = meta.appV2Id as string | undefined;
      return appId ? { explorer: "apps-v2", nodeId: appId } : null;
    }
    case "app-v2-file": {
      const appId = meta.appV2Id as string | undefined;
      const path = meta.path as string | undefined;
      return appId && path
        ? { explorer: "apps-v2", nodeId: `${appId}${APP_FILE_SEP}${path}` }
        : null;
    }
    case "connectors": {
      // Connector explorer rows are keyed by connector id, stored in `content`.
      const id = typeof tab.content === "string" ? tab.content : undefined;
      return id ? { explorer: "connectors", nodeId: id } : null;
    }
    case "flow-editor": {
      const flowId = meta.flowId as string | undefined;
      return flowId ? { explorer: "flows", nodeId: flowId } : null;
    }
    case "table-data":
      // Database explorer node ids depend on the (lazily-loaded) schema tree,
      // so there is no stable reveal id to scroll to.
      return null;
    case "members":
    case "notebook": {
      const id = meta.notebookId as string | undefined;
      return id ? { explorer: "notebooks", nodeId: id } : null;
    }
    case "plan":
    case "settings":
      return null;
    case "dbt-file": {
      const projectId = meta.projectId as string | undefined;
      const path = meta.path as string | undefined;
      return projectId && path
        ? { explorer: "dbt", nodeId: `${projectId}${DBT_FILE_SEP}${path}` }
        : null;
    }
    case "dbt-job": {
      const projectId = meta.projectId as string | undefined;
      const jobId = meta.jobId as string | undefined;
      return projectId && jobId
        ? { explorer: "dbt", nodeId: `${projectId}${DBT_JOB_SEP}${jobId}` }
        : null;
    }
    case "dbt-runs": {
      const projectId = meta.projectId as string | undefined;
      return projectId
        ? { explorer: "dbt", nodeId: `${projectId}${DBT_RUNS_SEP}` }
        : null;
    }
    case "dbt-console": {
      // The Console is the project home — reveal the project node itself.
      const projectId = meta.projectId as string | undefined;
      return projectId ? { explorer: "dbt", nodeId: projectId } : null;
    }
    case "app-v2-diff":
      // A transient diff view; nothing in an explorer corresponds to it.
      return null;
    default: {
      // Compile-time exhaustiveness: a new TabKind must be handled above.
      const exhaustivenessCheck: never = kind;
      void exhaustivenessCheck;
      return null;
    }
  }
}
