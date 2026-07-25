/**
 * When Local Claude/Codex (ACP) mutates apps over MCP, open/focus the app tab
 * in Desktop — same UX as in-app chat's open_app / create_app client path.
 * Headless MCP clients still use create_preview_token; Desktop must not.
 */
import { focusAppTab } from "../app-runtime/shell";
import { useAppStore } from "../store/appStore";
import { resolveAcpToolName, type AcpToolUpdate } from "./local-acp-parts";

/** Tools whose completion should surface the app in the Desktop UI. */
export const ACP_APP_FOCUS_TOOLS = new Set([
  "create_app",
  "open_app",
  "app_write_file",
  "app_edit_file",
  "app_delete_file",
  "app_rename_file",
  "app_add_dependency",
  "app_remove_dependency",
  "app_create_data_binding",
  "app_update_data_binding",
  "app_delete_data_binding",
  "create_preview_token",
  "render_app",
  // Read-only inspect — open the tab if needed, but do NOT rebuild the iframe
  // (bumpPreview). Rebuilding flashes a black “Building preview…” screen and
  // can remount Chat mid-tool (get_preview_errors then looks Interrupted).
  "get_app_state",
  "app_search",
  "app_read_resource",
]);

/** Mutations / explicit preview that need an iframe srcdoc rebuild. */
const ACP_APP_BUMP_PREVIEW_TOOLS = new Set([
  "create_app",
  "open_app",
  "app_write_file",
  "app_edit_file",
  "app_delete_file",
  "app_rename_file",
  "app_add_dependency",
  "app_remove_dependency",
  "app_create_data_binding",
  "app_update_data_binding",
  "app_delete_data_binding",
  "create_preview_token",
  "render_app",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function extractAppIdFromAcpTool(update: AcpToolUpdate): {
  appId: string;
  title?: string;
} | null {
  const input = asRecord(update.rawInput);
  const output = asRecord(update.rawOutput ?? update.content);
  const nested = asRecord(output?.data);

  const appId =
    (typeof output?.appId === "string" && output.appId) ||
    (typeof nested?.appId === "string" && nested.appId) ||
    (typeof input?.appId === "string" && input.appId) ||
    null;
  if (!appId) return null;

  const title =
    (typeof output?.title === "string" &&
      output.title.trim() &&
      output.title) ||
    (typeof nested?.title === "string" &&
      nested.title.trim() &&
      nested.title) ||
    undefined;
  return { appId, title };
}

/**
 * Open (or refresh) the app preview tab when an ACP MCP app tool completes.
 * Returns true when a focus/refresh was scheduled.
 */
export function maybeFocusAppFromAcpTool(
  workspaceId: string | undefined,
  update: AcpToolUpdate,
): boolean {
  if (!workspaceId || update.status !== "completed") return false;
  const toolName = resolveAcpToolName(update);
  if (!ACP_APP_FOCUS_TOOLS.has(toolName)) return false;

  const extracted = extractAppIdFromAcpTool(update);
  if (!extracted) return false;
  const { appId, title } = extracted;

  const alreadyOpen = Boolean(useAppStore.getState().openApps[appId]);
  // create_app / preview-token / explicit open always focus; edits only need
  // to open when the tab isn't already visible (open tabs get app.updated).
  const shouldFocus =
    !alreadyOpen ||
    toolName === "create_app" ||
    toolName === "open_app" ||
    toolName === "create_preview_token" ||
    toolName === "render_app";

  const shouldBump = ACP_APP_BUMP_PREVIEW_TOOLS.has(toolName);

  void useAppStore
    .getState()
    .fetchApp(workspaceId, appId)
    .then(app => {
      try {
        if (shouldFocus) {
          focusAppTab(appId, app?.title || title || "App");
        }
        // Only rebuild the sandboxed iframe when files/bindings changed.
        // Read tools (get_app_state) used to bump every time → black flash +
        // Chat remount → mid-flight mako-desktop tools marked Interrupted.
        if (shouldBump) {
          useAppStore.getState().bumpPreview(appId);
        }
        void useAppStore.getState().fetchList(workspaceId);
      } catch {
        // Preview/tab focus must never surface as an unhandled rejection —
        // that remounts Chat and used to drop unpersisted ACP turns.
      }
    })
    .catch(() => {
      try {
        if (shouldFocus) focusAppTab(appId, title || "App");
      } catch {
        // ignore
      }
    });

  return true;
}
