/**
 * Process runtime bootstrap. `ensureProcessRuntime()` is idempotent and is
 * called by the routes and the Inngest functions before they touch the
 * runtime; tests call `setRuntimeDeps` / `setExecutionEngine` directly.
 *
 * PROCESS_ENGINE=local runs processes in-process (no Inngest dev server
 * needed; timers are not durable). Default: inngest.
 */
import { Types } from "mongoose";
import {
  DatabaseConnection,
  SourceConnection,
} from "../database/workspace-schema";
import { getDefaultModelId } from "../agent-lib/ai-models";
import { aiSdkHarness } from "./agents/ai-sdk-harness";
import { setRuntimeDeps } from "./runtime/deps";
import {
  LocalEngine,
  setExecutionEngine,
  type ExecutionEngine,
} from "./runtime/engine";
import { InngestEngine } from "./runtime/inngest-engine";

let configured = false;

export function ensureProcessRuntime(): void {
  if (configured) return;
  configured = true;
  const harness = aiSdkHarness();
  setRuntimeDeps({
    defaultHarness: () => harness,
    defaultModel: () => getDefaultModelId(),
    now: () => new Date(),
    async resolveConnection(workspaceId, connectionId) {
      const scope = {
        _id: new Types.ObjectId(connectionId),
        workspaceId: new Types.ObjectId(workspaceId),
      };
      const database = await DatabaseConnection.findOne(scope)
        .select("name type")
        .lean();
      if (database) {
        return {
          id: connectionId,
          kind: "database",
          type: String(database.type),
          name: String(database.name),
        };
      }
      const source = await SourceConnection.findOne(scope)
        .select("name type")
        .lean();
      if (source) {
        return {
          id: connectionId,
          kind: "source",
          type: String(source.type),
          name: String(source.name),
        };
      }
      throw new Error(
        `Bound connection ${connectionId} not found in this workspace`,
      );
    },
  });
  const engine: ExecutionEngine =
    process.env.PROCESS_ENGINE === "local"
      ? new LocalEngine()
      : new InngestEngine();
  setExecutionEngine(engine);
}

/** Tests: allow re-configuration after injecting doubles. */
export function markProcessRuntimeConfigured(): void {
  configured = true;
}
