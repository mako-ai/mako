import { nanoid } from "nanoid";
import {
  addDashboardWidget,
  createDashboardDataSource,
  getDashboardStateSnapshot,
  importConsoleAsDashboardDataSource,
  previewDashboardQuery,
  removeDashboardWidget,
  runDashboardDataSource,
  updateDashboardDataSourceQuery,
  updateDashboardWidget,
} from "./commands";
import { useDashboardStore } from "../store/dashboardStore";
import { useVersionStore } from "../store/versionStore";
import type { Dashboard, DashboardDataSource, DashboardWidget } from "./types";
import { CronExpressionParser } from "cron-parser";
import { classifyDuckDBError, classifySourceError } from "./error-kinds";
import { computeDashboardStateHash } from "../utils/stateHash";
import {
  DASHBOARD_EXECUTOR_TOOL_NAMES,
  type AgentToolName,
} from "../agent-runtime/client-tool-manifest";
import { resolveDataSourceCodeEdit } from "@mako/agent-tools";
import { captureScreenshot } from "../agent-runtime/screenshot-agent-tools";
import { focusDashboardTab, getCurrentWorkspaceId } from "./shell";
import {
  validateCrossFilterWidgetSql,
  validateDuckDBQuery,
  validateVegaSpec,
} from "./validation";
import { selectWidgetRuntime } from "./selectors";
import { getAllTemplates, getTemplate } from "@mako/schemas";

import { throwIfAborted, abortableSleep } from "./abort-utils";

/**
 * Poll the runtime store for widget render status after adding/modifying a
 * chart widget. Returns the render error if the chart fails, or null on
 * success / timeout (we don't block the agent indefinitely).
 */
async function waitForWidgetRenderResult(
  dashboardId: string,
  widgetId: string,
  signal?: AbortSignal,
  maxWaitMs = 3000,
): Promise<{ renderError: string | null; renderErrorKind: string | null }> {
  const POLL_INTERVAL = 150;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const runtime = selectWidgetRuntime(dashboardId, widgetId);
    if (runtime?.renderStatus === "error") {
      return {
        renderError: runtime.renderError,
        renderErrorKind: runtime.renderErrorKind,
      };
    }
    if (runtime?.renderStatus === "ready") {
      return { renderError: null, renderErrorKind: null };
    }
    await abortableSleep(POLL_INTERVAL, signal);
  }

  return { renderError: null, renderErrorKind: null };
}

const DASHBOARD_ID_REQUIRED_ERROR =
  "dashboardId is required. Use list_open_dashboards to get available dashboard IDs.";

function requireDashboardId(input: Record<string, unknown>): {
  dashboardId: string;
  workspaceId: string;
} | null {
  if (typeof input.dashboardId !== "string") return null;
  const store = useDashboardStore.getState();
  const dashboard = store.openDashboards[input.dashboardId];
  if (!dashboard) return null;
  return {
    dashboardId: input.dashboardId,
    workspaceId: dashboard.workspaceId,
  };
}

const READ_ONLY_TOOLS = new Set([
  "get_dashboard_state",
  "preview_data_source",
  "get_data_preview",
  "get_chart_templates",
  "get_chart_template",
  "list_open_dashboards",
  "open_dashboard",
]);

const EDIT_MODE_EXEMPT_TOOLS = new Set([
  "enter_edit_mode",
  "create_dashboard",
  "list_open_dashboards",
  "open_dashboard",
  // Restore is a server-side revert + reload; it does not require holding the
  // edit lock (it replaces the open tab's state with the restored draft).
  "dashboard_restore_version",
  // Generic version tools take an entityType/entityId ref (not dashboardId),
  // so the blanket dashboardId edit-mode gate below cannot apply; the
  // dashboard save leg re-checks edit mode itself.
  "save_version",
  "restore_version",
]);

