/**
 * Transport-neutral console / query-lifecycle capability metadata.
 *
 * Query execution tools carry `requiresQueryAccess` (the `query:read`
 * scope envelope) instead of a task grant: read-only enforcement happens per
 * query at the driver level, matching sql_execute_query.
 */
import {
  ALL_AGENT_SURFACES,
  IN_CHAT_ONLY_SURFACES,
  PRODUCT_AGENT_SURFACES,
  type AgentCapabilityDefinition,
} from "./types";

export type ConsoleCapabilityPack =
  | "console-orient"
  | "console-edit"
  | "console-run"
  | "console-schedule";

export type ConsoleCapabilityDefinition = AgentCapabilityDefinition<
  "console",
  ConsoleCapabilityPack
>;

const define = (
  definition: Omit<ConsoleCapabilityDefinition, "domain">,
): ConsoleCapabilityDefinition => ({ domain: "console", ...definition });

export const CONSOLE_CAPABILITIES = [
  // ── Orientation / reads ─────────────────────────────────────────────────
  define({
    name: "read_console",
    pack: "console-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "search_consoles",
    pack: "console-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    // One name, one provider per surface: Chat reads the open tabs directly
    // (client tool) and Desktop ACP gets the same tool from the mako-desktop
    // loopback server. No external adapter — headless clients have no open
    // tabs and use search_consoles instead.
    name: "list_open_consoles",
    pack: "console-orient",
    risk: "read",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "data",
    desktopDelivery: "mako-desktop",
    mcpExclusion: {
      why: "client-only",
      note: "Open tabs are client state: Desktop ACP gets it from the mako-desktop loopback server; external MCP uses search_consoles.",
    },
  }),
  // ── Authoring ───────────────────────────────────────────────────────────
  define({
    name: "create_console",
    pack: "console-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "modify_console",
    pack: "console-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "set_console_connection",
    pack: "console-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    // Focuses/opens a tab (realtime event) without changing the console
    // definition — a UI effect, not a mutation.
    name: "open_console",
    pack: "console-edit",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "ui-effect",
  }),
  // ── Run lifecycle ───────────────────────────────────────────────────────
  define({
    name: "run_console",
    pack: "console-run",
    risk: "write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
    requiresQueryAccess: true,
  }),
  define({
    // Polls a run without affecting it — read-lifecycle, not a write.
    name: "check_query_status",
    pack: "console-run",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
    requiresQueryAccess: true,
  }),
  define({
    name: "cancel_query",
    pack: "console-run",
    risk: "write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
    requiresQueryAccess: true,
  }),
  define({
    // Lists past runs — read-lifecycle, not a write.
    name: "list_console_executions",
    pack: "console-run",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  // ── Scheduling (legacy console agent only today) ────────────────────────
  define({
    name: "schedule_query",
    pack: "console-schedule",
    risk: "write",
    requiredGrant: "schedule-write",
    surfaces: IN_CHAT_ONLY_SURFACES,
    resultKind: "artifact",
    mcpExclusion: {
      why: "in-product-only",
      note: "Scheduled writes need session auth + console ownership UX; not in MCP read-only apps loop.",
    },
  }),
] as const satisfies readonly ConsoleCapabilityDefinition[];
