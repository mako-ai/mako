/**
 * Server-side dashboard data-source tools.
 *
 * Dashboards manage data sources the same way apps manage data bindings:
 * `update_data_source_query` is one capability with per-surface adapters
 * (the run_app pattern) — the browser client applies edits to the open
 * dashboard tab, while this server leg executes against the authoritative
 * Dashboard document so headless / MCP agents can edit queries, switch
 * live/parquet materialization, and set the refresh schedule with no
 * browser attached.
 *
 * The code-edit semantics (action replace/patch/append) are shared with the
 * browser executor via resolveDataSourceCodeEdit in @mako/agent-tools, so
 * the two surfaces cannot drift.
 *
 * Persistence matches the resource-data-sources settings route: mutate the
 * loaded document and save() (Mongoose minimizes dirty paths, so this is
 * immune to the $set path-conflict class of bug; concurrency is
 * last-write-wins, same as that route). The version bump + realtime poke
 * make open tabs pull the new definition.
 */
import { tool } from "ai";
import { Types } from "mongoose";
import {
  updateDataSourceQuerySchema,
  resolveDataSourceCodeEdit,
  type UpdateDataSourceQueryInput,
} from "@mako/agent-tools";
import { Dashboard, type IDashboard } from "../../database/workspace-schema";
import { DashboardManager } from "../../utils/dashboard-manager";
import { workspaceService } from "../../services/workspace.service";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { validateDashboardMaterializationSchedule } from "../../services/dashboard-materialization-schedule.service";
import { queueDashboardArtifactRefresh } from "../../services/dashboard-refresh-runner.service";
import { bindingQueryAccessError } from "./shared/binding-query-access";
import type { QueryAccess } from "../../auth/api-key-scopes";
import { loggers } from "../../logging";

const logger = loggers.agent();

export interface ServerDashboardToolsOptions {
  workspaceId: string;
  /** Acting user (session user id, or API-key creator). */
  userId?: string;
  /** Chat driving this turn — used as the realtime echo-suppression id. */
  chatId?: string;
  /** Database capability granted by the calling API key. */
  queryAccess?: QueryAccess;
}