async function saveDashboardVersionLeg(
  dashboardId: string,
  comment: string,
): Promise<Record<string, unknown>> {
  const store = useDashboardStore.getState();
  if (!store.openDashboards[dashboardId]) {
    return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
  }
  if (!store.isEditMode(dashboardId)) {
    return {
      success: false,
      error:
        "Dashboard is in read mode. Use enter_edit_mode first to enable editing.",
      errorKind: "not_in_edit_mode",
    };
  }
  const workspaceId = store.openDashboards[dashboardId].workspaceId;
  const result = await store.saveDashboard(workspaceId, dashboardId, comment);
  if (!result.ok) {
    return {
      success: false,
      error:
        result.error ||
        "Save failed (the dashboard may have been modified elsewhere; reload and retry).",
    };
  }
  const d = useDashboardStore.getState().openDashboards[dashboardId] as
    | (Record<string, any> & { version?: number; publishedVersion?: number })
    | undefined;
  return {
    success: true,
    version: d?.version,
    publishedVersion: d?.publishedVersion,
    message: `Saved and published "${d?.title ?? "dashboard"}" as version ${d?.publishedVersion ?? d?.version}.`,
  };
}

async function restoreDashboardVersionLeg(
  dashboardId: string,
  version: number,
  comment: string | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const store = useDashboardStore.getState();
  const dashboard = store.openDashboards[dashboardId];
  if (!dashboard) {
    return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
  }
  const workspaceId = dashboard.workspaceId;
  const res = await useVersionStore
    .getState()
    .restoreVersion(workspaceId, "dashboard", dashboardId, version, comment);
  if (!res.success) {
    return { success: false, error: res.error || "Restore failed" };
  }
  await useDashboardStore.getState().reloadDashboard(workspaceId, dashboardId);
  throwIfAborted(signal);
  const d = useDashboardStore.getState().openDashboards[dashboardId];
  return {
    success: true,
    restoredFrom: version,
    title: (d as any)?.title,
    message:
      `Restored the dashboard draft to version ${version}. This is not yet ` +
      "published — save a version to push it live to viewers.",
  };
}

