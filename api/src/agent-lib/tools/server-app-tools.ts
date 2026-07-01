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
 * Apps are now FULLY server-authoritative: not just the writes, but listing,
 * creating, reading/inspecting, and materializing bindings all run against the
 * MakoApp document here, so a headless / detached agent can build and operate
 * an app end-to-end with no browser.
 *
 * The only browser-only leg is `run_app` (rebuild the sandboxed-iframe preview
 * and read render/build errors); `open_app` is a pure UI tab-focus convenience.
 * A headless agent skips both and works on the appId directly.
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
  listAppsSchema,
  createAppSchema,
  getAppStateSchema,
  appReadFileSchema,
  materializeBindingSchema,
  setBindingScheduleSchema,
  setBindingMaterializationSchema,
} from "@mako/agent-tools";
import { normalizeAppFiles, createAppScaffold } from "@mako/schemas";
import { validateDashboardMaterializationSchedule } from "../../services/dashboard-materialization-schedule.service";
import {
  MakoApp,
  DatabaseConnection,
  type IMakoApp,
} from "../../database/workspace-schema";
import {
  queueAppBindingMaterialization,
  buildAppBindingMaterializationStatus,
} from "../../services/app-binding-materialization.service";
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

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  return {
    list_open_apps: tool({
      description:
        "List the apps in this workspace (id, title, file count, and data " +
        "binding names). Call this FIRST to discover app IDs before using other " +
        "app tools. Returns all apps you can access — not just ones open in a UI " +
        "tab — so it works headlessly.",
      inputSchema: listAppsSchema,
      execute: async () =>
        wrap("list_open_apps", async () => {
          const filter: Record<string, unknown> = {
            workspaceId: new Types.ObjectId(workspaceId),
          };
          if (userId) {
            filter.$or = [
              { owner_id: userId },
              { access: "workspace" },
              { "sharedWith.userId": userId },
            ];
          }
          const docs = await MakoApp.find(filter)
            .sort({ updatedAt: -1 })
            .limit(100)
            .lean<IMakoApp[]>();
          return {
            success: true,
            apps: docs.map(d => ({
              id: d._id.toString(),
              title: d.title,
              fileCount: Array.isArray(d.files) ? d.files.length : 0,
              dataBindings: (d.dataBindings ?? []).map(b => ({
                name: b.name,
                language: b.language,
                materialization: b.materialization ?? "live",
              })),
            })),
          };
        }),
    }),

    create_app: tool({
      description:
        "Create a new React app from the default scaffold (React + TypeScript) " +
        "and return its appId. Then use app_write_file to build features and " +
        "app_add_dependency to add libraries. (In an attached browser, call " +
        "open_app afterward to focus the new app's tab.)",
      inputSchema: createAppSchema,
      execute: async ({ title, description }) =>
        wrap("create_app", async () => {
          const scaffold = createAppScaffold(title || "Untitled App");
          const created = await MakoApp.create({
            workspaceId: new Types.ObjectId(workspaceId),
            title: scaffold.title,
            description: description ?? scaffold.description,
            template: scaffold.template,
            runtime: scaffold.runtime,
            entrypoint: scaffold.entrypoint,
            files: normalizeAppFiles(scaffold.files),
            dependencies: scaffold.dependencies,
            dataBindings: [],
            access: "private",
            owner_id: userId,
            createdBy: userId ?? "agent",
            version: 1,
          });
          // Seed an initial published version (v1) so the app has version
          // history from creation (mirrors consoles/dashboards + the REST route).
          const initialSnapshot = buildAppSnapshot(created);
          const initialVersion = await createVersion({
            entityType: "app",
            entityId: created._id,
            workspaceId: new Types.ObjectId(workspaceId),
            snapshot: initialSnapshot as unknown as Record<string, unknown>,
            savedBy: userId ?? "agent",
            savedByName: await savedByName(),
            comment: "App created",
          });
          created.published = initialSnapshot as unknown as Record<
            string,
            unknown
          >;
          created.markModified("published");
          created.publishedVersion = initialVersion.version;
          created.publishedAt = new Date();
          await created.save();
          // Poke the workspace so an attached browser's Apps explorer picks up
          // the new app without a manual reload (browser follows the server).
          publishRealtimeEvent(workspaceId, {
            type: "app.updated",
            appId: created._id.toString(),
            version: created.version,
            updatedBy: userId ?? "agent",
            clientId: agentClientId,
            origin: "agent",
          });
          return {
            success: true,
            appId: created._id.toString(),
            title: created.title,
            files: created.files.map(f => f.path),
          };
        }),
    }),

    get_app_state: tool({
      description:
        "Get the app definition from the server: file list (paths), dependencies, " +
        "data bindings, entrypoint, runtime, and version/publish state. Use this " +
        "to understand the project before editing. NOTE: live preview build/" +
        "runtime errors are only available in an attached browser via run_app.",
      inputSchema: getAppStateSchema,
      execute: async ({ appId }) =>
        wrap("get_app_state", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          return {
            success: true,
            appId,
            title: doc.title,
            runtime: doc.runtime,
            entrypoint: doc.entrypoint,
            version: doc.version,
            publishedVersion: doc.publishedVersion,
            files: (doc.files ?? []).map(f => f.path),
            dependencies: doc.dependencies ?? {},
            dataBindings: (doc.dataBindings ?? []).map(b => ({
              name: b.name,
              connectionId: b.connectionId,
              language: b.language,
              code: b.code,
              materialization: b.materialization ?? "live",
            })),
          };
        }),
    }),

    app_read_file: tool({
      description: "Read the full contents of a single file in the app.",
      inputSchema: appReadFileSchema,
      execute: async ({ appId, path }) =>
        wrap("app_read_file", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const file = (loaded.doc.files ?? []).find(f => f.path === path);
          if (!file) {
            return { success: false, error: `File not found: ${path}` };
          }
          return { success: true, path: file.path, contents: file.contents };
        }),
    }),

    materialize_binding: tool({
      description:
        "Build (or rebuild) the Parquet artifact for a 'parquet' data binding. " +
        "The build runs server-side in the background; this tool waits up to " +
        "waitSeconds (default 120, max 600) and returns status 'building' if it " +
        "is still running — call again to keep waiting, or use waitSeconds: 0 " +
        "for an instant status check. Apps with an attached browser refresh " +
        "automatically when the build is ready.",
      inputSchema: materializeBindingSchema,
      execute: async ({ appId, name, waitSeconds }) =>
        wrap("materialize_binding", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          if (!(await canWrite(loaded.doc))) return denied(appId);
          const binding = (loaded.doc.dataBindings ?? []).find(
            b => b.name === name,
          );
          if (!binding) {
            return { success: false, error: `No data binding named "${name}"` };
          }
          if (binding.materialization !== "parquet") {
            return {
              success: false,
              error:
                `Binding "${name}" is 'live', not 'parquet' — nothing to ` +
                "materialize. Switch it in place with " +
                "app_set_binding_materialization (materialization: 'parquet'), " +
                "then call materialize_binding again. Do not delete/recreate it.",
            };
          }
          const queued = await queueAppBindingMaterialization({
            workspaceId,
            appId,
            bindingId: binding.id,
          });
          const waitMs = Math.min(Math.max(waitSeconds ?? 120, 0), 600) * 1000;
          const deadline = Date.now() + waitMs;
          let status: string = queued.status;
          // Poll the doc until the background build terminates or the wait
          // elapses (the build keeps running server-side either way).
          while (
            (status === "queued" || status === "building") &&
            Date.now() < deadline
          ) {
            await sleep(2500);
            const fresh = await MakoApp.findById(loaded.doc._id);
            const st = fresh
              ? buildAppBindingMaterializationStatus(fresh, binding.id)
              : null;
            if (!st) break;
            status = st.status;
          }
          if (status === "ready") {
            // Bump version + poke so an attached browser reloads the artifact
            // into its DuckDB instance (headless callers ignore this).
            const bumped = await MakoApp.findByIdAndUpdate(
              loaded.doc._id,
              { $inc: { version: 1 } },
              { new: true },
            );
            publishRealtimeEvent(workspaceId, {
              type: "app.updated",
              appId,
              version: bumped?.version ?? loaded.doc.version + 1,
              updatedBy: userId ?? "agent",
              clientId: agentClientId,
              origin: "agent",
            });
            return {
              success: true,
              binding: { name, status: "ready" },
              hint: `Materialized. Read it with useQuery("${name}") or useDuckDB(sql).`,
            };
          }
          if (status === "error") {
            return {
              success: false,
              binding: { name },
              status: "error",
              error: "Materialization failed. Check the binding query.",
            };
          }
          return {
            success: true,
            binding: { name },
            status: "building",
            hint:
              `Materialization of "${name}" is still running in the background. ` +
              "Call materialize_binding again to keep waiting.",
          };
        }),
    }),

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
          // Validate the optional schedule (cron) the same way the HTTP routes
          // do. Live bindings can't be scheduled, so force it disabled.
          let materializationSchedule;
          if (input.materializationSchedule) {
            try {
              materializationSchedule =
                validateDashboardMaterializationSchedule(
                  materialization === "parquet"
                    ? input.materializationSchedule
                    : { ...input.materializationSchedule, enabled: false },
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
          }
          const created = {
            id: nanoid(10),
            name: input.name,
            connectionId: input.connectionId,
            language: input.language || "sql",
            code: input.code,
            databaseId: input.databaseId,
            databaseName: input.databaseName,
            materialization,
            materializationSchedule,
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

    app_set_binding_schedule: tool({
      description:
        "Set or clear the materialization schedule on an existing 'parquet' " +
        "data binding so its artifact auto-refreshes on a cron. Use this when " +
        "the user wants a data source to refresh periodically (e.g. hourly or " +
        "daily) instead of only on demand. Pass enabled:false to turn the " +
        "schedule off. The binding must be 'parquet' (live bindings always run " +
        "fresh and can't be scheduled). Confirm the name with list_data_sources.",
      inputSchema: setBindingScheduleSchema,
      execute: async ({
        appId,
        name,
        enabled,
        cron,
        timezone,
        dataFreshnessTtlMs,
      }) =>
        wrap("app_set_binding_schedule", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          const binding = (doc.dataBindings ?? []).find(b => b.name === name);
          if (!binding) {
            return { success: false, error: `No data binding named "${name}"` };
          }
          if (binding.materialization !== "parquet") {
            return {
              success: false,
              error:
                `Binding "${name}" is 'live'. Switch it to 'parquet' in place ` +
                "with app_set_binding_materialization before scheduling " +
                "refreshes. Do not delete/recreate it.",
            };
          }
          let schedule;
          try {
            schedule = validateDashboardMaterializationSchedule({
              enabled,
              cron: cron ?? null,
              timezone,
              dataFreshnessTtlMs,
            });
          } catch (error) {
            return {
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Invalid materialization schedule",
            };
          }
          binding.materializationSchedule = schedule;
          doc.markModified("dataBindings");
          const version = await saveAndPublish(doc);
          return {
            success: true,
            binding: { name, materializationSchedule: schedule },
            version,
            hint: schedule.enabled
              ? `"${name}" will auto-refresh on schedule (${schedule.cron}, ${schedule.timezone}). Scheduled refresh runs in production; in local dev trigger it with materialize_binding.`
              : `Scheduled refresh for "${name}" is now off.`,
          };
        }),
    }),

    app_set_binding_materialization: tool({
      description:
        "Switch an EXISTING data binding between 'live' and 'parquet' " +
        "materialization IN PLACE — do NOT delete and recreate a binding just " +
        "to change this. Use this when the user asks to materialize / cache a " +
        "binding, or to turn materialization back off. Preserves the binding's " +
        "id, code, and connection. After switching to 'parquet', call " +
        "materialize_binding to build the artifact. Confirm the name with " +
        "list_data_sources.",
      inputSchema: setBindingMaterializationSchema,
      execute: async ({
        appId,
        name,
        materialization,
        materializationSchedule,
      }) =>
        wrap("app_set_binding_materialization", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          const binding = (doc.dataBindings ?? []).find(b => b.name === name);
          if (!binding) {
            return { success: false, error: `No data binding named "${name}"` };
          }
          const next = materialization === "parquet" ? "parquet" : "live";
          // Validate the optional schedule the same way create/schedule do.
          // Live bindings can't be scheduled, so force it disabled.
          let schedule = binding.materializationSchedule;
          if (materializationSchedule) {
            try {
              schedule = validateDashboardMaterializationSchedule(
                next === "parquet"
                  ? materializationSchedule
                  : { ...materializationSchedule, enabled: false },
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
          } else if (next === "live" && schedule?.enabled) {
            // Turning materialization off implicitly disables any schedule.
            schedule = { ...schedule, enabled: false };
          }
          binding.materialization = next;
          binding.materializationSchedule = schedule;
          doc.markModified("dataBindings");
          const version = await saveAndPublish(doc);
          return {
            success: true,
            binding: { name, materialization: next },
            version,
            hint:
              next === "parquet"
                ? `"${name}" is now 'parquet'. Call materialize_binding for "${name}" to build the artifact, then read it with useQuery("${name}") or useDuckDB(sql).`
                : `"${name}" is now 'live' — it runs fresh on every read via useQuery("${name}").`,
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
        "Save AND publish a version of the app's current state. Apps autosave " +
        "the working draft on every edit; saving a version snapshots it into " +
        "version history AND publishes that snapshot — it becomes the definition " +
        "public/shared viewers render. Use it to mark meaningful milestones " +
        "(after finishing a feature, before a risky refactor) and to push work " +
        "live to viewers. Returns the new version number.",
      inputSchema: saveAppVersionSchema,
      execute: async ({ appId, comment }) =>
        wrap("app_save_version", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          const snapshot = buildAppSnapshot(doc);
          const created = await createVersion({
            entityType: "app",
            entityId: doc._id,
            workspaceId: new Types.ObjectId(workspaceId),
            snapshot: snapshot as unknown as Record<string, unknown>,
            savedBy: userId ?? "agent",
            savedByName: await savedByName(),
            comment: (comment ?? "").slice(0, 500),
          });
          // Publish: the snapshot becomes the viewer-facing definition.
          doc.published = snapshot as unknown as Record<string, unknown>;
          doc.markModified("published"); // Mixed: assignment isn't auto-tracked
          doc.publishedVersion = created.version;
          doc.publishedAt = new Date();
          await doc.save();
          return {
            success: true,
            version: created.version,
            publishedVersion: created.version,
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