export function createServerDashboardTools({
  workspaceId,
  userId,
  chatId,
  queryAccess,
}: ServerDashboardToolsOptions) {
  const agentClientId = `agent:${chatId ?? "unknown"}`;

  let cachedRole: string | undefined | null = null;
  const memberRole = async (): Promise<string | undefined> => {
    if (cachedRole !== null) return cachedRole;
    if (!userId) {
      cachedRole = undefined;
      return undefined;
    }
    try {
      const member = await workspaceService.getMember(workspaceId, userId);
      cachedRole = member?.role;
    } catch {
      cachedRole = undefined;
    }
    return cachedRole ?? undefined;
  };

  const wrap = async <T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | { success: false; error: string }> => {
    try {
      return await fn();
    } catch (error) {
      logger.warn(`Server dashboard tool failed: ${label}`, {
        error,
        workspaceId,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : `Failed: ${label}`,
      };
    }
  };

  const loadDashboard = async (
    dashboardId: string,
  ): Promise<{ doc: IDashboard } | { error: string }> => {
    if (!dashboardId || !Types.ObjectId.isValid(dashboardId)) {
      return {
        error: `Invalid dashboard ID: ${dashboardId}. Use search_dashboards to find dashboard IDs.`,
      };
    }
    const doc = await Dashboard.findOne({
      _id: new Types.ObjectId(dashboardId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!doc) {
      return {
        error: `Dashboard ${dashboardId} not found. Use search_dashboards to find dashboard IDs.`,
      };
    }
    if (userId && !DashboardManager.canRead(doc, userId, await memberRole())) {
      return {
        error: `Dashboard ${dashboardId} not found. Use search_dashboards to find dashboard IDs.`,
      };
    }
    return { doc };
  };

  const canWrite = async (doc: IDashboard): Promise<boolean> => {
    if (!userId) return true; // workspace-scoped API-key automation
    const role = await memberRole();
    const isAdmin = role === "owner" || role === "admin";
    return DashboardManager.canWrite(doc, userId, isAdmin, role);
  };

  return {
    update_data_source_query: tool({
      description:
        "Modify an existing dashboard data source IN PLACE: query code " +
        "(action 'replace' | 'patch' with startLine/endLine | 'append'), " +
        "connection, language, database, name, live/parquet materialization, " +
        "or the dashboard's cron auto-refresh (materializationSchedule — " +
        "dashboard-level: ONE schedule refreshes all parquet sources; " +
        "mirrors app_update_data_binding). Non-code fields are shallow-" +
        "merged. run=true (or any definition change on a parquet source) " +
        "queues a server-side artifact rebuild. Find dashboards with " +
        "search_dashboards.",
      inputSchema: updateDataSourceQuerySchema,
      execute: async (input: UpdateDataSourceQueryInput) =>
        wrap("update_data_source_query", async () => {
          const loaded = await loadDashboard(input.dashboardId);
          if ("error" in loaded) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) {
            return {
              success: false,
              error: `You do not have write access to dashboard ${input.dashboardId}.`,
            };
          }
          const dataSource = (doc.dataSources ?? []).find(
            ds => ds.id === input.dataSourceId,
          );
          if (!dataSource) {
            return {
              success: false,
              error: `No data source with id "${input.dataSourceId}" on this dashboard.`,
            };
          }

          const edit = resolveDataSourceCodeEdit(
            dataSource.query?.code ?? "",
            input,
          );
          if (!edit.ok) return { success: false, error: edit.error };

          if (
            input.connectionId !== undefined &&
            !Types.ObjectId.isValid(input.connectionId)
          ) {
            return {
              success: false,
              error: `Invalid connectionId: ${input.connectionId}`,
            };
          }

          // Materialization / schedule legs (same semantics as
          // app_update_data_binding; the schedule is dashboard-level).
          const currentMaterialization =
            dataSource.materialization === "live" ? "live" : "parquet";
          const nextMaterialization =
            input.materialization ?? currentMaterialization;
          const materializationChanged =
            nextMaterialization !== currentMaterialization;

          let nextSchedule = doc.materializationSchedule;
          let scheduleChanged = false;
          if (input.materializationSchedule) {
            try {
              nextSchedule = validateDashboardMaterializationSchedule(
                input.materializationSchedule,
              );
            } catch (error) {
              return {
                success: false,
                error:
                  error instanceof Error
                    ? error.message
                    : "Invalid materialization schedule",
              };
            }
            if (nextSchedule.enabled) {
              const anyParquet = (doc.dataSources ?? []).some(
                ds =>
                  (ds.id === input.dataSourceId
                    ? nextMaterialization
                    : (ds.materialization ?? "parquet")) === "parquet",
              );
              if (!anyParquet) {
                return {
                  success: false,
                  error:
                    "Scheduled refresh only rebuilds 'parquet' data sources and this dashboard has none. Switch a data source to materialization: 'parquet' first (this tool can do both in one call).",
                };
              }
            }
            scheduleChanged = true;
          }

          const touchesDefinition =
            input.code !== undefined ||
            input.connectionId !== undefined ||
            input.language !== undefined ||
            input.databaseId !== undefined ||
            input.databaseName !== undefined;
          const nextLanguage =
            input.language ?? dataSource.query?.language ?? "sql";
          // Query-access is only needed when the update (re)runs the query:
          // definition edits, enabling a schedule, or building a parquet
          // artifact. A disable-only schedule change stays possible for
          // read-only keys.
          if (
            touchesDefinition ||
            input.materializationSchedule?.enabled === true ||
            (materializationChanged && nextMaterialization === "parquet")
          ) {
            const accessError = await bindingQueryAccessError({
              workspaceId,
              queryAccess,
              language: nextLanguage,
              code: edit.code,
              connectionId:
                input.connectionId ??
                dataSource.query?.connectionId?.toString(),
            });
            if (accessError) return { success: false, error: accessError };
          }

          const definitionChanged =
            edit.code !== (dataSource.query?.code ?? "") ||
            (input.connectionId !== undefined &&
              input.connectionId !==
                dataSource.query?.connectionId?.toString()) ||
            (input.language !== undefined &&
              input.language !== dataSource.query?.language) ||
            (input.databaseId !== undefined &&
              input.databaseId !== dataSource.query?.databaseId) ||
            (input.databaseName !== undefined &&
              input.databaseName !== dataSource.query?.databaseName);

          // Apply — shallow-merge non-code fields, same as the browser leg.
          dataSource.query.code = edit.code;
          if (input.connectionId !== undefined) {
            dataSource.query.connectionId = new Types.ObjectId(
              input.connectionId,
            );
          }
          if (input.language !== undefined) {
            dataSource.query.language = input.language;
          }
          if (input.databaseId !== undefined) {
            dataSource.query.databaseId = input.databaseId;
          }
          if (input.databaseName !== undefined) {
            dataSource.query.databaseName = input.databaseName;
          }
          if (input.name !== undefined) {
            dataSource.name = input.name;
          }
          if (input.timeDimension !== undefined) {
            dataSource.timeDimension = input.timeDimension;
          }
          if (input.rowLimit !== undefined) {
            dataSource.rowLimit = input.rowLimit;
          }
          dataSource.materialization = nextMaterialization;
          if (scheduleChanged) {
            doc.materializationSchedule = nextSchedule;
          }
          doc.markModified("dataSources");
          // Version bump so open tabs treat the realtime poke as newer and
          // pull the updated definition; UI saves against the old version
          // will conflict and reload, as with any concurrent edit.
          doc.version = (doc.version ?? 1) + 1;
          await doc.save();

          publishRealtimeEvent(workspaceId, {
            type: "dashboard.updated",
            dashboardId: doc._id.toString(),
            version: doc.version,
            updatedBy: userId ?? "agent",
            clientId: agentClientId,
            origin: "agent",
          });

          // Definition/materialization changes (or an explicit run) rebuild
          // the parquet artifact server-side. Schedule-only changes don't
          // touch the artifact — the schedule itself will refresh it.
          let refreshQueued = false;
          if (
            nextMaterialization === "parquet" &&
            (definitionChanged || materializationChanged || input.run === true)
          ) {
            await queueDashboardArtifactRefresh({
              workspaceId,
              dashboardId: doc._id.toString(),
              dataSourceIds: [dataSource.id],
              force: true,
              triggerType: "manual",
            }).catch(() => undefined);
            refreshQueued = true;
          }

          const scheduleHint = scheduleChanged
            ? nextSchedule?.enabled
              ? ` Dashboard auto-refresh schedule: ${nextSchedule.cron} (${nextSchedule.timezone}) — one schedule refreshes all parquet sources.`
              : " Dashboard auto-refresh schedule is off."
            : "";
          return {
            success: true,
            dataSourceId: dataSource.id,
            state: "definition_updated" as const,
            materialization: nextMaterialization,
            ...(scheduleChanged || input.materializationSchedule !== undefined
              ? { materializationSchedule: nextSchedule }
              : {}),
            refreshQueued,
            version: doc.version,
            message:
              (definitionChanged || materializationChanged
                ? refreshQueued
                  ? `Updated "${dataSource.name}"; a parquet artifact rebuild was queued.`
                  : `Updated "${dataSource.name}". Live sources run fresh on the next dashboard load.`
                : `Updated "${dataSource.name}".`) + scheduleHint,
          };
        }),
    }),
  };
}
