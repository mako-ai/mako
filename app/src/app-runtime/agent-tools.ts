/**
 * Client-side executor for the React App agent tools.
 *
 * Mirrors `executeDashboardAgentTool`: the AI SDK routes app tool calls to the
 * browser via `onToolCall`, and this dispatcher applies them to the open app's
 * virtual filesystem (via `appStore`) and the preview, then returns a
 * JSON-serializable result for the agent.
 */

import { useConsoleStore } from "../store/consoleStore";
import { useAppStore, type AppEntity } from "../store/appStore";
import { focusAppTab, getCurrentWorkspaceId } from "./shell";

type ToolResult = Record<string, unknown>;

function fail(error: string): ToolResult {
  return { success: false, error };
}

function listOpenApps() {
  const { tabs, activeTabId } = useConsoleStore.getState();
  const openApps = useAppStore.getState().openApps;
  return Object.values(tabs)
    .filter((t): t is typeof t & { metadata: { appId: string } } =>
      Boolean(t.kind === "app" && t.metadata?.appId),
    )
    .map(t => {
      const appId = t.metadata.appId as string;
      const appEntity = openApps[appId];
      return {
        id: appId,
        title: t.title,
        isActive: t.id === activeTabId,
        fileCount: appEntity?.files.length ?? 0,
        dependencies: appEntity?.dependencies ?? {},
        dataBindings: (appEntity?.dataBindings ?? []).map(b => ({
          name: b.name,
          connectionId: b.connectionId,
          language: b.language,
        })),
      };
    });
}

/**
 * Bounded wait for `materialize_binding`. The build runs server-side in the
 * background; the tool waits at most this long before returning a "still
 * building" result, so the agent round-trip can never hang on a slow build.
 * The agent can override per call via `waitSeconds` (0..600); re-calling the
 * tool resumes waiting on the in-flight build, so polling with a timeout is
 * just repeated calls.
 */
const MATERIALIZE_TOOL_DEFAULT_WAIT_MS = 120_000;
const MATERIALIZE_TOOL_MAX_WAIT_MS = 600_000;

