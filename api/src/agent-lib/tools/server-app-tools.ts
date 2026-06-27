/**
 * Server-side React App tools (issue #475 pattern, extended to apps)
 *
 * App mutation tools (write/delete/rename file, add/remove dependency,
 * create/delete data binding) execute on the API against the authoritative
 * MakoApp document instead of in the browser. Like the console server tools,
 * the agent becomes "just another writer": every mutation persists to Mongo and
 * pokes the workspace realtime channel so open tabs refresh live — and a
 * detached chat (mobile lock / computer sleep) keeps working end-to-end because
 * the write no longer depends on a connected browser.
 *
 * Browser-only legs stay client-side: `run_app` (preview rebuild) and
 * `materialize_binding` (DuckDB-WASM materialization), plus the cheap reads
 * `list_open_apps` / `open_app` / `get_app_state` / `app_read_file`.
 *
 * Tool schemas live in @mako/agent-tools (shared with the app's tool cards).
 */
import { tool } from "ai";
import { Types } from "mongoose";
import { nanoid } from "nanoid";
import {
  writeFileSchema,
  deleteFileSchema,
  renameFileSchema,
  addDependencySchema,
  removeDependencySchema,
  createDataBindingSchema,
  deleteDataBindingSchema,
  saveAppVersionSchema,
  restoreAppVersionSchema,
} from "@mako/agent-tools";
import { normalizeAppFiles } from "@mako/schemas";
import {
  MakoApp,
  DatabaseConnection,
  type IMakoApp,
} from "../../database/workspace-schema";
import { workspaceService } from "../../services/workspace.service";
import { publishRealtimeEvent } from "../../services/realtime.service";
import {
  createVersion,
  getVersion,
  getUserDisplayName,
} from "../../services/entity-version.service";
import {
  buildAppSnapshot,
  applyAppSnapshot,
  type AppSnapshot,
} from "../../services/app-version.service";
import { canReadResource, canWriteResource } from "../../utils/resource-acl";
import { loggers } from "../../logging";

const logger = loggers.agent();

export interface ServerAppToolsOptions {
  workspaceId: string;
  /** Acting user (session user id, or API-key creator). */
  userId?: string;
  /** Chat driving this turn — used as the realtime echo-suppression id. */
  chatId?: string;
}

type LoadResult = { doc: IMakoApp } | { error: string };

function isLoadError(r: LoadResult): r is { error: string } {
  return (r as { error?: string }).error !== undefined;
}

