import React from "react";
import { Box } from "@mui/material";
import { ChevronRight as BreadcrumbChevronIcon } from "lucide-react";
import { useConsoleStore } from "../store/consoleStore";
import { useSchemaStore } from "../store/schemaStore";
import { useAppStore } from "../store/appStore";
import { useDashboardStore } from "../store/dashboardStore";
import { useDbtStore } from "../store/dbtStore";
import { useUIStore } from "../store/uiStore";
import { useExplorerRevealStore } from "../store/explorerRevealStore";
import { tabRevealTarget } from "../lib/explorer-reveal";
import { useWorkspace } from "../contexts/workspace-context";
import { SECTION_LABELS } from "../pages/settings/sections";
import type { ConsoleTab, TabKind } from "../store/lib/types";
import { consoleFolderTrail, consoleLeafName } from "../lib/console-name";

interface BreadcrumbSegment {
  label: string;
  /** Render in italics (e.g. "Unsaved console"). */
  italic?: boolean;
}

interface EntityContext {
  workspaceName: string;
  connectionName?: string;
  dashboardTitle?: string;
  dashboardDataSourceName?: string;
  appTitle?: string;
  appBindingName?: string;
  dbtProjectName?: string;
}

/**
 * Compute the full breadcrumb trail for a tab. Every trail starts at the
 * workspace root, followed by the sidebar section the entity lives under,
 * then the entity's own path — e.g.
 * `Acme / Databases / prod / public / users` or
 * `Acme / Apps / My App / src / App.tsx`.
 *
 * REGRESSION GUARD: the switch is exhaustive over `TabKind` — adding a new
 * tab kind without defining its breadcrumb trail is a compile error (see
 * also lib/tab-routing.ts for the matching URL guard).
 */
function segmentsForTab(
  tab: ConsoleTab,
  ctx: EntityContext,
): BreadcrumbSegment[] {
  const root: BreadcrumbSegment = { label: ctx.workspaceName };
  const plain = (labels: Array<string | undefined>): BreadcrumbSegment[] => [
    root,
    ...labels
      .filter((label): label is string => !!label)
      .map(label => ({ label })),
  ];

  const kind: NonNullable<TabKind> = tab.kind ?? "console";
  switch (kind) {
    case "console": {
      if (!tab.filePath) {
        return [
          root,
          { label: "Consoles" },
          { label: "Unsaved console", italic: true },
        ];
      }
      const group = tab.access === "workspace" ? "Workspace" : "My Consoles";
      // Single source of truth: the leaf is the live display name (tab.title);
      // the folder trail is derived from the full path by stripping that leaf
      // (robust to a leaf name that itself contains slashes — legacy data).
      const leaf = tab.title || consoleLeafName(tab.filePath);
      const folderParts = consoleFolderTrail(tab.filePath, leaf);
      return plain(["Consoles", group, ...folderParts, leaf]);
    }
    case "table-data":
      return plain([
        "Databases",
        ctx.connectionName,
        tab.databaseName,
        (tab.metadata?.schema as string | undefined) || undefined,
        (tab.metadata?.table as string | undefined) || undefined,
      ]);
    case "dashboard":
      return plain(["Dashboards", ctx.dashboardTitle || tab.title]);
    case "dashboard-data-source":
      return plain([
        "Dashboards",
        ctx.dashboardTitle,
        "Data sources",
        ctx.dashboardDataSourceName || tab.title,
      ]);
    case "app":
      return plain(["Apps", ctx.appTitle || tab.title]);
    case "app-file": {
      const path = (tab.metadata?.path as string | undefined) || "";
      return plain([
        "Apps",
        ctx.appTitle || tab.title,
        ...path.split("/").filter(Boolean),
      ]);
    }
    case "app-binding":
      return plain([
        "Apps",
        ctx.appTitle,
        "Data sources",
        ctx.appBindingName || tab.title,
      ]);
    case "connectors":
      return plain(["Connectors", tab.title || "New connector"]);
    case "flow-editor":
      return plain(["Flows", tab.title || "New flow"]);
    case "settings":
      return plain([
        "Settings",
        tab.settingsSection ? SECTION_LABELS[tab.settingsSection] : undefined,
      ]);
    case "members":
      return plain(["Settings", "Members"]);
    case "plan":
      return plain(["Plans", tab.title || "Plan"]);
    case "dbt-file": {
      const path = (tab.metadata?.path as string | undefined) || "";
      return plain([
        "Transforms",
        ctx.dbtProjectName,
        ...path.split("/").filter(Boolean),
      ]);
    }
    case "dbt-job":
      return plain([
        "Transforms",
        ctx.dbtProjectName,
        "Jobs",
        tab.title || "Job",
      ]);
    case "dbt-console":
      return plain(["Transforms", ctx.dbtProjectName, tab.title || "Console"]);
    case "dbt-runs":
      return plain(["Transforms", ctx.dbtProjectName, tab.title || "Runs"]);
    default: {
      // Compile-time exhaustiveness: a new TabKind must be handled above.
      // Runtime still degrades gracefully for stale persisted tabs.
      const exhaustivenessCheck: never = kind;
      void exhaustivenessCheck;
      return plain([tab.title]);
    }
  }
}

