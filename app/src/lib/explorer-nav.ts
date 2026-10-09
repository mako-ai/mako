/**
 * The explorer rail, as data: which explorers exist, in what order, with
 * which icon and label. Shared by the desktop rail (Sidebar) and the
 * phone's Browse grid (MobileBrowse), so the two can never disagree.
 */
import { useEffect, useMemo } from "react";
import { useAuth } from "../contexts/auth-context";
import { useWorkspace } from "../contexts/workspace-context";
import { useWorkflowsStore } from "../store/workflowsStore";
import { EXPLORER_ICONS } from "./entity-icons";

export type NavigationView =
  | "databases"
  | "consoles"
  | "connectors"
  | "flows"
  | "dashboards"
  | "notebooks"
  | "apps"
  | "dbt"
  | "workflows"
  | "source-control"
  | "settings"
  | "views";

/** The explorers, in rail order. Shared with the phone's Browse grid. */
export const topNavigationItems: {
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
  { view: "workflows", icon: EXPLORER_ICONS.workflows, label: "Workflows" },
  { view: "connectors", icon: EXPLORER_ICONS.connectors, label: "Sources" },
  { view: "dashboards", icon: EXPLORER_ICONS.dashboards, label: "Dashboards" },
  { view: "notebooks", icon: EXPLORER_ICONS.notebooks, label: "Notebooks" },
  { view: "apps", icon: EXPLORER_ICONS["apps"], label: "Apps" },
];

export const bottomNavigationItems: {
  view: NavigationView;
  icon: any;
  label: string;
}[] = [{ view: "settings", icon: EXPLORER_ICONS.settings, label: "Settings" }];

/**
 * The rail for this workspace: Workflows is listed only where they are set
 * up and turned on, so an installation without them never shows an entry
 * that leads nowhere. Staff see it before that, to turn it on.
 */
export function useNavigationItems(): typeof topNavigationItems {
  const { currentWorkspace } = useWorkspace();
  const { user } = useAuth();
  const workspaceId = currentWorkspace?.id;
  const overview = useWorkflowsStore(s =>
    workspaceId ? s.overviewByWorkspace[workspaceId] : undefined,
  );
  const fetchOverview = useWorkflowsStore(s => s.fetchOverview);
  useEffect(() => {
    if (workspaceId) void fetchOverview(workspaceId);
  }, [workspaceId, fetchOverview]);
  const available = Boolean(
    overview?.configured && (overview.enabled || user?.isSuperAdmin),
  );
  return useMemo(
    () =>
      available
        ? topNavigationItems
        : topNavigationItems.filter(item => item.view !== "workflows"),
    [available],
  );
}
