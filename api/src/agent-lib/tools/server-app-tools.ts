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
  editFileSchema,
  deleteFileSchema,
  renameFileSchema,
  addDependencySchema,
  removeDependencySchema,
  createDataBindingSchema,
  updateDataBindingSchema,
  deleteDataBindingSchema,
  saveAppVersionSchema,
  restoreAppVersionSchema,
  listAppsSchema,
  createAppSchema,
  getAppStateSchema,
  getDataBindingSchema,
  appReadFileSchema,
  appReadResourceSchema,
  appSearchSchema,
  materializeBindingSchema,
  setBindingScheduleSchema,
  setBindingMaterializationSchema,
  summarizeAppBindingForState,
  clipAgentText,
  APP_BINDING_CODE_MAX_CHARS,
  APP_READ_FILE_MAX_CHARS,
  appResourceRef,
  appResourceVersion,
  appVersionedResourceVersion,
  appBindingResourceVersion,
  parseAppResourceRef,
  readAppResourceRange,
  searchAppResources,
  applyStrReplace,
  buildStrReplaceDiff,
} from "@mako/agent-tools";
import { normalizeAppFiles, createAppScaffold } from "@mako/schemas";
import { validateDashboardMaterializationSchedule } from "../../services/dashboard-materialization-schedule.service";
import {
  MakoApp,
  DatabaseConnection,
  DbtProject,
  SavedConsole,
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
import {
  MONGO_QUERY_WRITE_SCOPE_REQUIRED,
  sqlReadOnlyAccessError,
} from "../../services/read-only-query.service";
import type { QueryAccess } from "../../auth/api-key-scopes";

const logger = loggers.agent();

export interface ServerAppToolsOptions {
  workspaceId: string;
  /** Acting user (session user id, or API-key creator). */
  userId?: string;
  /** Chat driving this turn — used as the realtime echo-suppression id. */
  chatId?: string;
  /** Database capability granted by the calling API key. */
  queryAccess?: QueryAccess;
}

type LoadResult = { doc: IMakoApp } | { error: string };

function isLoadError(r: LoadResult): r is { error: string } {
  return (r as { error?: string }).error !== undefined;
}

export function createServerAppTools({
  workspaceId,
  userId,
  chatId,
  queryAccess,
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

  const bindingQueryAccessError = async (
    language: unknown,
    code: unknown,
    connectionId: unknown,
  ): Promise<string | null> => {
    // In-product agents keep their existing behavior. MCP data bindings are
    // always read-only: a binding is a data source,
    // not an arbitrary command channel.
    if (queryAccess === undefined) return null;
    if (queryAccess === "none") {
      return "This API key does not have query access.";
    }
    if (
      typeof connectionId !== "string" ||
      !Types.ObjectId.isValid(connectionId)
    ) {
      return "Data binding connection is invalid.";
    }
    const connection = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(connectionId),
      workspaceId: new Types.ObjectId(workspaceId),
    }).select("type");
    if (!connection) return "Data binding connection is invalid.";
    if (
      connection.type === "mongodb" ||
      language === "javascript" ||
      language === "mongodb"
    ) {
      return MONGO_QUERY_WRITE_SCOPE_REQUIRED;
    }
    return sqlReadOnlyAccessError(typeof code === "string" ? code : "");
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

  // Validate that a binding's dbt project link belongs to this workspace.
  const validateDbtProject = async (
    dbtProjectId: string | undefined | null,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!dbtProjectId) return { ok: true };
    if (!Types.ObjectId.isValid(dbtProjectId)) {
      return { ok: false, error: `Invalid dbtProjectId: ${dbtProjectId}` };
    }
    const found = await DbtProject.countDocuments({
      _id: new Types.ObjectId(dbtProjectId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    return found > 0
      ? { ok: true }
      : {
          ok: false,
          error:
            "dbt project not found in this workspace. Use read_dbt_project_tree to list project IDs.",
        };
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

  // Resolve a saved console into binding query fields (code, connection,
  // language, database) so bindings can be imported by reference instead of
  // the agent re-typing the SQL. Read access mirrors read_console: any
  // console visible to the acting user.
  const resolveConsoleForBinding = async (
    consoleId: string,
  ): Promise<
    | {
        ok: true;
        name: string;
        code: string;
        connectionId?: string;
        language: string;
        databaseId?: string;
        databaseName?: string;
      }
    | { ok: false; error: string }
  > => {
    if (!Types.ObjectId.isValid(consoleId)) {
      return { ok: false, error: `Invalid console ID: ${consoleId}` };
    }
    const doc = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!doc) {
      return {
        ok: false,
        error: `Console ${consoleId} not found. Use search_consoles to find console IDs.`,
      };
    }
    if (userId && !canReadResource(doc, userId, await memberRole())) {
      return {
        ok: false,
        error: `Console ${consoleId} not found. Use search_consoles to find console IDs.`,
      };
    }
    return {
      ok: true,
      name: doc.name || "imported_binding",
      code: doc.code || "",
      connectionId: doc.connectionId?.toString(),
      language: doc.language || "sql",
      databaseId: doc.databaseId,
      databaseName: doc.databaseName,
    };
  };

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
        "data binding metadata (name/language/connection/codeLength + a short " +
        "codePreview — NOT full SQL), entrypoint, runtime, and version/publish " +
        "state. This is a manifest: use app_search, then app_read_resource for " +
        "specific line ranges. NOTE: live preview build/runtime errors are only " +
        "available in an attached browser via run_app.",
      inputSchema: getAppStateSchema,
      execute: async ({ appId, resourceOffset, resourceLimit }) =>
        wrap("get_app_state", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          const offset = resourceOffset ?? 0;
          const limit = resourceLimit ?? 100;
          const allResources = [
            ...(doc.files ?? []).map(f => ({
              resource: appResourceRef("file", f.path),
              kind: "file" as const,
              name: f.path,
              lines: (f.contents ?? "").split("\n").length,
              chars: (f.contents ?? "").length,
              resourceVersion: appVersionedResourceVersion(
                doc.version,
                appResourceVersion(f.contents ?? ""),
              ),
            })),
            ...(doc.dataBindings ?? []).map(b => ({
              ...summarizeAppBindingForState(b),
              resource: appResourceRef("binding", b.name),
              kind: "binding" as const,
              lines: (b.code ?? "").split("\n").length,
              chars: (b.code ?? "").length,
              resourceVersion: appVersionedResourceVersion(
                doc.version,
                appBindingResourceVersion(b),
              ),
            })),
          ];
          const resources = allResources.slice(offset, offset + limit);
          const nextResourceOffset =
            offset + resources.length < allResources.length
              ? offset + resources.length
              : undefined;
          const dependencyEntries = Object.entries(doc.dependencies ?? {});
          return {
            success: true,
            appId,
            title: doc.title,
            runtime: doc.runtime,
            entrypoint: doc.entrypoint,
            version: doc.version,
            publishedVersion: doc.publishedVersion,
            resourceOffset: offset,
            resourceLimit: limit,
            totalResources: allResources.length,
            resources,
            ...(nextResourceOffset !== undefined ? { nextResourceOffset } : {}),
            // Compatibility projections are page-scoped, never unbounded.
            files: resources
              .filter(resource => resource.kind === "file")
              .map(resource => resource.name),
            dataBindings: resources.filter(
              resource => resource.kind === "binding",
            ),
            dependencies: Object.fromEntries(dependencyEntries.slice(0, 200)),
            dependenciesTruncated: dependencyEntries.length > 200,
            hint:
              "Search with app_search, then fetch only relevant lines with " +
              "app_read_resource. Binding queries are not dumped here.",
          };
        }),
    }),

    app_search: tool({
      description:
        "Search app files and data bindings without loading them into context. " +
        "Returns bounded snippets, line ranges, resource refs, and versions. " +
        "Call this before app_read_resource when you need specific code. If " +
        "truncated, continue with the returned nextOffset.",
      inputSchema: appSearchSchema,
      execute: async ({
        appId,
        query,
        resourceTypes,
        contextLines,
        maxResults,
        offset,
      }) =>
        wrap("app_search", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const allowed = new Set(resourceTypes ?? ["file", "binding"]);
          const resources = [
            ...((allowed.has("file") ? loaded.doc.files : []) ?? []).map(f => ({
              resource: appResourceRef("file", f.path),
              kind: "file" as const,
              name: f.path,
              text: f.contents ?? "",
              resourceVersion: appVersionedResourceVersion(
                loaded.doc.version,
                appResourceVersion(f.contents ?? ""),
              ),
            })),
            ...(
              (allowed.has("binding") ? loaded.doc.dataBindings : []) ?? []
            ).map(b => ({
              resource: appResourceRef("binding", b.name),
              kind: "binding" as const,
              name: b.name,
              text: b.code ?? "",
              resourceVersion: appVersionedResourceVersion(
                loaded.doc.version,
                appBindingResourceVersion(b),
              ),
            })),
          ];
          const result = searchAppResources(resources, query, {
            contextLines,
            maxResults,
            offset,
          });
          return {
            success: true,
            appId,
            query,
            ...result,
            hint:
              "Use app_read_resource with a returned resource and line range " +
              "for more context.",
          };
        }),
    }),

    app_read_resource: tool({
      description:
        "Read a bounded line range from an app file or data binding. Resource " +
        'refs come from get_app_state/app_search ("file:path" or "binding:name"). ' +
        "Returns pagination metadata and a resourceVersion for safe edits. Use " +
        "startOffset/nextOffset for oversized generated single lines.",
      inputSchema: appReadResourceSchema,
      execute: async ({ appId, resource, startLine, endLine, startOffset }) =>
        wrap("app_read_resource", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const parsed = parseAppResourceRef(resource);
          if (!parsed) {
            return {
              success: false,
              error:
                'Invalid resource ref. Use "file:<path>" or "binding:<name>" ' +
                "from get_app_state/app_search.",
            };
          }
          const file =
            parsed.kind === "file"
              ? (loaded.doc.files ?? []).find(f => f.path === parsed.name)
              : undefined;
          const binding =
            parsed.kind === "binding"
              ? (loaded.doc.dataBindings ?? []).find(
                  b => b.name === parsed.name,
                )
              : undefined;
          const text = file?.contents ?? binding?.code;
          if (text == null) {
            return { success: false, error: `Resource not found: ${resource}` };
          }
          return {
            success: true,
            appId,
            resource,
            kind: parsed.kind,
            name: parsed.name,
            resourceVersion: binding
              ? appVersionedResourceVersion(
                  loaded.doc.version,
                  appBindingResourceVersion(binding),
                )
              : appVersionedResourceVersion(
                  loaded.doc.version,
                  appResourceVersion(text),
                ),
            ...readAppResourceRange(text, startLine, endLine, startOffset),
          };
        }),
    }),

    app_get_data_binding: tool({
      description:
        "Compatibility fallback that reads one data binding's query code. " +
        "Prefer app_search + app_read_resource for precise line ranges. " +
        "Large queries are truncated " +
        `(~${APP_BINDING_CODE_MAX_CHARS} chars); use app_update_data_binding ` +
        "with oldString/newString for targeted edits.",
      inputSchema: getDataBindingSchema,
      execute: async ({ appId, name }) =>
        wrap("app_get_data_binding", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const binding = (loaded.doc.dataBindings ?? []).find(
            b => b.name === name,
          );
          if (!binding) {
            return {
              success: false,
              error: `No data binding named "${name}". Confirm with get_app_state.`,
            };
          }
          const clipped = clipAgentText(
            binding.code ?? "",
            APP_BINDING_CODE_MAX_CHARS,
          );
          if (clipped.truncated) {
            return {
              success: false,
              appId,
              error:
                "Binding is too large for app_get_data_binding. Use app_search " +
                "and app_read_resource to read precise ranges.",
              binding: {
                name: binding.name,
                codeLength: clipped.length,
              },
            };
          }
          return {
            success: true,
            appId,
            binding: {
              name: binding.name,
              connectionId: binding.connectionId,
              dbtProjectId: binding.dbtProjectId,
              language: binding.language ?? "sql",
              materialization: binding.materialization ?? "live",
              code: clipped.text,
              codeLength: clipped.length,
              truncated: false,
            },
          };
        }),
    }),

    app_read_file: tool({
      description:
        "Compatibility fallback that reads a single app file. Prefer " +
        "app_search + app_read_resource for precise line ranges. Large files are truncated " +
        `(~${APP_READ_FILE_MAX_CHARS} chars) with truncated:true — prefer ` +
        "app_edit_file with a unique oldString over re-reading whole files.",
      inputSchema: appReadFileSchema,
      execute: async ({ appId, path }) =>
        wrap("app_read_file", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const file = (loaded.doc.files ?? []).find(f => f.path === path);
          if (!file) {
            return { success: false, error: `File not found: ${path}` };
          }
          const clipped = clipAgentText(
            file.contents ?? "",
            APP_READ_FILE_MAX_CHARS,
          );
          if (clipped.truncated) {
            return {
              success: false,
              path: file.path,
              length: clipped.length,
              error:
                "File is too large for app_read_file. Use app_search and " +
                "app_read_resource to read precise ranges.",
            };
          }
          return {
            success: true,
            path: file.path,
            contents: clipped.text,
            length: clipped.length,
            truncated: false,
          };
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
          const accessError = await bindingQueryAccessError(
            binding.language,
            binding.code,
            binding.connectionId,
          );
          if (accessError) return { success: false, error: accessError };
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
        "Create a NEW file, or fully rewrite one, with complete contents. " +
        "For modifying an existing file prefer app_edit_file (anchored " +
        "old/new string) — it is faster and avoids re-sending unchanged " +
        "code. Writing the entrypoint or any imported file refreshes the " +
        "live preview.",
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

    app_edit_file: tool({
      description:
        "Edit an existing file by replacing an exact text match. This is " +
        "the PRIMARY tool for modifying app files: pass the exact current " +
        "text as oldString (unique — include surrounding lines to " +
        'disambiguate) and the replacement as newString ("" deletes it). ' +
        "Set replaceAll: true for renames. Use app_write_file only for new " +
        "files or full rewrites. Edits refresh the live preview.",
      inputSchema: editFileSchema,
      execute: async ({
        appId,
        path,
        oldString,
        newString,
        replaceAll,
        expectedResourceVersion,
      }) =>
        wrap("app_edit_file", async () => {
          const loaded = await loadApp(appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(appId);
          const file = (doc.files ?? []).find(f => f.path === path);
          if (!file) {
            return {
              success: false,
              error: `File not found: ${path}. Use get_app_state to list files, or app_write_file to create it.`,
            };
          }
          const currentResourceVersion = appVersionedResourceVersion(
            doc.version,
            appResourceVersion(file.contents ?? ""),
          );
          if (
            expectedResourceVersion &&
            expectedResourceVersion !== currentResourceVersion
          ) {
            return {
              success: false,
              error:
                `File changed since it was read (expected ${expectedResourceVersion}, ` +
                `current ${currentResourceVersion}). Search/read it again before editing.`,
              currentResourceVersion,
            };
          }
          const result = applyStrReplace(
            file.contents ?? "",
            oldString,
            newString,
            replaceAll === true,
          );
          if (!result.ok) {
            return { success: false, error: result.error };
          }
          const diff = buildStrReplaceDiff(
            file.contents ?? "",
            oldString,
            newString,
            result.replacements,
          );
          // Version predicate makes the read-check-write atomic. A concurrent
          // app mutation causes a clean retry instead of a lost update.
          const updated = await MakoApp.findOneAndUpdate(
            { _id: doc._id, version: doc.version, "files.path": path },
            {
              $set: { "files.$.contents": result.contents },
              $inc: { version: 1 },
            },
            { new: true },
          );
          if (!updated) {
            return {
              success: false,
              error:
                "App changed while this edit was being applied. Search/read " +
                "the resource again, then retry with its new resourceVersion.",
            };
          }
          publishRealtimeEvent(workspaceId, {
            type: "app.updated",
            appId,
            version: updated.version,
            updatedBy: userId ?? "agent",
            clientId: agentClientId,
            origin: "agent",
          });
          return {
            success: true,
            path,
            version: updated.version,
            resourceVersion: appVersionedResourceVersion(
              updated.version,
              appResourceVersion(result.contents),
            ),
            replacements: result.replacements,
            diff,
          };
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
        "Create a NEW named data binding that the app can read via " +
        "useQuery(name) from '@mako/app-sdk'. The query runs server-side, " +
        "scoped to the workspace — the app never sees credentials. To reuse " +
        "a saved console's query, pass consoleId (from search_consoles) " +
        "instead of re-typing code/connectionId. To change an EXISTING " +
        "binding's query, use app_update_data_binding — do NOT recreate it " +
        "under a new name. Set materialization to 'parquet' for " +
        "DuckDB-WASM-backed analytics (then call materialize_binding).",
      inputSchema: createDataBindingSchema,
      execute: async input =>
        wrap("app_create_data_binding", async () => {
          const loaded = await loadApp(input.appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(input.appId);

          // Resolve query fields from a saved console when provided;
          // explicit input fields always win.
          let fromConsole: {
            name: string;
            code: string;
            connectionId?: string;
            language: string;
            databaseId?: string;
            databaseName?: string;
          } | null = null;
          if (input.consoleId) {
            const resolved = await resolveConsoleForBinding(input.consoleId);
            if (!resolved.ok) {
              return { success: false, error: resolved.error };
            }
            fromConsole = resolved;
          }

          const name =
            input.name ??
            (fromConsole
              ? fromConsole.name
                  .toLowerCase()
                  .replace(/[^a-z0-9_]+/g, "_")
                  .replace(/^_+|_+$/g, "") || "imported_binding"
              : undefined);
          const connectionId = input.connectionId ?? fromConsole?.connectionId;
          const code = input.code ?? fromConsole?.code;
          const rawLanguage = input.language ?? fromConsole?.language ?? "sql";
          const language =
            rawLanguage === "javascript" || rawLanguage === "mongodb"
              ? rawLanguage
              : "sql";
          if (!name) {
            return { success: false, error: "name is required" };
          }
          if (!connectionId || code === undefined) {
            return {
              success: false,
              error:
                "Either consoleId, or both connectionId and code, are required.",
            };
          }
          const accessError = await bindingQueryAccessError(
            language,
            code,
            connectionId,
          );
          if (accessError) return { success: false, error: accessError };

          // Same-name "replace" used to silently recreate the binding with a
          // new id — orphaning its artifact and dropping its schedule (the
          // root of the recreate-under-a-new-name workaround). Reject instead
          // and point at the in-place update tool.
          const existing = (doc.dataBindings ?? []).find(b => b.name === name);
          if (existing) {
            return {
              success: false,
              error:
                `A data binding named "${name}" already exists. Use ` +
                "app_update_data_binding to change its query in place " +
                "(preserves its id, schedule, and materialized artifact), " +
                "or pass a different name.",
            };
          }

          const connCheck = await validateConnection(connectionId);
          if (!connCheck.ok) return { success: false, error: connCheck.error };
          const dbtCheck = await validateDbtProject(input.dbtProjectId);
          if (!dbtCheck.ok) return { success: false, error: dbtCheck.error };
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
            name,
            dbtProjectId: input.dbtProjectId,
            connectionId,
            language,
            code,
            databaseId: input.databaseId ?? fromConsole?.databaseId,
            databaseName: input.databaseName ?? fromConsole?.databaseName,
            materialization,
            materializationSchedule,
            cache: undefined,
          };
          doc.dataBindings = [
            ...(doc.dataBindings ?? []),
            created,
          ] as IMakoApp["dataBindings"];
          const version = await saveAndPublish(doc);
          return {
            success: true,
            binding: { name: created.name, materialization },
            ...(input.consoleId
              ? { importedFromConsoleId: input.consoleId }
              : {}),
            version,
            hint:
              materialization === "parquet"
                ? `Call materialize_binding for "${created.name}", then read it with useQuery("${created.name}") or run analytics with useDuckDB(sql) from '@mako/app-sdk'.`
                : `Read it in app code with useQuery("${created.name}") from '@mako/app-sdk'.`,
          };
        }),
    }),

    app_update_data_binding: tool({
      description:
        "Update an EXISTING data binding's query IN PLACE by name — change " +
        "its code (full replacement via code, or an anchored edit via " +
        "oldString/newString), connection, language, or database. Preserves " +
        "the binding's id, materialization, schedule, and artifact history — " +
        "NEVER delete/recreate a binding (or invent a versioned name like " +
        "my_data_v2) just to change its query. For 'parquet' bindings a " +
        "rebuild is queued automatically; open tabs keep serving the " +
        "PREVIOUS data until you call materialize_binding and it completes.",
      inputSchema: updateDataBindingSchema,
      execute: async input =>
        wrap("app_update_data_binding", async () => {
          const loaded = await loadApp(input.appId);
          if (isLoadError(loaded)) return { success: false, ...loaded };
          const { doc } = loaded;
          if (!(await canWrite(doc))) return denied(input.appId);
          const binding = (doc.dataBindings ?? []).find(
            b => b.name === input.name,
          );
          if (!binding) {
            return {
              success: false,
              error: `No data binding named "${input.name}". Confirm the name with list_data_sources, or create it with app_create_data_binding.`,
            };
          }
          const currentResourceVersion = appVersionedResourceVersion(
            doc.version,
            appBindingResourceVersion(binding),
          );
          if (
            input.expectedResourceVersion &&
            input.expectedResourceVersion !== currentResourceVersion
          ) {
            return {
              success: false,
              error:
                `Binding changed since it was read (expected ${input.expectedResourceVersion}, ` +
                `current ${currentResourceVersion}). Search/read it again before updating.`,
              currentResourceVersion,
            };
          }

          if (input.code !== undefined && input.oldString !== undefined) {
            return {
              success: false,
              error:
                "Pass either code (full replacement) or oldString/newString (anchored edit), not both.",
            };
          }

          let nextCode = binding.code ?? "";
          let diff: string | undefined;
          let replacements: number | undefined;
          if (input.oldString !== undefined) {
            if (input.newString === undefined) {
              return {
                success: false,
                error: "newString is required when oldString is provided.",
              };
            }
            const result = applyStrReplace(
              binding.code ?? "",
              input.oldString,
              input.newString,
            );
            if (!result.ok) {
              return { success: false, error: result.error };
            }
            diff = buildStrReplaceDiff(
              binding.code ?? "",
              input.oldString,
              input.newString,
              result.replacements,
            );
            nextCode = result.contents;
            replacements = result.replacements;
          } else if (input.code !== undefined) {
            nextCode = input.code;
          }

          if (input.connectionId !== undefined) {
            const connCheck = await validateConnection(input.connectionId);
            if (!connCheck.ok) {
              return { success: false, error: connCheck.error };
            }
          }
          if (input.dbtProjectId != null) {
            const dbtCheck = await validateDbtProject(input.dbtProjectId);
            if (!dbtCheck.ok) {
              return { success: false, error: dbtCheck.error };
            }
          }
          const nextLanguage = input.language ?? binding.language ?? "sql";
          const accessError = await bindingQueryAccessError(
            nextLanguage,
            nextCode,
            input.connectionId ?? binding.connectionId,
          );
          if (accessError) return { success: false, error: accessError };

          const nextDbtProjectId =
            input.dbtProjectId === undefined
              ? binding.dbtProjectId
              : (input.dbtProjectId ?? undefined);
          const changed =
            nextCode !== (binding.code ?? "") ||
            nextDbtProjectId !== binding.dbtProjectId ||
            (input.connectionId !== undefined &&
              input.connectionId !== binding.connectionId) ||
            (input.language !== undefined &&
              input.language !== binding.language) ||
            (input.databaseId !== undefined &&
              input.databaseId !== binding.databaseId) ||
            (input.databaseName !== undefined &&
              input.databaseName !== binding.databaseName);
          if (!changed) {
            return {
              success: false,
              error:
                "Nothing to update — provide code, oldString/newString, or a changed connection/language/database/dbtProjectId field.",
            };
          }

          // Mutate the existing embedded binding atomically. The app version
          // predicate closes the race between resourceVersion validation and
          // persistence; any concurrent app edit forces a fresh read/retry.
          const setFields: Record<string, unknown> = {
            "dataBindings.$.code": nextCode,
          };
          const unsetFields: Record<string, 1> = {};
          if (input.dbtProjectId !== undefined) {
            if (nextDbtProjectId === undefined) {
              unsetFields["dataBindings.$.dbtProjectId"] = 1;
            } else {
              setFields["dataBindings.$.dbtProjectId"] = nextDbtProjectId;
            }
          }
          if (input.connectionId !== undefined) {
            setFields["dataBindings.$.connectionId"] = input.connectionId;
          }
          if (input.language !== undefined) {
            setFields["dataBindings.$.language"] = input.language;
          }
          if (input.databaseId !== undefined) {
            setFields["dataBindings.$.databaseId"] = input.databaseId;
          }
          if (input.databaseName !== undefined) {
            setFields["dataBindings.$.databaseName"] = input.databaseName;
          }
          const updated = await MakoApp.findOneAndUpdate(
            {
              _id: doc._id,
              version: doc.version,
              "dataBindings.name": input.name,
            },
            {
              $set: setFields,
              ...(Object.keys(unsetFields).length > 0
                ? { $unset: unsetFields }
                : {}),
              $inc: { version: 1 },
            },
            { new: true },
          );
          if (!updated) {
            return {
              success: false,
              error:
                "App changed while this binding update was being applied. " +
                "Search/read the resource again, then retry with its new " +
                "resourceVersion.",
            };
          }
          const updatedBinding = (updated.dataBindings ?? []).find(
            candidate => candidate.name === input.name,
          );
          if (!updatedBinding) {
            return {
              success: false,
              error: `Binding disappeared during update: ${input.name}`,
            };
          }
          publishRealtimeEvent(workspaceId, {
            type: "app.updated",
            appId: input.appId,
            version: updated.version,
            updatedBy: userId ?? "agent",
            clientId: agentClientId,
            origin: "agent",
          });

          const isParquet = updatedBinding.materialization === "parquet";
          if (isParquet) {
            // Queue the rebuild now (the hash change makes it a cache miss);
            // the agent can wait on it with materialize_binding.
            await queueAppBindingMaterialization({
              workspaceId,
              appId: input.appId,
              bindingId: updatedBinding.id,
            }).catch(() => undefined);
          }

          return {
            success: true,
            binding: {
              name: updatedBinding.name,
              materialization: updatedBinding.materialization ?? "live",
            },
            version: updated.version,
            resourceVersion: appVersionedResourceVersion(
              updated.version,
              appBindingResourceVersion(updatedBinding),
            ),
            ...(replacements !== undefined ? { replacements } : {}),
            ...(diff ? { diff } : {}),
            hint: isParquet
              ? `Definition updated in place and a rebuild was queued. The app keeps serving the PREVIOUS data until the artifact is rebuilt — call materialize_binding for "${updatedBinding.name}" to wait for it.`
              : `Definition updated in place. useQuery("${updatedBinding.name}") runs the new query on the next read.`,
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
          if (enabled) {
            const accessError = await bindingQueryAccessError(
              binding.language,
              binding.code,
              binding.connectionId,
            );
            if (accessError) return { success: false, error: accessError };
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
          if (next === "parquet") {
            const accessError = await bindingQueryAccessError(
              binding.language,
              binding.code,
              binding.connectionId,
            );
            if (accessError) return { success: false, error: accessError };
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
          const snapshot = old.snapshot as unknown as AppSnapshot;
          for (const binding of snapshot.dataBindings ?? []) {
            const accessError = await bindingQueryAccessError(
              binding.language,
              binding.code,
              binding.connectionId,
            );
            if (accessError) return { success: false, error: accessError };
          }
          applyAppSnapshot(doc, snapshot);
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
