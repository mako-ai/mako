import { nanoid } from "nanoid";
import {
  addDashboardWidget,
  createDashboardDataSource,
  getDashboardStateSnapshot,
  importConsoleAsDashboardDataSource,
  previewDashboardQuery,
  removeDashboardWidget,
  updateDashboardDataSourceQuery,
  updateDashboardWidget,
} from "./commands";
import { useDashboardStore } from "../store/dashboardStore";
import type { DashboardDataSource, DashboardWidget } from "./types";

function getActiveContext(): {
  dashboardId: string;
  workspaceId: string;
} | null {
  const state = useDashboardStore.getState();
  const dashboardId = state.activeDashboardId;
  if (!dashboardId) return null;
  const workspaceId = state.openDashboards[dashboardId]?.workspaceId;
  if (!workspaceId) return null;
  return { dashboardId, workspaceId };
}

export async function executeDashboardAgentTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (
    toolName === "add_data_source" ||
    toolName === "import_console_as_data_source"
  ) {
    const ctx = getActiveContext();
    if (!ctx) {
      return { success: false, error: "No active dashboard" };
    }

    if (typeof input.consoleId === "string") {
      const dataSource = await importConsoleAsDashboardDataSource({
        workspaceId: ctx.workspaceId,
        consoleId: input.consoleId,
        name: typeof input.name === "string" ? input.name : undefined,
        rowLimit:
          typeof input.rowLimit === "number" ? input.rowLimit : undefined,
        timeDimension:
          typeof input.timeDimension === "string"
            ? input.timeDimension
            : undefined,
        dashboardId: ctx.dashboardId,
      });

      return {
        success: true,
        dataSourceId: dataSource.id,
        tableRef: dataSource.tableRef,
        message: `Data source "${dataSource.name}" imported into the dashboard.`,
      };
    }

    return { success: false, error: "consoleId is required" };
  }

  if (toolName === "create_data_source") {
    const ctx = getActiveContext();
    if (!ctx) {
      return { success: false, error: "No active dashboard" };
    }

    if (typeof input.name !== "string") {
      return { success: false, error: "name is required" };
    }
    if (typeof input.connectionId !== "string") {
      return { success: false, error: "connectionId is required" };
    }
    if (typeof input.code !== "string") {
      return { success: false, error: "code is required" };
    }

    const dataSource = await createDashboardDataSource({
      workspaceId: ctx.workspaceId,
      name: input.name,
      timeDimension:
        typeof input.timeDimension === "string"
          ? input.timeDimension
          : undefined,
      rowLimit: typeof input.rowLimit === "number" ? input.rowLimit : undefined,
      dashboardId: ctx.dashboardId,
      query: {
        connectionId: input.connectionId,
        language: (typeof input.language === "string"
          ? input.language
          : "sql") as DashboardDataSource["query"]["language"],
        code: input.code,
        databaseId:
          typeof input.databaseId === "string" ? input.databaseId : undefined,
        databaseName:
          typeof input.databaseName === "string"
            ? input.databaseName
            : undefined,
      },
    });

    return {
      success: true,
      dataSourceId: dataSource.id,
      tableRef: dataSource.tableRef,
      message: `Data source "${dataSource.name}" created and loaded.`,
    };
  }

  if (toolName === "update_data_source_query") {
    const ctx = getActiveContext();
    if (!ctx) {
      return { success: false, error: "No active dashboard" };
    }

    if (typeof input.dataSourceId !== "string") {
      return { success: false, error: "dataSourceId is required" };
    }

    const currentDashboard =
      useDashboardStore.getState().openDashboards[ctx.dashboardId];
    const existing = currentDashboard?.dataSources.find(
      ds => ds.id === input.dataSourceId,
    );
    if (!existing) {
      return { success: false, error: "Data source not found" };
    }

    const nextLanguage = (
      typeof input.language === "string"
        ? input.language
        : existing.query.language
    ) as DashboardDataSource["query"]["language"];

    await updateDashboardDataSourceQuery({
      workspaceId: ctx.workspaceId,
      dataSourceId: input.dataSourceId,
      dashboardId: ctx.dashboardId,
      changes: {
        name: typeof input.name === "string" ? input.name : existing.name,
        timeDimension:
          typeof input.timeDimension === "string"
            ? input.timeDimension
            : existing.timeDimension,
        rowLimit:
          typeof input.rowLimit === "number"
            ? input.rowLimit
            : existing.rowLimit,
        query: {
          ...existing.query,
          connectionId:
            typeof input.connectionId === "string"
              ? input.connectionId
              : existing.query.connectionId,
          language: nextLanguage,
          code:
            typeof input.code === "string" ? input.code : existing.query.code,
          databaseId:
            typeof input.databaseId === "string"
              ? input.databaseId
              : existing.query.databaseId,
          databaseName:
            typeof input.databaseName === "string"
              ? input.databaseName
              : existing.query.databaseName,
        },
      },
    });

    return { success: true, dataSourceId: input.dataSourceId };
  }

  if (toolName === "get_dashboard_state") {
    const snapshot = getDashboardStateSnapshot(
      typeof input.dashboardId === "string" ? input.dashboardId : undefined,
    );
    return {
      success: true,
      dashboard: {
        id: snapshot._id,
        title: snapshot.title,
        description: snapshot.description,
        dataSources: snapshot.dataSources,
        widgets: snapshot.widgets.map(widget => ({
          id: widget.id,
          title: widget.title,
          type: widget.type,
          dataSourceId: widget.dataSourceId,
          localSql: widget.localSql,
        })),
        relationships: snapshot.relationships,
        globalFilters: snapshot.globalFilters,
        crossFilter: snapshot.crossFilter,
        layout: snapshot.layout,
      },
    };
  }

  if (toolName === "get_data_preview" || toolName === "preview_data_source") {
    if (typeof input.dataSourceId !== "string") {
      return { success: false, error: "dataSourceId is required" };
    }

    const result = await previewDashboardQuery({
      dataSourceId: input.dataSourceId,
      sql: typeof input.sql === "string" ? input.sql : undefined,
    });

    return {
      success: true,
      columns: result.fields,
      rows: result.rows.slice(0, 50),
      rowCount: result.rowCount,
    };
  }

  if (toolName === "add_widget") {
    const widget: DashboardWidget = {
      id: nanoid(),
      title: input.title as string | undefined,
      type: input.type as "chart" | "kpi" | "table",
      dataSourceId: input.dataSourceId as string,
      localSql: input.localSql as string,
      vegaLiteSpec: input.vegaLiteSpec as Record<string, unknown> | undefined,
      kpiConfig: input.kpiConfig as DashboardWidget["kpiConfig"],
      tableConfig: input.tableConfig as DashboardWidget["tableConfig"],
      crossFilter: { enabled: true },
      layout: input.layout as DashboardWidget["layout"],
    };
    addDashboardWidget(widget);
    return { success: true, widgetId: widget.id };
  }

  if (toolName === "modify_widget") {
    if (typeof input.widgetId !== "string") {
      return { success: false, error: "widgetId is required" };
    }
    const changes: Record<string, unknown> = {};
    if (input.title !== undefined) changes.title = input.title;
    if (input.localSql !== undefined) changes.localSql = input.localSql;
    if (input.vegaLiteSpec !== undefined) {
      changes.vegaLiteSpec = input.vegaLiteSpec;
    }
    if (input.kpiConfig !== undefined) changes.kpiConfig = input.kpiConfig;
    if (input.tableConfig !== undefined) {
      changes.tableConfig = input.tableConfig;
    }
    if (input.layout !== undefined) changes.layout = input.layout;
    updateDashboardWidget(input.widgetId, changes as Partial<DashboardWidget>);
    return { success: true, widgetId: input.widgetId };
  }

  if (toolName === "remove_widget") {
    if (typeof input.widgetId !== "string") {
      return { success: false, error: "widgetId is required" };
    }
    removeDashboardWidget(input.widgetId);
    return { success: true };
  }

  if (toolName === "add_global_filter") {
    const ctx = getActiveContext();
    if (!ctx) {
      return { success: false, error: "No active dashboard" };
    }
    const activeDashboard =
      useDashboardStore.getState().openDashboards[ctx.dashboardId];
    const filter = {
      id: nanoid(),
      type: input.type as any,
      label: input.label as string,
      dataSourceId: input.dataSourceId as string,
      column: input.column as string,
      config: input.defaultValue ? { defaultValue: input.defaultValue } : {},
      layout: {
        order: activeDashboard?.globalFilters.length || 0,
      },
    };
    useDashboardStore.getState().addGlobalFilter(ctx.dashboardId, filter);
    return { success: true, filterId: filter.id };
  }

  if (toolName === "remove_global_filter") {
    const ctx = getActiveContext();
    if (!ctx) {
      return { success: false, error: "No active dashboard" };
    }
    useDashboardStore
      .getState()
      .removeGlobalFilter(ctx.dashboardId, input.filterId as string);
    return { success: true };
  }

  if (toolName === "link_tables") {
    const ctx = getActiveContext();
    if (!ctx) {
      return { success: false, error: "No active dashboard" };
    }
    const relationship = {
      id: nanoid(),
      from: input.from as any,
      to: input.to as any,
      type: input.type as any,
    };
    useDashboardStore.getState().addRelationship(ctx.dashboardId, relationship);
    return { success: true, relationshipId: relationship.id };
  }

  if (toolName === "set_time_dimension") {
    const ctx = getActiveContext();
    if (!ctx) {
      return { success: false, error: "No active dashboard" };
    }
    if (
      typeof input.dataSourceId !== "string" ||
      typeof input.column !== "string"
    ) {
      return {
        success: false,
        error: "dataSourceId and column are required",
      };
    }
    useDashboardStore
      .getState()
      .updateDataSource(ctx.dashboardId, input.dataSourceId, {
        timeDimension: input.column,
      });
    return { success: true };
  }

  return null;
}
