/**
 * Background materialization of React App data bindings.
 *
 * Triggered by `app/binding.materialize` (sent from
 * `queueAppBindingMaterialization`). Runs the query + Parquet build off the
 * request path so the HTTP endpoint (and the agent's `materialize_binding`
 * tool) returns immediately and the build survives client disconnects.
 */
import { inngest } from "../client";
import { materializeAppBinding } from "../../services/app-binding-materialization.service";
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
