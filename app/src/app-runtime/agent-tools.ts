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

export async function executeAppAgentTool(
  toolName: string,
  input: Record<string, unknown>,
  _options?: { executionId?: string; signal?: AbortSignal },
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
      const binding = store.addDataBinding(appId, {
        name: input.name as string,
        connectionId: input.connectionId as string,
        language: (input.language as "sql" | "javascript" | "mongodb") || "sql",
        code: input.code as string,
        databaseId: input.databaseId as string | undefined,
        databaseName: input.databaseName as string | undefined,
      });
      if (!binding) return fail("Failed to create data binding");
      await persist();
      return {
        success: true,
        binding: { name: binding.name },
        hint: `Read it in app code with useQuery("${binding.name}") from '@mako/app-sdk'.`,
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

    default:
      return fail(`Unknown app tool: ${toolName}`);
  }
}
