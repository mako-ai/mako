/**
 * Client-side executor for the React App agent tools.
 *
 * Mirrors `executeDashboardAgentTool`: the AI SDK routes app tool calls to the
 * browser via `onToolCall`, and this dispatcher applies them to the open app's
 * virtual filesystem (via `appStore`) and the preview, then returns a
 * JSON-serializable result for the agent.
 */

import {
  APP_PREVIEW_VIEWPORT_PRESETS,
  APP_READ_FILE_MAX_CHARS,
  appBindingResourceVersion,
  appResourceRef,
  appResourceVersion,
  appVersionedResourceVersion,
  clampRunAppTimeoutMs,
  clipAgentText,
  parseAppResourceRef,
  readAppResourceRange,
  searchAppResources,
  summarizeAppBindingForState,
  summarizePreviewErrors,
  type RunAppResult,
} from "@mako/agent-tools";
import { enqueueScreenshotVisionAttachment } from "../agent-runtime/screenshot-agent-tools";
import { useConsoleStore } from "../store/consoleStore";
import {
  useAppStore,
  type AppEntity,
  type AppPreviewViewport,
} from "../store/appStore";
import { captureAppPreview, findAppPreviewIframe } from "./preview-capture";
import { focusAppTab, getCurrentWorkspaceId } from "./shell";

type ToolResult = Record<string, unknown>;

function fail(error: string): ToolResult {
  return { success: false, error };
}

/**
 * How a run_app screenshot reaches the calling agent:
 *  - "vision-attachment" (chat): queued as a real image input on the next
 *    model request — base64 never enters the JSON tool result.
 *  - "inline" (desktop bridge): returned in the envelope for the mako-desktop
 *    loopback server to emit as MCP image content.
 *  - "none": caller cannot deliver images (older Local Agent) — skip capture.
 */
export type RunAppScreenshotDelivery = "vision-attachment" | "inline" | "none";

const PREVIEW_SETTLE_POLL_MS = 150;
/** Grace for a preview iframe to mount after bumpPreview / tab focus. */
const PREVIEW_IFRAME_MOUNT_GRACE_MS = 2_000;

/**
 * Await the iframe bootstrap's ready/error report (previewStatus in the app
 * store) instead of sleeping a fixed delay. Bails early as "timeout" when no
 * preview iframe is on screen — nothing will ever report in that case.
 */
async function waitForPreviewSettle(
  appId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: "ready" | "error" | "timeout"; noIframe?: boolean }> {
  const startedAt = Date.now();
  for (;;) {
    const status = useAppStore.getState().previewStatus[appId];
    if (status === "ready" || status === "error") return { status };
    if (status === undefined) {
      // Nothing has ever built/reported for this app in this browser. Fall
      // back to the error list (pre-previewStatus behavior) when a preview
      // is on screen; report cleanly when it is not.
      if (findAppPreviewIframe(appId)) {
        const hasErrors =
          (useAppStore.getState().previewErrors[appId] ?? []).length > 0;
        return { status: hasErrors ? "error" : "ready" };
      }
      if (Date.now() - startedAt >= PREVIEW_IFRAME_MOUNT_GRACE_MS) {
        return { status: "timeout", noIframe: true };
      }
    } else if (
      !findAppPreviewIframe(appId) &&
      Date.now() - startedAt >= PREVIEW_IFRAME_MOUNT_GRACE_MS
    ) {
      // "building" with no iframe mounted: the report can never arrive.
      return { status: "timeout", noIframe: true };
    }
    if (signal?.aborted || Date.now() - startedAt >= timeoutMs) {
      return { status: "timeout" };
    }
    await new Promise(resolve => setTimeout(resolve, PREVIEW_SETTLE_POLL_MS));
  }
}