interface EntityBreadcrumbsProps {
  tabId: string;
  /** Optional right-aligned content (e.g. a refresh button). */
  trailing?: React.ReactNode;
}

/**
 * Standardized breadcrumb bar shown at the top of every tab. One
 * implementation so every entity gets the same font, height and style,
 * with trails always starting at the workspace root.
 */
function EntityBreadcrumbs({ tabId, trailing }: EntityBreadcrumbsProps) {
  const tab = useConsoleStore(s => s.tabs[tabId]);
  const { currentWorkspace } = useWorkspace();

  const setLeftPane = useUIStore(s => s.setLeftPane);
  const openLeftPane = useUIStore(s => s.openLeftPane);
  const requestReveal = useExplorerRevealStore(s => s.requestReveal);

  // The breadcrumb is clickable when its entity has a sidebar home: clicking
  // switches to that explorer (even from a different one) and scrolls the
  // entity's row into view.
  const revealTarget = tabRevealTarget(tab);
  const handleNavigateToExplorer = React.useCallback(() => {
    if (!revealTarget) return;
    setLeftPane(revealTarget.explorer);
    openLeftPane();
    requestReveal(revealTarget.explorer, revealTarget.nodeId);
  }, [revealTarget, setLeftPane, openLeftPane, requestReveal]);

  const connectionId = tab?.connectionId;
  const connectionName = useSchemaStore(s => {
    if (tab?.kind !== "table-data" || !currentWorkspace || !connectionId) {
      return undefined;
    }
    const connection = (s.connections[currentWorkspace.id] || []).find(
      c => c.id === connectionId,
    );
    return connection?.displayName || connection?.name;
  });

  const appId = tab?.metadata?.appId as string | undefined;
  const bindingId = tab?.metadata?.bindingId as string | undefined;
  const appTitle = useAppStore(s =>
    appId ? s.openApps[appId]?.title : undefined,
  );
  const appBindingName = useAppStore(s =>
    appId && bindingId
      ? s.openApps[appId]?.dataBindings.find(b => b.id === bindingId)?.name
      : undefined,
  );

  const dbtProjectId = tab?.metadata?.projectId as string | undefined;
  const isDbtTab =
    tab?.kind === "dbt-file" ||
    tab?.kind === "dbt-job" ||
    tab?.kind === "dbt-console" ||
    tab?.kind === "dbt-runs";
  const dbtProjectName = useDbtStore(s =>
    isDbtTab && dbtProjectId
      ? s.projects.find(p => p._id === dbtProjectId)?.name
      : undefined,
  );

  const dashboardId = tab?.metadata?.dashboardId as string | undefined;
  const dataSourceId = tab?.metadata?.dataSourceId as string | undefined;
  const dashboardTitle = useDashboardStore(s =>
    dashboardId ? s.openDashboards[dashboardId]?.title : undefined,
  );
  const dashboardDataSourceName = useDashboardStore(s =>
    dashboardId && dataSourceId
      ? s.openDashboards[dashboardId]?.dataSources.find(
          ds => ds.id === dataSourceId,
        )?.name
      : undefined,
  );

  if (!tab) return null;

  const segments = segmentsForTab(tab, {
    workspaceName: currentWorkspace?.name || "Workspace",
    connectionName,
    dashboardTitle,
    dashboardDataSourceName,
    appTitle,
    appBindingName,
    dbtProjectName,
  });

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        minHeight: 26,
        px: 1.5,
        py: 0.25,
        backgroundColor: "background.paper",
        color: "text.secondary",
        fontSize: "0.75rem",
        overflow: "hidden",
        whiteSpace: "nowrap",
        gap: 0.25,
        borderBottom: "1px solid",
        borderColor: "divider",
        flexShrink: 0,
      }}
    >
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
          <Box
            key={`${index}-${segment.label}`}
            component="span"
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.25,
              minWidth: 0,
              flexShrink: isLast ? 0 : 1,
            }}
          >
            {index > 0 && (
              <BreadcrumbChevronIcon
                size={12}
                strokeWidth={2}
                style={{ flexShrink: 0, opacity: 0.6 }}
              />
            )}
            <Box
              component={revealTarget ? "button" : "span"}
              type={revealTarget ? "button" : undefined}
              onClick={revealTarget ? handleNavigateToExplorer : undefined}
              title={revealTarget ? "Reveal in explorer" : undefined}
              sx={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontStyle: segment.italic ? "italic" : "normal",
                color: isLast ? "text.primary" : "inherit",
                fontWeight: isLast ? 500 : 400,
                ...(revealTarget
                  ? {
                      cursor: "pointer",
                      appearance: "none",
                      background: "none",
                      border: "none",
                      p: 0,
                      m: 0,
                      font: "inherit",
                      color: isLast ? "text.primary" : "inherit",
                      maxWidth: "100%",
                      "&:hover": {
                        textDecoration: "underline",
                        color: "text.primary",
                      },
                      "&:focus-visible": {
                        outline: "1px solid",
                        outlineColor: "primary.main",
                        borderRadius: 0.5,
                      },
                    }
                  : {}),
              }}
            >
              {segment.label}
            </Box>
          </Box>
        );
      })}
      {trailing && (
        <Box
          sx={{
            ml: "auto",
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          {trailing}
        </Box>
      )}
    </Box>
  );
}

export default React.memo(EntityBreadcrumbs);
