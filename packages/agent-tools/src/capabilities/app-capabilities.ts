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
  // Legacy (pre-git) app authoring capabilities were removed with Apps v1;
  // what remains serves the retained draft/publish preview surface.
  define({
    // One capability, one name, one result envelope (run-app.ts), three
    // adapters: Chat rebuilds the live iframe and self-captures a screenshot
    // (client tool), Desktop delivers the same executor via the mako-desktop
    // loopback server (screenshot as MCP image content), and external MCP
    // runs the server-side headless renderer (api/src/mcp/preview-tools.ts).
    // Rendering a draft mutates nothing, so it is read-risk on every surface.
    name: "run_app",
    pack: "app-ui",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "ui-effect",
    desktopDelivery: "mako-desktop",
  }),
  define({
    // Merged preview setter (viewport + dbt environment). The environment leg
    // keeps app_set_preview_environment's artifact-write gate, applied only
    // when the input actually switches the environment; viewport-only calls
    // are pure per-user view state.
    name: "app_set_preview",
    pack: "app-ui",
    risk: "write",
    inputConditionalGrants: [
      {
        grant: "artifact-write",
        behavior: "switching the draft preview's dbt environment",
        appliesTo: input =>
          typeof input === "object" &&
          input !== null &&
          (input as { environment?: unknown }).environment !== undefined,
      },
    ],
    surfaces: IN_CHAT_ONLY_SURFACES,
    resultKind: "ui-effect",
    mcpExclusion: {
      why: "client-only",
      note: "Per-user browser preview state; headless agents pass width/height to run_app.",
    },
  }),
] as const satisfies readonly AppCapabilityDefinition[];
