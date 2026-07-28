/**
 * Transport-neutral app (data apps) capability metadata.
 *
 * Apps are the primary headless MCP authoring loop, so almost every server
 * tool is exposed on all surfaces. Client-only tools (browser tab focus,
 * iframe preview) stay in-chat.
 */
import {
  ALL_AGENT_SURFACES,
  IN_CHAT_ONLY_SURFACES,
  type AgentCapabilityDefinition,
} from "./types";

export type AppCapabilityPack =
  | "app-orient"
  | "app-edit"
  | "app-data"
  | "app-versions"
  | "app-ui";

export type AppCapabilityDefinition = AgentCapabilityDefinition<
  "app",
  AppCapabilityPack
>;

const define = (
  definition: Omit<AppCapabilityDefinition, "domain">,
): AppCapabilityDefinition => ({ domain: "app", ...definition });

export const APP_CAPABILITIES = [
  // ── Orientation / reads ─────────────────────────────────────────────────
  define({
    name: "list_open_apps",
    pack: "app-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "get_app_state",
    pack: "app-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "app_search",
    pack: "app-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "app_read_resource",
    pack: "app-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "app_read_file",
    pack: "app-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  // ── Files / dependencies ────────────────────────────────────────────────
  define({
    name: "create_app",
    pack: "app-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "app_write_file",
    pack: "app-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "app_edit_file",
    pack: "app-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "app_rename_file",
    pack: "app-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "app_delete_file",
    pack: "app-edit",
    risk: "destructive",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "app_add_dependency",
    pack: "app-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "app_remove_dependency",
    pack: "app-edit",
    risk: "destructive",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  // ── Data bindings / materialization ─────────────────────────────────────
  define({
    name: "app_create_data_binding",
    pack: "app-data",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "app_update_data_binding",
    pack: "app-data",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "app_delete_data_binding",
    pack: "app-data",
    risk: "destructive",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "app_set_binding_materialization",
    pack: "app-data",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    // Executes the binding's saved query against the connection, so it needs
    // the same query envelope as run_console / sql_execute_query.
    name: "materialize_binding",
    pack: "app-data",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
    requiresQueryAccess: true,
  }),
  define({
    name: "app_set_binding_schedule",
    pack: "app-data",
    risk: "write",
    requiredGrant: "schedule-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  // ── Versions ────────────────────────────────────────────────────────────
  define({
    name: "app_save_version",
    pack: "app-versions",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "app_restore_version",
    pack: "app-versions",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  // ── Client-only UI effects ──────────────────────────────────────────────
  define({
    name: "open_app",
    pack: "app-ui",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: IN_CHAT_ONLY_SURFACES,
    resultKind: "ui-effect",
    mcpExclusion: {
      why: "client-only",
      note: "UI tab focus only; MCP operates on appId directly.",
    },
  }),
  define({
    // One capability, one name, three adapters: Chat rebuilds the live
    // iframe (client tool), Desktop delivers it via the mako-desktop
    // loopback server, and external MCP runs the server-side headless
    // renderer (api/src/mcp/preview-tools.ts). Rendering a draft mutates
    // nothing, so it is read-risk on every surface.
    name: "run_app",
    pack: "app-ui",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "ui-effect",
    desktopDelivery: "mako-desktop",
  }),
  define({
    name: "app_set_preview_environment",
    pack: "app-ui",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: IN_CHAT_ONLY_SURFACES,
    resultKind: "ui-effect",
    mcpExclusion: {
      why: "client-only",
      note: "Per-user browser preview state; headless agents use run_app / bindings directly.",
    },
  }),
] as const satisfies readonly AppCapabilityDefinition[];
