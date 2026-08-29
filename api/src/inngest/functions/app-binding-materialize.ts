/**
 * Background materialization of React App data bindings.
 *
 * Triggered by `app/binding.materialize` (sent from
 * `queueAppBindingMaterialization`). Runs the query + Parquet build off the
 * request path so the HTTP endpoint (and the agent's `materialize_binding`
 * tool) returns immediately and the build survives client disconnects.
 */
import { RetryAfterError } from "inngest";
import { inngest } from "../client";
import { MakoApp } from "../../database/workspace-schema";
import {
  materializeAppBinding,
  queueAppBindingMaterialization,
} from "../../services/app-binding-materialization.service";
import { isDashboardMaterializationDue } from "../../services/dashboard-materialization-schedule.service";
import {
  APP_BINDING_REFRESH_CONCURRENCY_MAX,
  countBuildingAppBindings,
  getWorkspaceAppBindingRefreshConcurrency,
  shouldDeferAppBindingRefresh,
} from "../../services/workspace-refresh-limits.service";
import { loggers } from "../../logging";

const log = loggers.inngest();

export const appBindingMaterializeFunction = inngest.createFunction(
  {
    id: "app-binding-materialize",
    name: "Materialize App Data Binding",
    concurrency: [
      {
        scope: "fn",
        // Hard ceiling per workspace. Effective limit is
        // Workspace.settings.appBindingRefreshConcurrency (enforced below).
        key: "event.data.workspaceId",
        limit: APP_BINDING_REFRESH_CONCURRENCY_MAX,
      },
      {
        // One build per binding at a time; the cache heartbeat dedupes at queue
        // time, this guards against duplicate events.
        scope: "fn",
        key: "event.data.dedupeKey",
        limit: 1,
      },
    ],
    retries: 2,
  },
  { event: "app/binding.materialize" },
  async ({ event, step }) => {
    const { workspaceId, appId, bindingId, force } = event.data as {
      workspaceId: string;
      appId: string;
      bindingId: string;
      force?: boolean;
    };

    // Must throw outside step.run so Inngest releases concurrency for RetryAfterError.
    const gate = await shouldDeferAppBindingRefresh({
      workspaceId,
      appId,
      bindingId,
    });
    if (gate.defer) {
      log.info("Deferring app binding refresh: workspace concurrency full", {
        workspaceId,
        appId,
        bindingId,
        activeOthers: gate.activeOthers,
        limit: gate.limit,
      });
      throw new RetryAfterError(
        `Workspace app binding refresh concurrency limit (${gate.limit})`,
        "30s",
      );
    }

    const result = await step.run("materialize-binding", async () => {
      return await materializeAppBinding({
        workspaceId,
        appId,
        bindingId,
        force,
      });
    });

    if (result.status === "error") {
      // The error is already persisted on the binding cache + history; query
      // errors are not transient, so don't throw (which would trigger retries).
      log.warn("App binding materialization finished with error", {
        workspaceId,
        appId,
        bindingId,
        error: result.error,
      });
    } else {
      log.info("App binding materialization complete", {
        workspaceId,
        appId,
        bindingId,
        rowCount: result.rowCount,
        byteSize: result.byteSize,
      });
    }

    return result;
  },
);

export const appBindingSchedulerFunction = inngest.createFunction(
  {
    id: "scheduled-app-binding-refresh",
    name: "Scheduled App Data Source Refresh",
  },
  { cron: "* * * * *" },
  async ({ step }) => {
    const apps = (await step.run("find-stale-app-bindings", async () => {
      return MakoApp.find({
        // An app migrated to Apps v2 has its schedules refreshed by the v2
        // scheduler (from `-- schedule:` front matter in git). Running both
        // would double every warehouse query for the same data.
        migratedToV2ProjectId: { $exists: false },
        dataBindings: {
          $elemMatch: {
            materialization: "parquet",
            "materializationSchedule.enabled": true,
            "materializationSchedule.cron": { $type: "string", $ne: "" },
          },
        },
      }).select("_id workspaceId dataBindings");
    })) as any[];

    let triggered = 0;
    let deferred = 0;
    const triggeredByWorkspace = new Map<string, number>();
    const limitByWorkspace = new Map<string, number>();
    const buildingByWorkspace = new Map<string, number>();

    for (const app of apps) {
      const workspaceId = app.workspaceId?.toString();
      if (!workspaceId) continue;

      for (const binding of app.dataBindings || []) {
        if (binding.materialization !== "parquet") continue;
        const schedule = binding.materializationSchedule;
        if (!schedule?.enabled || !schedule.cron) continue;

        let isDue = false;
        try {
          isDue = isDashboardMaterializationDue({
            schedule,
            lastRefreshedAt:
              binding.cache?.lastRefreshedAt ??
              binding.cache?.parquetBuiltAt ??
              null,
          });
        } catch (error) {
          log.warn(
            "Skipping app binding with invalid materialization schedule",
            {
              error,
              appId: app._id.toString(),
              bindingId: binding.id,
            },
          );
          continue;
        }

        if (!isDue) continue;

        if (!limitByWorkspace.has(workspaceId)) {
          limitByWorkspace.set(
            workspaceId,
            await getWorkspaceAppBindingRefreshConcurrency(workspaceId),
          );
          buildingByWorkspace.set(
            workspaceId,
            await countBuildingAppBindings(workspaceId),
          );
        }

        const limit = limitByWorkspace.get(workspaceId) ?? 2;
        const building = buildingByWorkspace.get(workspaceId) ?? 0;
        const alreadyTriggered = triggeredByWorkspace.get(workspaceId) ?? 0;
        if (building + alreadyTriggered >= limit) {
          deferred++;
          continue;
        }

        await step.run(
          `queue-binding-${app._id.toString()}-${binding.id}`,
          () =>
            queueAppBindingMaterialization({
              workspaceId,
              appId: app._id.toString(),
              bindingId: binding.id,
              force: true,
            }),
        );
        triggeredByWorkspace.set(workspaceId, alreadyTriggered + 1);
        triggered++;
      }
    }

    log.info("App binding scheduler run", {
      total: apps.length,
      triggered,
      deferred,
    });

    return { total: apps.length, triggered, deferred };
  },
);
