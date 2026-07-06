/**
 * Command palette — entity search providers (default mode).
 *
 * Each provider reads the owning domain store synchronously and returns
 * scored, ready-to-run items. The only async source is the server-side
 * console search, which lives in commandPaletteStore; its results are
 * converted to items here.
 */

import { focusAppTab } from "../../app-runtime/shell";
import { focusDashboardTab } from "../../dashboard-runtime/shell";
import { focusDbtConsoleTab } from "../../dbt-runtime/shell";
import { useAppStore } from "../../store/appStore";
import type { ConsoleSearchResult } from "../../store/commandPaletteStore";
import { useConsoleStore } from "../../store/consoleStore";
import {
  useDashboardTreeStore,
  type DashboardEntry,
} from "../../store/dashboardTreeStore";
import { useDbtStore } from "../../store/dbtStore";
import { useFlowStore, type Flow } from "../../store/flowStore";
import { EXPLORER_ICONS, TAB_KIND_ICONS, tabKindIcon } from "../entity-icons";
import { matchScore, type PaletteEntityItem } from "./types";

interface Scored {
  item: PaletteEntityItem;
  score: number;
}

function sorted(scored: Scored[], limit: number): PaletteEntityItem[] {
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.item);
}

/** Open editor tabs — instant switch. Listed first, even for empty queries. */
export function searchOpenTabs(query: string): PaletteEntityItem[] {
  const state = useConsoleStore.getState();
  const scored: Scored[] = state.tabOrder
    .filter(id => id !== state.activeTabId && state.tabs[id])
    .map(id => {
      const tab = state.tabs[id];
      return {
        score: matchScore(query, tab.title),
        item: {
          id: `tab:${id}`,
          title: tab.title,
          subtitle: "Open tab",
          section: "Open Tabs",
          icon: tabKindIcon(tab.kind),
          run: () => useConsoleStore.getState().setActiveTab(id),
        },
      };
    });
  return sorted(scored, query ? 6 : 5);
}

/** Server console search results (already query-filtered by the API). */
export function consoleResultItems(
  workspaceId: string,
  results: ConsoleSearchResult[],
): PaletteEntityItem[] {
  const openTabs = useConsoleStore.getState().tabs;
  return results
    .filter(result => !openTabs[result.id])
    .map(result => ({
      id: `console:${result.id}`,
      title: result.title,
      subtitle: [result.connectionName, result.databaseName]
        .filter(Boolean)
        .join(" · "),
      section: "Consoles",
      icon: TAB_KIND_ICONS.console,
      run: () => {
        void useConsoleStore.getState().loadConsole(workspaceId, result.id);
      },
    }));
}

function flattenDashboards(entries: DashboardEntry[]): DashboardEntry[] {
  const out: DashboardEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      out.push(...flattenDashboards(entry.children ?? []));
    } else {
      out.push(entry);
    }
  }
  return out;
}

export function searchDashboards(
  workspaceId: string,
  query: string,
): PaletteEntityItem[] {
  const state = useDashboardTreeStore.getState();
  const entries = [
    ...flattenDashboards(state.myDashboards[workspaceId] ?? []),
    ...flattenDashboards(state.workspaceDashboards[workspaceId] ?? []),
  ];
  const seen = new Set<string>();
  const scored: Scored[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    scored.push({
      score: matchScore(query, entry.name),
      item: {
        id: `dashboard:${entry.id}`,
        title: entry.name,
        section: "Dashboards",
        icon: TAB_KIND_ICONS.dashboard,
        run: () => {
          focusDashboardTab(entry.id, entry.name);
        },
      },
    });
  }
  return sorted(scored, 5);
}

export function searchApps(
  workspaceId: string,
  query: string,
): PaletteEntityItem[] {
  const state = useAppStore.getState();
  const apps = [
    ...(state.myApps[workspaceId] ?? []),
    ...(state.workspaceApps[workspaceId] ?? []),
  ];
  const seen = new Set<string>();
  const scored: Scored[] = [];
  for (const app of apps) {
    if (seen.has(app.id)) continue;
    seen.add(app.id);
    scored.push({
      score: matchScore(query, app.name),
      item: {
        id: `app:${app.id}`,
        title: app.name,
        section: "Apps",
        icon: TAB_KIND_ICONS.app,
        run: () => {
          focusAppTab(app.id, app.name);
        },
      },
    });
  }
  return sorted(scored, 5);
}

export function searchDbtProjects(query: string): PaletteEntityItem[] {
  const scored: Scored[] = useDbtStore.getState().projects.map(project => ({
    score: matchScore(query, project.name),
    item: {
      id: `dbt:${project._id}`,
      title: project.name,
      subtitle: "dbt project",
      section: "Transforms",
      icon: EXPLORER_ICONS.dbt,
      run: () => {
        focusDbtConsoleTab(project._id, project.name);
      },
    },
  }));
  return sorted(scored, 4);
}

/** Mirrors FlowsExplorer's title derivation for a flow row. */
function flowTitle(flow: Flow): string {
  const f = flow as Flow & {
    sourceType?: string;
    tableDestination?: { tableName?: string };
  };
  if (f.sourceType === "database") {
    return `Query -> ${f.tableDestination?.tableName || "Table"}`;
  }
  const sourceName =
    (flow.dataSourceId as { name?: string } | undefined)?.name || "Source";
  const destName =
    (flow.destinationDatabaseId as { name?: string } | undefined)?.name ||
    "Destination";
  return `${sourceName} -> ${destName}`;
}

export function searchFlows(
  workspaceId: string,
  query: string,
): PaletteEntityItem[] {
  const flows = useFlowStore.getState().flows[workspaceId] ?? [];
  const scored: Scored[] = flows.map(flow => {
    const title = flowTitle(flow);
    return {
      score: matchScore(query, title),
      item: {
        id: `flow:${flow._id}`,
        title,
        section: "Flows",
        icon: EXPLORER_ICONS.flows,
        run: () => {
          const consoleStore = useConsoleStore.getState();
          useFlowStore.getState().selectFlow(flow._id);
          const existing = Object.values(consoleStore.tabs).find(
            tab => tab.metadata?.flowId === flow._id,
          );
          if (existing) {
            consoleStore.setActiveTab(existing.id);
            return;
          }
          const f = flow as Flow & { sourceType?: string };
          const id = consoleStore.openTab({
            title,
            content: "",
            kind: "flow-editor",
            metadata: {
              flowId: flow._id,
              isNew: false,
              flowType:
                f.sourceType === "database" ? "db-scheduled" : flow.type,
              enabled:
                flow.type === "webhook"
                  ? flow.webhookConfig?.enabled
                  : flow.schedule?.enabled,
            },
          });
          consoleStore.setActiveTab(id);
        },
      },
    };
  });
  return sorted(scored, 4);
}