export async function executeAppAgentTool(
  toolName: string,
  input: Record<string, unknown>,
  options?: { executionId?: string; signal?: AbortSignal },
): Promise<ToolResult> {
  const store = useAppStore.getState();
  const workspaceId = getCurrentWorkspaceId();
  const appId = input.appId as string | undefined;

  const ensureApp = async (id: string) => {
    let appEntity: AppEntity | undefined = useAppStore.getState().openApps[id];
    if (!appEntity && workspaceId) {
      appEntity = (await store.fetchApp(workspaceId, id)) ?? undefined;
    }
    return appEntity;
  };

  const persist = async () => {
    if (workspaceId && appId) await store.persistApp(workspaceId, appId);
  };

  switch (toolName) {
    case "list_open_apps":
      return { success: true, apps: listOpenApps() };

    case "create_app": {
      if (!workspaceId) return fail("No active workspace");
      const created = await store.createApp(
        workspaceId,
        (input.title as string) || "Untitled App",
      );
      if (!created) return fail("Failed to create app");
      focusAppTab(created._id, created.title);
      return {
        success: true,
        appId: created._id,
        title: created.title,
        files: created.files.map(f => f.path),
      };
    }

    case "open_app": {
      if (!appId) return fail("appId is required");
      const appEntity = await ensureApp(appId);
      if (!appEntity) return fail("App not found");
      focusAppTab(appId, appEntity.title);
      return { success: true, appId, title: appEntity.title };
    }

    case "get_app_state": {
      if (!appId) return fail("appId is required");
      const appEntity = await ensureApp(appId);
      if (!appEntity) return fail("App not found");
      return {
        success: true,
        appId,
        title: appEntity.title,
        runtime: appEntity.runtime,
        entrypoint: appEntity.entrypoint,
        files: appEntity.files.map(f => f.path),
        dependencies: appEntity.dependencies,
        dataBindings: appEntity.dataBindings.map(b => ({
          name: b.name,
          connectionId: b.connectionId,
          language: b.language,
          code: b.code,
        })),
        previewErrors: (useAppStore.getState().previewErrors[appId] ?? []).map(
          e => ({ message: e.message, source: e.source }),
        ),
      };
    }

    case "app_read_file": {
      if (!appId) return fail("appId is required");
      const appEntity = await ensureApp(appId);
      if (!appEntity) return fail("App not found");
      const file = appEntity.files.find(f => f.path === input.path);
      if (!file) return fail(`File not found: ${input.path}`);
      return { success: true, path: file.path, contents: file.contents };
    }

    case "app_write_file": {
      if (!appId) return fail("appId is required");
      await ensureApp(appId);
      store.writeFile(
        appId,
        input.path as string,
        (input.contents as string) ?? "",
      );
      await persist();
      return { success: true, path: input.path };
    }

    case "app_delete_file": {
      if (!appId) return fail("appId is required");
      await ensureApp(appId);
      store.deleteFile(appId, input.path as string);
      await persist();
      return { success: true, path: input.path };
    }

    case "app_rename_file": {
      if (!appId) return fail("appId is required");
      await ensureApp(appId);
      store.renameFile(appId, input.from as string, input.to as string);
      await persist();
      return { success: true, from: input.from, to: input.to };
    }

    case "app_add_dependency": {
      if (!appId) return fail("appId is required");
      await ensureApp(appId);
      store.addDependency(
        appId,
        input.name as string,
        input.version as string | undefined,
      );
      await persist();
      return { success: true, name: input.name };
    }

    case "app_remove_dependency": {
      if (!appId) return fail("appId is required");
      await ensureApp(appId);
      store.removeDependency(appId, input.name as string);
      await persist();
      return { success: true, name: input.name };
    }

    case "app_create_data_binding": {
      if (!appId) return fail("appId is required");
      await ensureApp(appId);
      const materialization =
        input.materialization === "parquet" ? "parquet" : "live";
      const binding = store.addDataBinding(appId, {
        name: input.name as string,
        connectionId: input.connectionId as string,
        language: (input.language as "sql" | "javascript" | "mongodb") || "sql",
        code: input.code as string,
        databaseId: input.databaseId as string | undefined,
        databaseName: input.databaseName as string | undefined,
        materialization,
      });
      if (!binding) return fail("Failed to create data binding");
      await persist();
      return {
        success: true,
        binding: { name: binding.name, materialization },
        hint:
          materialization === "parquet"
            ? `Call materialize_binding for "${binding.name}", then read it with useQuery("${binding.name}") or run analytics with useDuckDB(sql) from '@mako/app-sdk'.`
            : `Read it in app code with useQuery("${binding.name}") from '@mako/app-sdk'.`,
      };
    }

    case "app_delete_data_binding": {
      if (!appId) return fail("appId is required");
      const appEntity = await ensureApp(appId);
      if (!appEntity) return fail("App not found");
      const name = input.name as string;
      const binding = appEntity.dataBindings.find(b => b.name === name);
      if (!binding) return fail(`No data binding named "${name}"`);
      store.removeDataBinding(appId, binding.id);
      await persist();
      const remaining = (
        useAppStore.getState().openApps[appId]?.dataBindings ?? []
      ).map(b => b.name);
      return { success: true, deleted: name, remaining };
    }

    case "materialize_binding": {
      if (!appId || !workspaceId) {
        return fail("appId and workspace are required");
      }
      const appEntity = await ensureApp(appId);
      const binding = appEntity?.dataBindings.find(b => b.name === input.name);
      if (!binding) return fail(`No data binding named "${input.name}"`);
      const timeoutMs =
        typeof input.waitSeconds === "number" && input.waitSeconds >= 0
          ? Math.min(input.waitSeconds * 1000, MATERIALIZE_TOOL_MAX_WAIT_MS)
          : MATERIALIZE_TOOL_DEFAULT_WAIT_MS;
      const result = await store.materializeBinding(
        workspaceId,
        appId,
        binding.id,
        // Explicit rebuild request: force past the definition-hash cache so
        // unchanged queries still pick up new upstream data.
        { force: true, signal: options?.signal, timeoutMs },
      );
      if (result.status === "building") {
        // Not an error: the build continues server-side. Return so the agent
        // can keep working instead of blocking on a long-running build.
        return {
          success: true,
          binding: { name: binding.name },
          status: "building",
          hint:
            `Materialization of "${binding.name}" is still running in the background. ` +
            "The app will load the data automatically once it is ready. " +
            "To wait for completion, call materialize_binding again (optionally " +
            "with a larger waitSeconds); it resumes waiting on the in-flight build.",
        };
      }
      if (!result.success) {
        return fail(result.error || "Materialization failed");
      }
      return {
        success: true,
        binding: { name: binding.name },
        status: "ready",
        hint: `Materialized. Read it with useQuery("${binding.name}") or useDuckDB(sql).`,
      };
    }

    case "run_app": {
      if (!appId) return fail("appId is required");
      await ensureApp(appId);
      store.bumpPreview(appId);
      // Give the preview a moment to rebuild and report errors.
      await new Promise(resolve => setTimeout(resolve, 1200));
      const errors = useAppStore.getState().previewErrors[appId] ?? [];
      return {
        success: true,
        errors: errors.map(e => ({ message: e.message, source: e.source })),
      };
    }

    case "app_set_preview_environment": {
      if (!appId) return fail("appId is required");
      if (!workspaceId) return fail("No active workspace");
      const appEntity = await ensureApp(appId);
      if (!appEntity) return fail("App not found");
      const environment = (input.environment ?? null) as string | null;
      const dbtProjectId = appEntity.dataBindings.find(
        b => b.dbtProjectId,
      )?.dbtProjectId;
      if (!dbtProjectId) {
        return fail(
          "This app has no dbt-linked data bindings. Link a binding to a " +
            "dbt project (dbtProjectId + the {{ dbt_schema }} token) first.",
        );
      }
      if (environment) {
        const info = await store.fetchDbtEnvInfo(workspaceId, dbtProjectId);
        if (!info) return fail("Failed to load the linked dbt project");
        if (!info.environments.some(env => env.name === environment)) {
          return fail(
            `Environment "${environment}" not found on the linked dbt ` +
              `project. Available: ${info.environments
                .map(env => env.name)
                .join(", ")}`,
          );
        }
      }
      store.setPreviewDbtEnvironment(appId, environment);
      return {
        success: true,
        appId,
        environment,
        hint: environment
          ? `Draft preview now reads dbt environment "${environment}". This ` +
            "is your view only — published/shared viewers still read prod."
          : "Draft preview reset to the default (prod) dbt environment.",
      };
    }

    default:
      return fail(`Unknown app tool: ${toolName}`);
  }
}
