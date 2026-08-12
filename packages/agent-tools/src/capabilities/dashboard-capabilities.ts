/**
 * Transport-neutral dashboard capability metadata.
 *
 * Only the tools migrated to per-surface adapters live here; the remaining
 * dashboard tools (widgets, filters, dashboard state) are still browser-only
 * and keep their hand-maintained entries in the MCP bridge policy until they
 * grow server legs.
 */
import {
  ALL_AGENT_SURFACES,
  type AgentCapabilityDefinition,
} from "./types";

export type DashboardCapabilityPack = "dashboard-data";

export type DashboardCapabilityDefinition = AgentCapabilityDefinition<
  "dashboard",
  DashboardCapabilityPack
>;

const define = (
  definition: Omit<DashboardCapabilityDefinition, "domain">,
): DashboardCapabilityDefinition => ({ domain: "dashboard", ...definition });

export const DASHBOARD_CAPABILITIES = [
  define({
    // One capability, per-surface adapters (run_app pattern): browser
    // executor edits the open tab; the server leg
    // (api/src/agent-lib/tools/server-dashboard-tools.ts) executes against
    // the Dashboard document for headless / MCP agents. Mirrors
    // app_update_data_binding, including the schedule leg's gate.
    name: "update_data_source_query",
    pack: "dashboard-data",
    risk: "write",
    requiredGrant: "artifact-write",
    inputConditionalGrants: [
      {
        grant: "schedule-write",
        behavior: "changing the dashboard's materialization schedule",
        appliesTo: input =>
          typeof input === "object" &&
          input !== null &&
          (input as { materializationSchedule?: unknown })
            .materializationSchedule !== undefined,
      },
    ],
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
] as const satisfies readonly DashboardCapabilityDefinition[];