export function createServerAppTools({
  workspaceId,
  userId,
  chatId,
}: ServerAppToolsOptions) {
  const agentClientId = `agent:${chatId ?? "unknown"}`;

  const loadApp = async (appId: string): Promise<LoadResult> => {
    if (!appId) {
      return {
        error: "appId is required. Use list_open_apps to find app IDs.",
      };
    }
    if (!Types.ObjectId.isValid(appId)) {
      return { error: `Invalid app ID: ${appId}` };
    }
    const doc = await MakoApp.findOne({
      _id: new Types.ObjectId(appId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!doc) {
      return {
        error: `App ${appId} not found. Use list_open_apps to see available apps.`,
      };
    }
    if (userId && !canReadResource(doc, userId, await memberRole())) {
      return {
        error: `App ${appId} not found. Use list_open_apps to see available apps.`,
      };
    }
    return { doc };
  };

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

  const canWrite = async (doc: IMakoApp): Promise<boolean> => {
    if (!userId) return true; // workspace-scoped API-key automation
    return canWriteResource(doc, userId, await memberRole());
  };

  // Display name stamped on version checkpoints the agent creates.
  const savedByName = async (): Promise<string> =>
    userId ? await getUserDisplayName(userId) : "Agent";

  // Persist a mutated app doc, then poke the workspace channel so open tabs
  // pull the new definition and rebuild their preview.
  const saveAndPublish = async (doc: IMakoApp): Promise<number> => {
    doc.version += 1;
    await doc.save();
    publishRealtimeEvent(workspaceId, {
      type: "app.updated",
      appId: doc._id.toString(),
      version: doc.version,
      updatedBy: userId ?? "agent",
      clientId: agentClientId,
      origin: "agent",
    });
    return doc.version;
  };

  // Validate that a data-binding connection belongs to this workspace.
  const validateConnection = async (
    connectionId: string | undefined,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!connectionId) return { ok: true };
    if (!Types.ObjectId.isValid(connectionId)) {
      return { ok: false, error: `Invalid connectionId: ${connectionId}` };
    }
    const found = await DatabaseConnection.countDocuments({
      _id: new Types.ObjectId(connectionId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    return found > 0
      ? { ok: true }
      : { ok: false, error: "Data binding connection is invalid" };
  };

  const denied = (appId: string) => ({
    success: false as const,
    error: `You do not have write access to app ${appId}.`,
  });

  const wrap = async <T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | { success: false; error: string }> => {
    try {
      return await fn();
    } catch (error) {
      logger.warn(`Server app tool failed: ${label}`, { error, workspaceId });
      return {
        success: false,
        error: error instanceof Error ? error.message : `Failed: ${label}`,
      };
    }
  };

  return {
    app_write_file: tool({
      description:
        "Create or overwrite a file with full contents. This is the primary " +
        "editing tool — write the complete file, not a diff. Writing the " +
        "entrypoint or any imported file refreshes the live preview.",
      inputSchema: writeFileSchema,
      execute: async ({ appId, path, contents }) =>
        wrap("app_write_file", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          doc.files = normalizeAppFiles([
            ...(doc.files ?? []).filter(f => f.path !== path),
            { path, contents: contents ?? "" },
          ]) as IMakoApp["files"];
          const version = await saveAndPublish(doc);
          return { success: true, path, version };
        }),
    }),

    app_delete_file: tool({
      description: "Delete a file from the app.",
      inputSchema: deleteFileSchema,
      execute: async ({ appId, path }) =>
        wrap("app_delete_file", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          doc.files = (doc.files ?? []).filter(
            f => f.path !== path,
          ) as IMakoApp["files"];
          const version = await saveAndPublish(doc);
          return { success: true, path, version };
        }),
    }),

    app_rename_file: tool({
      description: "Rename/move a file within the app.",
      inputSchema: renameFileSchema,
      execute: async ({ appId, from, to }) =>
        wrap("app_rename_file", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          const file = (doc.files ?? []).find(f => f.path === from);
          if (!file) {
            return { success: false, error: `File not found: ${from}` };
          }
          doc.files = normalizeAppFiles([
            ...(doc.files ?? []).filter(f => f.path !== from && f.path !== to),
            { path: to, contents: file.contents },
          ]) as IMakoApp["files"];
          if (doc.entrypoint === from) doc.entrypoint = to;
          const version = await saveAndPublish(doc);
          return { success: true, from, to, version };
        }),
    }),

    app_add_dependency: tool({
      description:
        "Add an npm dependency to the app (e.g. d3, framer-motion, recharts). " +
        "The dependency becomes importable from app code on the next preview build.",
      inputSchema: addDependencySchema,
      execute: async ({ appId, name, version: depVersion }) =>
        wrap("app_add_dependency", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          doc.dependencies = {
            ...(doc.dependencies ?? {}),
            [name]: depVersion || "latest",
          };
          const version = await saveAndPublish(doc);
          return { success: true, name, version };
        }),
    }),

    app_remove_dependency: tool({
      description: "Remove an npm dependency from the app.",
      inputSchema: removeDependencySchema,
      execute: async ({ appId, name }) =>
        wrap("app_remove_dependency", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          const next = { ...(doc.dependencies ?? {}) };
          delete next[name];
          doc.dependencies = next;
          const version = await saveAndPublish(doc);
          return { success: true, name, version };
        }),
    }),

    app_create_data_binding: tool({
      description:
        "Create a named data binding that the app can read via useQuery(name) " +
        "from '@mako/app-sdk'. The query runs server-side, scoped to the " +
        "workspace — the app never sees credentials. Set materialization to " +
        "'parquet' for DuckDB-WASM-backed analytics (then call materialize_binding). " +
        "Use the SQL connections/tools to inspect schema and validate the query first.",
      inputSchema: createDataBindingSchema,
      execute: async input =>
        wrap("app_create_data_binding", async () => {
          const loaded = await loadApp(input.appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(input.appId);
          const connCheck = await validateConnection(input.connectionId);
          if (!connCheck.ok) return { success: false, error: connCheck.error };
          const materialization =
            input.materialization === "parquet" ? "parquet" : "live";
          const created = {
            id: nanoid(10),
            name: input.name,
            connectionId: input.connectionId,
            language: input.language || "sql",
            code: input.code,
            databaseId: input.databaseId,
            databaseName: input.databaseName,
            materialization,
            cache: undefined,
          };
          // Replace any existing binding with the same name (mirrors the client
          // addDataBinding semantics).
          doc.dataBindings = [
            ...(doc.dataBindings ?? []).filter(b => b.name !== created.name),
            created,
          ] as IMakoApp["dataBindings"];
          const version = await saveAndPublish(doc);
          return {
            success: true,
            binding: { name: created.name, materialization },
            version,
            hint:
              materialization === "parquet"
                ? `Call materialize_binding for "${created.name}", then read it with useQuery("${created.name}") or run analytics with useDuckDB(sql) from '@mako/app-sdk'.`
                : `Read it in app code with useQuery("${created.name}") from '@mako/app-sdk'.`,
          };
        }),
    }),

    app_delete_data_binding: tool({
      description:
        "Delete a named data binding (data source) from the app. Use this to " +
        "clean up orphaned or superseded bindings. Removes the binding from the " +
        "app definition and persists the change. Confirm the binding name with " +
        "list_data_sources first; the change is reflected there afterward.",
      inputSchema: deleteDataBindingSchema,
      execute: async ({ appId, name }) =>
        wrap("app_delete_data_binding", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          const exists = (doc.dataBindings ?? []).some(b => b.name === name);
          if (!exists) {
            return { success: false, error: `No data binding named "${name}"` };
          }
          doc.dataBindings = (doc.dataBindings ?? []).filter(
            b => b.name !== name,
          ) as IMakoApp["dataBindings"];
          const version = await saveAndPublish(doc);
          const remaining = (doc.dataBindings ?? []).map(b => b.name);
          return { success: true, deleted: name, remaining, version };
        }),
    }),

    app_save_version: tool({
      description:
        "Save a named checkpoint of the app's current state to its version " +
        "history. Apps autosave on every edit, so use this to mark meaningful " +
        "milestones (before a risky refactor, after finishing a feature) that " +
        "the user can review or restore later. Returns the new version number.",
      inputSchema: saveAppVersionSchema,
      execute: async ({ appId, comment }) =>
        wrap("app_save_version", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          const created = await createVersion({
            entityType: "app",
            entityId: doc._id,
            workspaceId: new Types.ObjectId(workspaceId),
            snapshot: buildAppSnapshot(doc) as unknown as Record<
              string,
              unknown
            >,
            savedBy: userId ?? "agent",
            savedByName: await savedByName(),
            comment: (comment ?? "").slice(0, 500),
          });
          return {
            success: true,
            version: created.version,
            createdAt: created.createdAt,
          };
        }),
    }),

    app_restore_version: tool({
      description:
        "Restore the app to a previous version from its history (get the " +
        "version number from browse_version_history). The current state is " +
        "first preserved as a new checkpoint, so restoring is never lossy. " +
        "Open tabs reload the reverted app automatically.",
      inputSchema: restoreAppVersionSchema,
      execute: async ({ appId, version, comment }) =>
        wrap("app_restore_version", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          const old = await getVersion(
            appId,
            "app",
            version,
            new Types.ObjectId(workspaceId),
          );
          if (!old) {
            return { success: false, error: `Version ${version} not found` };
          }
          applyAppSnapshot(doc, old.snapshot as unknown as AppSnapshot);
          const newVersion = await saveAndPublish(doc);
          await createVersion({
            entityType: "app",
            entityId: doc._id,
            workspaceId: new Types.ObjectId(workspaceId),
            snapshot: buildAppSnapshot(doc) as unknown as Record<
              string,
              unknown
            >,
            savedBy: userId ?? "agent",
            savedByName: await savedByName(),
            comment: (comment ?? `Restored from version ${version}`).slice(
              0,
              500,
            ),
            restoredFrom: version,
          });
          return {
            success: true,
            restoredFrom: version,
            version: newVersion,
          };
        }),
    }),
  };
}