export async function executeDashboardAgentTool(
  toolName: string,
  input: Record<string, unknown>,
  options?: {
    executionId?: string;
    signal?: AbortSignal;
    /**
     * The agent toolCallId driving this execution. Forwarded to creation
     * commands as an idempotency key: multiple windows attached to the same
     * chat stream each dispatch the same call, and the server (or the
     * dashboard doc) dedupes by this id so the side effect lands once.
     */
    toolCallId?: string;
  },
): Promise<Record<string, unknown> | null> {
  if (!DASHBOARD_EXECUTOR_TOOL_NAMES.has(toolName as AgentToolName)) {
    return null;
  }

  const signal = options?.signal;
  if (toolName === "list_open_dashboards") {
    const store = useDashboardStore.getState();
    const dashboards = Object.values(store.openDashboards).map((d: any) => ({
      id: d._id,
      title: d.title,
      description: d.description || null,
      dataSourceCount: d.dataSources?.length ?? 0,
      widgetCount: d.widgets?.length ?? 0,
      isActive: d._id === store.activeDashboardId,
      isEditing: !!store.editingDashboards[d._id],
    }));
    return {
      success: true,
      dashboards,
      message: `Found ${dashboards.length} open dashboard(s)`,
    };
  }

  if (toolName === "open_dashboard") {
    const dashboardId =
      typeof input.dashboardId === "string" ? input.dashboardId : null;
    if (!dashboardId) {
      return { success: false, error: "dashboardId is required." };
    }

    const store = useDashboardStore.getState();
    const existing = store.openDashboards[dashboardId];
    if (existing) {
      if (store.activeDashboardId !== dashboardId) {
        useDashboardStore.setState(s => {
          s.activeDashboardId = dashboardId;
        });
      }
      focusDashboardTab(dashboardId, (existing as any).title);
      return {
        success: true,
        dashboardId,
        title: (existing as any).title,
        message: `Dashboard "${(existing as any).title}" is already open — switched to it.`,
      };
    }

    const workspaceId = getCurrentWorkspaceId();
    if (!workspaceId) {
      return { success: false, error: "No active workspace" };
    }

    try {
      await store.openDashboard(workspaceId, dashboardId, { signal });
      throwIfAborted(signal);
      const dashboard =
        useDashboardStore.getState().openDashboards[dashboardId];
      if (!dashboard) {
        return {
          success: false,
          error: `Dashboard ${dashboardId} not found or access denied.`,
        };
      }

      focusDashboardTab(dashboardId, (dashboard as any).title);

      return {
        success: true,
        dashboardId,
        title: (dashboard as any).title,
        message: `Dashboard "${(dashboard as any).title}" opened successfully.`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to open dashboard";
      return { success: false, error: message };
    }
  }

  // Generic version tools: dashboards go through the local draft flows (the
  // working draft lives in this tab). The v1 app leg is gone with Apps v1 —
  // git-backed apps version through git itself, not entity_versions.
  if (toolName === "save_version" || toolName === "restore_version") {
    const entityType =
      input.entityType === "dashboard" ? input.entityType : null;
    const entityId = typeof input.entityId === "string" ? input.entityId : null;
    if (!entityType || !entityId) {
      return {
        success: false,
        error:
          "entityType ('dashboard') and entityId are required. Apps are " +
          "git-backed: use app_commit / app_merge_to_main instead.",
      };
    }
    const comment =
      typeof input.comment === "string" ? input.comment : undefined;

    if (toolName === "save_version") {
      return saveDashboardVersionLeg(entityId, comment ?? "");
    }

    const version =
      typeof input.version === "number" ? input.version : Number(input.version);
    if (!Number.isFinite(version)) {
      return { success: false, error: "version (number) is required" };
    }
    return restoreDashboardVersionLeg(entityId, version, comment, signal);
  }

  // Deprecated aliases of restore_version / save_version (entityType:
  // "dashboard") — existing chats may replay these names.
  if (toolName === "dashboard_restore_version") {
    const ctx = requireDashboardId(input);
    if (!ctx) return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    const version =
      typeof input.version === "number" ? input.version : Number(input.version);
    if (!Number.isFinite(version)) {
      return { success: false, error: "version (number) is required" };
    }
    const comment =
      typeof input.comment === "string" ? input.comment : undefined;
    return restoreDashboardVersionLeg(
      ctx.dashboardId,
      version,
      comment,
      signal,
    );
  }

  if (toolName === "dashboard_save_version") {
    const ctx = requireDashboardId(input);
    if (!ctx) return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    const comment = typeof input.comment === "string" ? input.comment : "";
    return saveDashboardVersionLeg(ctx.dashboardId, comment);
  }

  if (toolName === "capture_screenshot") {
    return captureScreenshot(input, { signal });
  }

  if (toolName === "create_dashboard") {
    const workspaceId = getCurrentWorkspaceId();
    if (!workspaceId || typeof workspaceId !== "string") {
      return { success: false, error: "No active workspace" };
    }
    if (typeof input.title !== "string" || !input.title.trim()) {
      return { success: false, error: "title is required" };
    }

    try {
      const dashboard = await useDashboardStore.getState().createDashboard(
        workspaceId,
        {
          title: input.title,
          description:
            typeof input.description === "string"
              ? input.description
              : undefined,
          // Server-side create idempotency: another window attached to the
          // same chat stream dispatching this exact tool call gets the same
          // dashboard back instead of creating a duplicate.
          ...(options?.toolCallId
            ? { idempotencyKey: options.toolCallId }
            : {}),
        } as any,
        { signal },
      );
      throwIfAborted(signal);

      if (!dashboard) {
        return { success: false, error: "Failed to create dashboard" };
      }

      useDashboardStore.setState((state: any) => {
        state.openDashboards[dashboard._id] = dashboard;
        state.activeDashboardId = dashboard._id;
        state.historyMap[dashboard._id] = { stack: [], index: -1 };
        state.savedStateHashes[dashboard._id] =
          computeDashboardStateHash(dashboard);
      });

      await useDashboardStore
        .getState()
        .enterEditMode(workspaceId, dashboard._id, { signal })
        .catch(() => {});
      throwIfAborted(signal);

      focusDashboardTab(dashboard._id, dashboard.title);

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

  if (toolName === "enter_edit_mode") {
    const dashboardId =
      typeof input.dashboardId === "string" ? input.dashboardId : null;
    if (!dashboardId) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    }
    const store = useDashboardStore.getState();
    const dashboard = store.openDashboards[dashboardId];
    if (!dashboard) {
      return {
        success: false,
        error: `Dashboard ${dashboardId} is not open. Use open_dashboard first.`,
      };
    }
    const workspaceId = dashboard.workspaceId;
    if (!workspaceId) {
      return { success: false, error: "No workspace found for dashboard" };
    }
    if (dashboard.readOnly === true) {
      return {
        success: false,
        error: "This dashboard is read-only. You cannot enter edit mode.",
      };
    }
    if (store.editingDashboards[dashboardId]) {
      return { success: true, alreadyEditing: true };
    }

    const result = await store.enterEditMode(workspaceId, dashboardId, {
      signal,
    });
    throwIfAborted(signal);
    if (result.ok) {
      return { success: true };
    }

    const lockedBy = result.lockedBy ?? "Another user";
    const userApproved = await new Promise<boolean>((resolve, reject) => {
      const handleAbort = () => {
        useDashboardStore.getState().setLockConflictPrompt(null);
        reject(new DOMException("Dashboard tool cancelled", "AbortError"));
      };
      if (signal?.aborted) {
        handleAbort();
        return;
      }
      signal?.addEventListener("abort", handleAbort, { once: true });
      useDashboardStore.getState().setLockConflictPrompt({
        dashboardId,
        lockedBy,
        resolve: force => {
          signal?.removeEventListener("abort", handleAbort);
          resolve(force);
        },
      });
    });
    throwIfAborted(signal);

    if (!userApproved) {
      return {
        success: false,
        error: "User declined to force-acquire the edit lock.",
        lockedBy,
      };
    }

    const forceResult = await useDashboardStore
      .getState()
      .enterEditMode(workspaceId, dashboardId, { force: true, signal });
    throwIfAborted(signal);
    if (forceResult.ok) {
      return { success: true, forcedFrom: lockedBy };
    }
    return {
      success: false,
      error: "Failed to force-acquire edit lock.",
    };
  }

  if (!READ_ONLY_TOOLS.has(toolName) && !EDIT_MODE_EXEMPT_TOOLS.has(toolName)) {
    const dashboardId =
      typeof input.dashboardId === "string" ? input.dashboardId : null;
    if (!dashboardId) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    }
    if (!useDashboardStore.getState().isEditMode(dashboardId)) {
      return {
        success: false,
        error:
          "Dashboard is in read mode. Use enter_edit_mode first to enable editing.",
        errorKind: "not_in_edit_mode",
      };
    }
  }

  if (
    toolName === "add_data_source" ||
    toolName === "import_console_as_data_source" ||
    // create_data_source with consoleId imports the console by value — same
    // path as the deprecated import aliases above.
    (toolName === "create_data_source" && typeof input.consoleId === "string")
  ) {
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
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
          signal,
          toolCallId: options?.toolCallId,
        });
        throwIfAborted(signal);
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
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    }

    if (typeof input.name !== "string") {
      return {
        success: false,
        error: "name is required (unless consoleId is given)",
      };
    }
    if (typeof input.connectionId !== "string") {
      return {
        success: false,
        error: "connectionId is required (unless consoleId is given)",
      };
    }
    if (typeof input.code !== "string") {
      return {
        success: false,
        error: "code is required (unless consoleId is given)",
      };
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
        materialization: input.materialization === "live" ? "live" : "parquet",
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
        signal,
        toolCallId: options?.toolCallId,
      });
      throwIfAborted(signal);
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
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
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

    const edit = resolveDataSourceCodeEdit(existing.query.code ?? "", {
      action: typeof input.action === "string" ? input.action : undefined,
      code: typeof input.code === "string" ? input.code : undefined,
      startLine:
        typeof input.startLine === "number" ? input.startLine : undefined,
      endLine: typeof input.endLine === "number" ? input.endLine : undefined,
    });
    if (!edit.ok) {
      return { success: false, error: edit.error };
    }
    const resolvedCode = edit.code;

    const nextLanguage = (
      typeof input.language === "string"
        ? input.language
        : existing.query.language
    ) as DashboardDataSource["query"]["language"];

    const shouldRun = input.run === true;

    try {
      await updateDashboardDataSourceQuery({
        workspaceId: ctx.workspaceId,
        dataSourceId: input.dataSourceId,
        dashboardId: ctx.dashboardId,
        rematerialize: shouldRun,
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
          materialization:
            input.materialization === "live" ||
            input.materialization === "parquet"
              ? input.materialization
              : existing.materialization,
          query: {
            ...existing.query,
            connectionId:
              typeof input.connectionId === "string"
                ? input.connectionId
                : existing.query.connectionId,
            language: nextLanguage,
            code: resolvedCode,
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
        signal,
      });
      throwIfAborted(signal);

      // Dashboard-level cron auto-refresh (parity with
      // app_update_data_binding's materializationSchedule): one schedule
      // refreshes every parquet source of the dashboard.
      let scheduleMessage = "";
      if (
        input.materializationSchedule &&
        typeof input.materializationSchedule === "object"
      ) {
        const requested = input.materializationSchedule as {
          enabled?: boolean;
          cron?: string | null;
          timezone?: string;
          dataFreshnessTtlMs?: number | null;
        };
        const enabled = requested.enabled === true;
        const cron = enabled ? (requested.cron ?? "").trim() || null : null;
        if (enabled) {
          if (!cron) {
            return {
              success: false,
              error:
                "materializationSchedule.cron is required when enabling the schedule (5-field cron, e.g. '0 * * * *' = hourly).",
            };
          }
          try {
            CronExpressionParser.parse(cron, {
              tz: requested.timezone ?? "UTC",
            });
          } catch {
            return {
              success: false,
              error: `Invalid materialization schedule cron: "${cron}"`,
            };
          }
          const dashboardAfterUpdate =
            useDashboardStore.getState().openDashboards[ctx.dashboardId];
          const hasParquetSource = dashboardAfterUpdate?.dataSources.some(
            ds => ds.materialization === "parquet",
          );
          if (!hasParquetSource) {
            return {
              success: false,
              error:
                "Scheduled refresh only rebuilds 'parquet' data sources and this dashboard has none. Switch a data source to materialization: 'parquet' first (this tool can do both in one call).",
            };
          }
        }
        const current =
          useDashboardStore.getState().openDashboards[ctx.dashboardId]
            ?.materializationSchedule;
        const nextSchedule = {
          enabled,
          cron,
          timezone: requested.timezone ?? current?.timezone ?? "UTC",
          dataFreshnessTtlMs:
            requested.dataFreshnessTtlMs !== undefined
              ? requested.dataFreshnessTtlMs
              : (current?.dataFreshnessTtlMs ?? null),
        };
        await useDashboardStore
          .getState()
          .updateDashboard(ctx.workspaceId, ctx.dashboardId, {
            materializationSchedule: nextSchedule,
          } as Partial<Dashboard>);
        throwIfAborted(signal);
        // updateDashboard swallows request errors — confirm the write landed
        // before reporting success to the agent.
        const persisted =
          useDashboardStore.getState().openDashboards[ctx.dashboardId]
            ?.materializationSchedule;
        if (
          (persisted?.enabled ?? false) !== enabled ||
          (persisted?.cron ?? null) !== cron
        ) {
          return {
            success: false,
            error:
              "The data source was updated, but persisting the dashboard schedule failed. Retry the schedule change, or check write access to this dashboard.",
          };
        }
        scheduleMessage = enabled
          ? ` Dashboard auto-refresh schedule set: ${cron} (${nextSchedule.timezone}) — one schedule refreshes all parquet sources.`
          : " Dashboard auto-refresh schedule is now off.";
      }

      if (shouldRun) {
        const snapshot = getDashboardStateSnapshot(ctx.dashboardId);
        const runtimeSource = snapshot.dataSources.find(
          ds => ds.id === input.dataSourceId,
        );
        return {
          success: true,
          dataSourceId: input.dataSourceId,
          state: "loaded" as const,
          runtimeState: "fresh" as const,
          activeSource: runtimeSource?.activeSource ?? "draft_stream",
          loadPath: runtimeSource?.loadPath ?? null,
          nextRecommendedTool: null,
          rowCount: runtimeSource?.rowCount ?? null,
          schema: runtimeSource?.columns ?? [],
          sampleRows: runtimeSource?.sampleRows?.slice(0, 5) ?? [],
          message: `Updated "${existing.name}" and loaded fresh draft-stream data into DuckDB.${scheduleMessage}`,
        };
      }
      const snapshot = getDashboardStateSnapshot(ctx.dashboardId);
      const runtimeSource = snapshot.dataSources.find(
        ds => ds.id === input.dataSourceId,
      );
      return {
        success: true,
        dataSourceId: input.dataSourceId,
        state: "definition_updated" as const,
        runtimeState: "stale" as const,
        activeSource: runtimeSource?.activeSource ?? null,
        loadPath: runtimeSource?.loadPath ?? null,
        nextRecommendedTool: "run_data_source_query" as const,
        rowCount: null,
        schema: [],
        sampleRows: [],
        message: `Definition saved only. The dashboard is still using the previously loaded data until run_data_source_query is called.${scheduleMessage}`,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to update data source query";
      return {
        success: false,
        state: shouldRun ? ("execution_failed" as const) : undefined,
        runtimeState: shouldRun ? ("stale" as const) : undefined,
        error: message,
        errorKind: classifySourceError(message),
      };
    }
  }

  if (toolName === "run_data_source_query") {
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    }

    if (typeof input.dataSourceId !== "string") {
      return { success: false, error: "dataSourceId is required" };
    }

    try {
      const result = await runDashboardDataSource({
        workspaceId: ctx.workspaceId,
        dashboardId: ctx.dashboardId,
        dataSourceId: input.dataSourceId,
        signal,
      });
      throwIfAborted(signal);

      const snapshot = getDashboardStateSnapshot(ctx.dashboardId);
      const runtimeSource = snapshot.dataSources.find(
        ds => ds.id === input.dataSourceId,
      );
      return {
        success: true,
        dataSourceId: input.dataSourceId,
        state: "loaded" as const,
        runtimeState: "fresh" as const,
        activeSource: runtimeSource?.activeSource ?? "draft_stream",
        rowCount: runtimeSource?.rowCount ?? null,
        schema: runtimeSource?.columns ?? [],
        sampleRows: runtimeSource?.sampleRows?.slice(0, 5) ?? [],
        loadPath: result.loadPath,
        recovered: result.recovered,
        nextRecommendedTool: null,
        ...(result.recovered && {
          recoveredAllDataSources: true,
          hint: "A WASM crash was detected and the DuckDB instance was recreated. All data sources were automatically re-materialized.",
        }),
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to run data source query";
      return {
        success: false,
        error: message,
        errorKind: classifySourceError(message),
      };
    }
  }

  if (toolName === "get_chart_templates") {
    return { success: true, templates: getAllTemplates() };
  }

  if (toolName === "get_chart_template") {
    if (typeof input.templateId !== "string") {
      // No templateId = list mode (folded in from get_chart_templates).
      return { success: true, templates: getAllTemplates() };
    }
    const tpl = getTemplate(input.templateId);
    if (!tpl) {
      return {
        success: false,
        error: `Template "${input.templateId}" not found. Call get_chart_template without templateId to see available IDs.`,
      };
    }
    return { success: true, template: tpl };
  }

  if (toolName === "get_dashboard_state") {
    const dashboardId =
      typeof input.dashboardId === "string" ? input.dashboardId : null;
    if (!dashboardId) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    }
    const snapshot = getDashboardStateSnapshot(dashboardId);

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
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    }
    if (typeof input.dataSourceId !== "string") {
      return { success: false, error: "dataSourceId is required" };
    }

    try {
      const result = await previewDashboardQuery({
        dataSourceId: input.dataSourceId,
        sql: typeof input.sql === "string" ? input.sql : undefined,
        dashboardId: ctx.dashboardId,
        signal,
      });
      throwIfAborted(signal);

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
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    }

    if (input.vegaLiteSpec !== undefined) {
      const specValidation = await validateVegaSpec(input.vegaLiteSpec);
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
      signal,
    });
    throwIfAborted(signal);
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

    addDashboardWidget(widget, ctx.dashboardId);

    try {
      const result = await previewDashboardQuery({
        dashboardId: ctx.dashboardId,
        dataSourceId: widget.dataSourceId,
        sql: widget.localSql,
        signal,
      });
      throwIfAborted(signal);

      const renderResult =
        widget.type === "chart" && widget.vegaLiteSpec
          ? await waitForWidgetRenderResult(ctx.dashboardId, widget.id, signal)
          : null;
      throwIfAborted(signal);

      if (renderResult?.renderError) {
        return {
          success: true,
          widgetId: widget.id,
          renderError: `Chart render failed: ${renderResult.renderError}`,
          renderErrorKind: renderResult.renderErrorKind ?? "vega_render_failed",
          hint: "The widget was added but the Vega-Lite spec failed to render. Use modify_widget to fix the spec. Check encoding field names match the query output columns, and ensure the mark type is compatible with the data types.",
          query: {
            rowCount: result.rowCount,
            fields: result.fields.map(field => field.name),
            sampleRow: result.rows[0] ?? null,
          },
        };
      }

      return {
        success: true,
        widgetId: widget.id,
        query: {
          rowCount: result.rowCount,
          fields: result.fields.map(field => field.name),
          sampleRow: result.rows[0] ?? null,
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Widget query failed";
      const isLoading = /still loading/i.test(message);
      return {
        success: true,
        widgetId: widget.id,
        queryError: message,
        errorKind: classifyDuckDBError(message),
        ...(isLoading && {
          hint: "The data source is still loading. The widget was added but could NOT be validated. Do not assume it is working.",
        }),
      };
    }
  }

  if (toolName === "modify_widget") {
    if (typeof input.widgetId !== "string") {
      return { success: false, error: "widgetId is required" };
    }
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    }
    const targetDashboard =
      useDashboardStore.getState().openDashboards[ctx.dashboardId];
    if (!targetDashboard) {
      return {
        success: false,
        error: `Dashboard ${ctx.dashboardId} is not open. Use open_dashboard first.`,
      };
    }
    const targetWidget = targetDashboard.widgets.find(
      w => w.id === input.widgetId,
    );
    if (!targetWidget) {
      return { success: false, error: "Widget not found in target dashboard" };
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
      const existingLayouts = targetWidget.layouts;
      changes.layouts = existingLayouts
        ? { ...existingLayouts, ...input.layouts }
        : input.layouts;
    }
    if (changes.vegaLiteSpec !== undefined) {
      const specValidation = await validateVegaSpec(changes.vegaLiteSpec);
      if (!specValidation.valid) {
        return {
          success: false,
          error: `Invalid Vega-Lite spec: ${specValidation.errors.join(" | ")}`,
          errorKind: specValidation.errorKind,
        };
      }
    }
    if (changes.localSql !== undefined) {
      const queryValidation = await validateDuckDBQuery({
        dashboardId: ctx.dashboardId,
        dataSourceId: targetWidget.dataSourceId,
        sql: String(changes.localSql),
        signal,
      });
      throwIfAborted(signal);
      if (!queryValidation.valid) {
        return {
          success: false,
          error: queryValidation.error,
          errorKind: queryValidation.errorKind,
        };
      }
    }
    {
      const crossFilterValidation = validateCrossFilterWidgetSql({
        sql: String(changes.localSql ?? targetWidget.localSql ?? ""),
        crossFilterEnabled: targetWidget.crossFilter?.enabled ?? true,
      });
      if (!crossFilterValidation.valid) {
        return {
          success: false,
          error: crossFilterValidation.error,
          errorKind: "crossfilter_invalid",
        };
      }
    }

    updateDashboardWidget(
      input.widgetId,
      changes as Partial<DashboardWidget>,
      ctx.dashboardId,
    );

    try {
      const dashboard =
        useDashboardStore.getState().openDashboards[ctx.dashboardId];
      const widget = dashboard?.widgets.find(w => w.id === input.widgetId);
      if (!widget) {
        return {
          success: false,
          widgetId: input.widgetId,
          error: "Widget update did not persist to target dashboard",
        };
      }
      const result = await previewDashboardQuery({
        dashboardId: ctx.dashboardId,
        dataSourceId: widget.dataSourceId,
        sql: widget.localSql,
        signal,
      });
      throwIfAborted(signal);

      const isChartWithSpec =
        widget.type === "chart" &&
        (changes.vegaLiteSpec || widget.vegaLiteSpec);
      const renderResult = isChartWithSpec
        ? await waitForWidgetRenderResult(ctx.dashboardId, widget.id, signal)
        : null;
      throwIfAborted(signal);

      if (renderResult?.renderError) {
        return {
          success: true,
          widgetId: input.widgetId,
          renderError: `Chart render failed: ${renderResult.renderError}`,
          renderErrorKind: renderResult.renderErrorKind ?? "vega_render_failed",
          hint: "The widget was modified but the Vega-Lite spec failed to render. Use modify_widget to fix the spec. Check encoding field names match the query output columns, and ensure the mark type is compatible with the data types.",
          query: {
            rowCount: result.rowCount,
            fields: result.fields.map(field => field.name),
            sampleRow: result.rows[0] ?? null,
          },
        };
      }

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
      const isLoading = /still loading/i.test(message);
      return {
        success: true,
        widgetId: input.widgetId,
        queryError: message,
        errorKind: classifyDuckDBError(message),
        ...(isLoading && {
          hint: "The data source is still loading. The spec change was applied but could NOT be validated. Do not assume the fix is working.",
        }),
      };
    }
  }

  if (toolName === "remove_widget") {
    if (typeof input.widgetId !== "string") {
      return { success: false, error: "widgetId is required" };
    }
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    }
    removeDashboardWidget(input.widgetId, ctx.dashboardId);
    return { success: true };
  }

  if (toolName === "add_global_filter") {
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
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
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
    }
    useDashboardStore
      .getState()
      .removeGlobalFilter(ctx.dashboardId, input.filterId as string);
    return { success: true };
  }

  if (toolName === "link_tables") {
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
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
    const ctx = requireDashboardId(input);
    if (!ctx) {
      return { success: false, error: DASHBOARD_ID_REQUIRED_ERROR };
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
