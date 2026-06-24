/**
 * Background materialization of React App data bindings.
 *
 * Triggered by `app/binding.materialize` (sent from
 * `queueAppBindingMaterialization`). Runs the query + Parquet build off the
 * request path so the HTTP endpoint (and the agent's `materialize_binding`
 * tool) returns immediately and the build survives client disconnects.
 */
import { inngest } from "../client";
import { MakoApp } from "../../database/workspace-schema";
import {
  materializeAppBinding,
  queueAppBindingMaterialization,
} from "../../services/app-binding-materialization.service";
import { isDashboardMaterializationDue } from "../../services/dashboard-materialization-schedule.service";
import { loggers } from "../../logging";

const log = loggers.inngest();

export const appBindingMaterializeFunction = inngest.createFunction(
  {
    id: "app-binding-materialize",
    name: "Materialize App Data Binding",
    // One build per binding at a time; the cache heartbeat dedupes at queue
    // time, this guards against duplicate events.
    concurrency: {
      limit: 1,
      key: "event.data.dedupeKey",
    },
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

    for (const app of apps) {
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
          log.warn("Skipping app binding with invalid materialization schedule", {
            error,
            appId: app._id.toString(),
            bindingId: binding.id,
          });
          continue;
        }

        if (!isDue) continue;

        await step.run(`queue-binding-${app._id.toString()}-${binding.id}`, () =>
          queueAppBindingMaterialization({
            workspaceId: app.workspaceId.toString(),
            appId: app._id.toString(),
            bindingId: binding.id,
            force: true,
          }),
        );
        triggered++;
      }
    }

    log.info("App binding scheduler run", {
      total: apps.length,
      triggered,
    });

    return { total: apps.length, triggered };
  },
);
