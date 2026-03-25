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
import { useConsoleStore } from "../store/consoleStore";
import { useUIStore } from "../store/uiStore";
import type { DashboardDataSource, DashboardWidget } from "./types";
import { classifyDuckDBError, classifySourceError } from "./error-kinds";
import {
  validateCrossFilterWidgetSql,
  validateDuckDBQuery,
  validateVegaSpec,
} from "./validation";

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
  if (toolName === "create_dashboard") {
    const ctx = getActiveContext();
    const workspaceId =
      ctx?.workspaceId ?? useUIStore.getState().currentWorkspaceId;
    if (!workspaceId || typeof workspaceId !== "string") {
      return { success: false, error: "No active workspace" };
    }
    if (typeof input.title !== "string" || !input.title.trim()) {
      return { success: false, error: "title is required" };
    }

    try {
      const dashboard = await useDashboardStore
        .getState()
        .createDashboard(workspaceId, {
          title: input.title,
          description:
            typeof input.description === "string"
              ? input.description
              : undefined,
        } as any);

      if (!dashboard) {
        return { success: false, error: "Failed to create dashboard" };
      }

      const consoleStore = useConsoleStore.getState();
      const tabId = consoleStore.openTab({
        title: dashboard.title,
        content: "",
        kind: "dashboard",
        metadata: { dashboardId: dashboard._id },
      });
      consoleStore.setActiveTab(tabId);
      useUIStore.getState().setLeftPane("dashboards");

      return {
        success: true,
        dashboardId: dashboard._id,
        _eventType: "dashboard_creation",
        message: `Dashboard "${dashboard.title}" created successfully`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create dashboard";
      return { success: false, error: message };
    }
  }

  if (
    toolName === "add_data_source" ||
    toolName === "import_console_as_data_source"
  ) {
    const ctx = getActiveContext();
    if (!ctx) {
      return { success: false, error: "No active dashboard" };
    }

    if (typeof input.consoleId === "string") {
      try {
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
        const snapshot = getDashboardStateSnapshot(ctx.dashboardId);
        const runtimeSource = snapshot.dataSources.find(
          ds => ds.id === dataSource.id,
        );

        return {
          success: true,
          dataSourceId: dataSource.id,
          tableRef: dataSource.tableRef,
          rowCount: runtimeSource?.rowCount ?? null,
          schema: runtimeSource?.columns ?? [],
          sampleRows: runtimeSource?.sampleRows?.slice(0, 5) ?? [],
          message: `Data source "${dataSource.name}" imported into the dashboard.`,
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to import data source";
        return {
          success: false,
          error: message,
          errorKind: classifySourceError(message),
        };
      }
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

    try {
      const dataSource = await createDashboardDataSource({
        workspaceId: ctx.workspaceId,
        name: input.name,
        timeDimension:
          typeof input.timeDimension === "string"
            ? input.timeDimension
            : undefined,
        rowLimit:
          typeof input.rowLimit === "number" ? input.rowLimit : undefined,
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
      const snapshot = getDashboardStateSnapshot(ctx.dashboardId);
      const runtimeSource = snapshot.dataSources.find(
        ds => ds.id === dataSource.id,
      );

      return {
        success: true,
        dataSourceId: dataSource.id,
        tableRef: dataSource.tableRef,
        rowCount: runtimeSource?.rowCount ?? null,
        schema: runtimeSource?.columns ?? [],
        sampleRows: runtimeSource?.sampleRows?.slice(0, 5) ?? [],
        message: `Data source "${dataSource.name}" created and loaded.`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create data source";
      return {
        success: false,
        error: message,
        errorKind: classifySourceError(message),
      };
    }
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

    try {
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

      const snapshot = getDashboardStateSnapshot(ctx.dashboardId);
      const runtimeSource = snapshot.dataSources.find(
        ds => ds.id === input.dataSourceId,
      );
      return {
        success: true,
        dataSourceId: input.dataSourceId,
        rowCount: runtimeSource?.rowCount ?? null,
        schema: runtimeSource?.columns ?? [],
        sampleRows: runtimeSource?.sampleRows?.slice(0, 5) ?? [],
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to update data source query";
      return {
        success: false,
        error: message,
        errorKind: classifySourceError(message),
      };
    }
  }

  if (toolName === "get_dashboard_state") {
    const snapshot = getDashboardStateSnapshot(
      typeof input.dashboardId === "string" ? input.dashboardId : undefined,
    );

    const SAMPLE_ROW_LIMIT = 5;

    const {
      _id,
      workspaceId: _wsId,
      access: _access,
      owner_id: _ownerId,
      createdBy: _createdBy,
      readOnly: _readOnly,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      versionHistory: _versionHistory,
      eventLog: _eventLog,
      queryGeneration: _queryGeneration,
      ...definition
    } = snapshot as Record<string, unknown>;

    const dataSources = (definition.dataSources as any[])?.map(
      ({ _id: _dsId, sampleRows, ...ds }: any) => ({
        ...ds,
        sampleRows: sampleRows?.slice(0, SAMPLE_ROW_LIMIT),
      }),
    );
    const widgets = (definition.widgets as any[])?.map(
      ({ _id: _wId, ...w }: any) => w,
    );

    const rawSnapshots = (definition.snapshots ?? {}) as Record<string, any>;
    const snapshots: Record<string, any> = {};
    for (const [key, snap] of Object.entries(rawSnapshots)) {
      snapshots[key] = {
        ...snap,
        rows: snap.rows?.slice(0, SAMPLE_ROW_LIMIT),
      };
    }

    return {
      success: true,
      dashboard: {
        id: _id,
        ...definition,
        dataSources,
        widgets,
        snapshots,
      },
    };
  }

  if (toolName === "get_data_preview" || toolName === "preview_data_source") {
    if (typeof input.dataSourceId !== "string") {
      return { success: false, error: "dataSourceId is required" };
    }

    try {
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
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Query preview failed";
      return {
        success: false,
        error: message,
        errorKind: classifyDuckDBError(message),
      };
    }
  }

  if (toolName === "add_widget") {
    const ctx = getActiveContext();
    if (!ctx) {
      return { success: false, error: "No active dashboard" };
    }

    if (input.vegaLiteSpec !== undefined) {
      const specValidation = validateVegaSpec(input.vegaLiteSpec);
      if (!specValidation.valid) {
        return {
          success: false,
          error: `Invalid Vega-Lite spec: ${specValidation.errors.join(" | ")}`,
          errorKind: specValidation.errorKind,
        };
      }
    }

    const queryValidation = await validateDuckDBQuery({
      dashboardId: ctx.dashboardId,
      dataSourceId: input.dataSourceId as string | undefined,
      sql: String(input.localSql || ""),
    });
    if (!queryValidation.valid) {
      return {
        success: false,
        error: queryValidation.error,
        errorKind: queryValidation.errorKind,
      };
    }

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
      layouts: input.layouts as DashboardWidget["layouts"],
    };
    const crossFilterValidation = validateCrossFilterWidgetSql({
      sql: widget.localSql,
      crossFilterEnabled: widget.crossFilter.enabled,
    });
    if (!crossFilterValidation.valid) {
      return {
        success: false,
        error: crossFilterValidation.error,
        errorKind: "crossfilter_invalid",
      };
    }

    addDashboardWidget(widget);

    try {
      const result = await previewDashboardQuery({
        dashboardId: ctx.dashboardId,
        dataSourceId: widget.dataSourceId,
        sql: widget.localSql,
      });
      return {
        success: true,
        widgetId: widget.id,
        query: {
          rowCount: result.rowCount,
          fields: result.fields.map(field => field.name),
          sampleRow: result.rows[0] ?? null,
        },
        specValidation: input.vegaLiteSpec ? { valid: true } : undefined,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Widget query failed";
      return {
        success: false,
        widgetId: widget.id,
        error: message,
        errorKind: classifyDuckDBError(message),
      };
    }
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
    if (input.layouts !== undefined) {
      const ctx = getActiveContext();
      const existingDashboard = ctx
        ? useDashboardStore.getState().openDashboards[ctx.dashboardId]
        : null;
      const existingWidget = existingDashboard?.widgets.find(
        w => w.id === input.widgetId,
      );
      const existingLayouts = existingWidget?.layouts;
      changes.layouts = existingLayouts
        ? { ...existingLayouts, ...input.layouts }
        : input.layouts;
    }
    if (changes.vegaLiteSpec !== undefined) {
      const specValidation = validateVegaSpec(changes.vegaLiteSpec);
      if (!specValidation.valid) {
        return {
          success: false,
          error: `Invalid Vega-Lite spec: ${specValidation.errors.join(" | ")}`,
          errorKind: specValidation.errorKind,
        };
      }
    }
    if (changes.localSql !== undefined) {
      const ctx = getActiveContext();
      if (!ctx) {
        return { success: false, error: "No active dashboard" };
      }
      const dashboard =
        useDashboardStore.getState().openDashboards[ctx.dashboardId];
      const widget = dashboard?.widgets.find(w => w.id === input.widgetId);
      const queryValidation = await validateDuckDBQuery({
        dashboardId: ctx.dashboardId,
        dataSourceId: widget?.dataSourceId,
        sql: String(changes.localSql),
      });
      if (!queryValidation.valid) {
        return {
          success: false,
          error: queryValidation.error,
          errorKind: queryValidation.errorKind,
        };
      }
    }
    {
      const ctx2 = getActiveContext();
      const dashboard2 = ctx2
        ? useDashboardStore.getState().openDashboards[ctx2.dashboardId]
        : null;
      const widgetForValidation = dashboard2?.widgets.find(
        w => w.id === input.widgetId,
      );
      const crossFilterValidation = validateCrossFilterWidgetSql({
        sql: String(changes.localSql ?? widgetForValidation?.localSql ?? ""),
        crossFilterEnabled: widgetForValidation?.crossFilter?.enabled ?? true,
      });
      if (!crossFilterValidation.valid) {
        return {
          success: false,
          error: crossFilterValidation.error,
          errorKind: "crossfilter_invalid",
        };
      }
    }

    updateDashboardWidget(input.widgetId, changes as Partial<DashboardWidget>);

    try {
      const ctx = getActiveContext();
      const dashboard = ctx
        ? useDashboardStore.getState().openDashboards[ctx.dashboardId]
        : null;
      const widget = dashboard?.widgets.find(w => w.id === input.widgetId);
      if (!ctx || !widget) {
        return { success: true, widgetId: input.widgetId };
      }
      const result = await previewDashboardQuery({
        dashboardId: ctx.dashboardId,
        dataSourceId: widget.dataSourceId,
        sql: widget.localSql,
      });
      return {
        success: true,
        widgetId: input.widgetId,
        query: {
          rowCount: result.rowCount,
          fields: result.fields.map(field => field.name),
          sampleRow: result.rows[0] ?? null,
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Widget query failed";
      return {
        success: false,
        widgetId: input.widgetId,
        error: message,
        errorKind: classifyDuckDBError(message),
      };
    }
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