function dataUrlToParts(
  dataUrl: string,
): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  return match ? { mimeType: match[1], base64: match[2] } : null;
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
  options?: {
    executionId?: string;
    signal?: AbortSignal;
    /** run_app only — how a captured screenshot reaches the agent. */
    screenshotDelivery?: RunAppScreenshotDelivery;
  },
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
      const offset =
        typeof input.resourceOffset === "number" ? input.resourceOffset : 0;
      const limit =
        typeof input.resourceLimit === "number" ? input.resourceLimit : 100;
      const allResources = [
        ...appEntity.files.map(f => ({
          resource: appResourceRef("file", f.path),
          kind: "file" as const,
          name: f.path,
          lines: (f.contents ?? "").split("\n").length,
          chars: (f.contents ?? "").length,
          resourceVersion: appVersionedResourceVersion(
            appEntity.version,
            appResourceVersion(f.contents ?? ""),
          ),
        })),
        ...appEntity.dataBindings.map(b => ({
          ...summarizeAppBindingForState(b),
          resource: appResourceRef("binding", b.name),
          kind: "binding" as const,
          lines: (b.code ?? "").split("\n").length,
          chars: (b.code ?? "").length,
          resourceVersion: appVersionedResourceVersion(
            appEntity.version,
            appBindingResourceVersion(b),
          ),
        })),
      ];
      const resources = allResources.slice(offset, offset + limit);
      const nextResourceOffset =
        offset + resources.length < allResources.length
          ? offset + resources.length
          : undefined;
      const dependencyEntries = Object.entries(appEntity.dependencies);
      return {
        success: true,
        appId,
        title: appEntity.title,
        runtime: appEntity.runtime,
        entrypoint: appEntity.entrypoint,
        resourceOffset: offset,
        resourceLimit: limit,
        totalResources: allResources.length,
        resources,
        ...(nextResourceOffset !== undefined ? { nextResourceOffset } : {}),
        files: resources
          .filter(resource => resource.kind === "file")
          .map(resource => resource.name),
        dataBindings: resources.filter(resource => resource.kind === "binding"),
        dependencies: Object.fromEntries(dependencyEntries.slice(0, 200)),
        dependenciesTruncated: dependencyEntries.length > 200,
        hint:
          "Search with app_search, then fetch only relevant lines with " +
          "app_read_resource. Binding queries are not dumped here.",
        previewErrors: summarizePreviewErrors(
          useAppStore.getState().previewErrors[appId],
        ),
      };
    }

    case "app_search": {
      if (!appId) return fail("appId is required");
      const appEntity = await ensureApp(appId);
      if (!appEntity) return fail("App not found");
      const resourceTypes = Array.isArray(input.resourceTypes)
        ? new Set(input.resourceTypes)
        : new Set(["file", "binding"]);
      const resources = [
        ...(resourceTypes.has("file")
          ? appEntity.files.map(f => ({
              resource: appResourceRef("file", f.path),
              kind: "file" as const,
              name: f.path,
              text: f.contents ?? "",
              resourceVersion: appVersionedResourceVersion(
                appEntity.version,
                appResourceVersion(f.contents ?? ""),
              ),
            }))
          : []),
        ...(resourceTypes.has("binding")
          ? appEntity.dataBindings.map(b => ({
              resource: appResourceRef("binding", b.name),
              kind: "binding" as const,
              name: b.name,
              text: b.code ?? "",
              resourceVersion: appVersionedResourceVersion(
                appEntity.version,
                appBindingResourceVersion(b),
              ),
            }))
          : []),
      ];
      const query = String(input.query ?? "");
      return {
        success: true,
        appId,
        query,
        ...searchAppResources(resources, query, {
          contextLines:
            typeof input.contextLines === "number"
              ? input.contextLines
              : undefined,
          maxResults:
            typeof input.maxResults === "number" ? input.maxResults : undefined,
          offset: typeof input.offset === "number" ? input.offset : undefined,
        }),
        hint:
          "Use app_read_resource with a returned resource and line range " +
          "for more context.",
      };
    }

    case "app_read_resource": {
      if (!appId) return fail("appId is required");
      const appEntity = await ensureApp(appId);
      if (!appEntity) return fail("App not found");
      const resource = String(input.resource ?? "");
      const parsed = parseAppResourceRef(resource);
      if (!parsed) {
        return fail(
          'Invalid resource ref. Use "file:<path>" or "binding:<name>".',
        );
      }
      const file =
        parsed.kind === "file"
          ? appEntity.files.find(f => f.path === parsed.name)
          : undefined;
      const binding =
        parsed.kind === "binding"
          ? appEntity.dataBindings.find(b => b.name === parsed.name)
          : undefined;
      const text = file?.contents ?? binding?.code;
      if (text == null) return fail(`Resource not found: ${resource}`);
      return {
        success: true,
        appId,
        resource,
        kind: parsed.kind,
        name: parsed.name,
        resourceVersion: binding
          ? appVersionedResourceVersion(
              appEntity.version,
              appBindingResourceVersion(binding),
            )
          : appVersionedResourceVersion(
              appEntity.version,
              appResourceVersion(text),
            ),
        ...readAppResourceRange(
          text,
          typeof input.startLine === "number" ? input.startLine : undefined,
          typeof input.endLine === "number" ? input.endLine : undefined,
          typeof input.startOffset === "number" ? input.startOffset : undefined,
        ),
      };
    }

    case "app_read_file": {
      if (!appId) return fail("appId is required");
      const appEntity = await ensureApp(appId);
      if (!appEntity) return fail("App not found");
      const file = appEntity.files.find(f => f.path === input.path);
      if (!file) return fail(`File not found: ${input.path}`);
      const clipped = clipAgentText(
        file.contents ?? "",
        APP_READ_FILE_MAX_CHARS,
      );
      if (clipped.truncated) {
        return fail(
          "File is too large for app_read_file. Use app_search and " +
            "app_read_resource to read precise ranges.",
        );
      }
      return {
        success: true,
        path: file.path,
        contents: clipped.text,
        length: clipped.length,
        truncated: false,
      };
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
      // Ephemeral viewport: verify the responsive layout at an exact size
      // (e.g. 390x844 for mobile) without stickily changing what the user
      // sees — the previous viewport is restored after the capture. Media
      // queries respond to the iframe's own size, so a resize IS the
      // responsive check; no rebuild is needed for it.
      const requestedWidth =
        typeof input.width === "number" ? input.width : undefined;
      const requestedHeight =
        typeof input.height === "number" ? input.height : undefined;
      const ephemeralViewport: AppPreviewViewport | null =
        requestedWidth !== undefined || requestedHeight !== undefined
          ? { width: requestedWidth ?? 1280, height: requestedHeight ?? 800 }
          : null;
      const previousViewport = ephemeralViewport
        ? (useAppStore.getState().previewViewport[appId] ?? null)
        : null;
      if (ephemeralViewport) {
        store.setPreviewViewport(appId, ephemeralViewport);
      }
      try {
        // rebuild: false = read the current preview state — no bumpPreview,
        // which flashes a black "Building preview…" screen and can remount
        // Chat. With only a viewport change, give the app a beat to re-lay
        // out before capturing.
        if (input.rebuild !== false) {
          store.bumpPreview(appId);
        } else if (ephemeralViewport) {
          await new Promise(resolve => setTimeout(resolve, 350));
        }
        const timeoutMs = clampRunAppTimeoutMs(
          typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
        );
        const settled = await waitForPreviewSettle(
          appId,
          timeoutMs,
          options?.signal,
        );
        const errors = summarizePreviewErrors(
          useAppStore.getState().previewErrors[appId],
        );
        const result: RunAppResult = {
          success: settled.status === "ready",
          status: settled.status,
          errors,
          consoleLogs: [],
          source: "iframe",
          ...(settled.noIframe
            ? {
                error:
                  "No visible preview iframe for this app — open it with " +
                  "open_app so the preview can build and report.",
              }
            : {}),
        };

        const delivery = options?.screenshotDelivery ?? "vision-attachment";
        const wantScreenshot = input.includeScreenshot !== false;
        let screenshotPassedToModel = false;
        if (wantScreenshot && delivery === "none") {
          result.screenshotUnavailableReason =
            "This client cannot deliver screenshots (update Mako Desktop / " +
            "Local Agent). Status and errors above are still authoritative.";
        } else if (wantScreenshot) {
          try {
            const dataUrl = await captureAppPreview(appId);
            const parts = dataUrlToParts(dataUrl);
            if (!parts) {
              throw new Error("Preview returned an unreadable capture");
            }
            if (delivery === "inline") {
              result.screenshot = {
                mimeType: parts.mimeType,
                base64: parts.base64,
              };
            } else {
              const enqueued = enqueueScreenshotVisionAttachment({
                renderer: "app-preview-self-capture",
                filename: `run-app-${appId}-${Date.now()}.png`,
                mediaType: "image/png",
                dataUrl,
                outputBytes: Math.ceil((parts.base64.length * 3) / 4),
                targetLabel: "app-preview",
              });
              if (enqueued) {
                screenshotPassedToModel = true;
              } else {
                result.screenshotUnavailableReason =
                  "Screenshot was too large to pass to the model.";
              }
            }
          } catch (error) {
            result.screenshotUnavailableReason =
              error instanceof Error ? error.message : "Preview capture failed";
          }
        }

        return {
          ...result,
          ...(ephemeralViewport
            ? {
                viewport: {
                  width: ephemeralViewport.width,
                  height: ephemeralViewport.height,
                },
              }
            : {}),
          ...(screenshotPassedToModel
            ? {
                screenshotPassedToModel: true,
                note: "The preview screenshot is sent as a real image input in the next model request, not inside this tool result.",
              }
            : {}),
        };
      } finally {
        // The verify viewport is ephemeral — put back whatever the user had.
        if (ephemeralViewport) {
          store.setPreviewViewport(appId, previousViewport);
        }
      }
    }

    case "app_set_preview_viewport": {
      if (!appId) return fail("appId is required");
      await ensureApp(appId);
      const width = typeof input.width === "number" ? input.width : undefined;
      const height =
        typeof input.height === "number" ? input.height : undefined;
      const preset = input.preset as "phone" | "tablet" | "desktop" | undefined;
      let viewport: AppPreviewViewport | null;
      if (width !== undefined && height !== undefined) {
        viewport = { width, height };
      } else if (width !== undefined || height !== undefined) {
        return fail("Pass both width and height for a custom viewport.");
      } else if (preset === "phone" || preset === "tablet") {
        viewport = { ...APP_PREVIEW_VIEWPORT_PRESETS[preset], preset };
      } else if (preset === "desktop") {
        viewport = null;
      } else {
        return fail(
          "Pass preset ('phone' | 'tablet' | 'desktop') or width + height.",
        );
      }
      store.setPreviewViewport(appId, viewport);
      return {
        success: true,
        viewport,
        hint: viewport
          ? `Preview now renders at ${viewport.width}×${viewport.height} for you AND the user — no rebuild needed. Verify with run_app; reset with preset: "desktop".`
          : "Preview viewport reset — the app fills the pane again.",
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
