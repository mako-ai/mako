/**
 * Transport-neutral flow-operations capability metadata.
 *
 * A flow's DEFINITION is a file (`flows/<slug>.yml`, see `check_flow_files`);
 * these are the operations on a flow that is already defined — the things
 * the flow's page in the UI does with its Start / Pause buttons and its Run
 * History tab:
 *
 *   - reads: `list_flows`, `inspect_flow` (stream + backfill state, per-entity
 *     progress, last error) and `list_flow_runs` (recent executions). They
 *     return run state only — never a credential, never a webhook secret —
 *     but run errors carry data from the platform behind the source, so like
 *     `probe_connection` they require query access.
 *   - writes: `flow_backfill` / `flow_stream` start, pause, resume or cancel
 *     a CDC flow through the same service the UI's routes call. They are
 *     gated exactly as strictly as those routes (owner/admin, checked live)
 *     plus the `sources-write` grant, which no credential holds by default.
 *
 * External-MCP only, like membership: the in-product agent acts for a
 * signed-in user who has the flow's page.
 */
import { type AgentCapabilityDefinition, type AgentSurface } from "./types";

const EXTERNAL_MCP_ONLY = ["external-mcp"] as const satisfies readonly AgentSurface[];

export type FlowCapabilityPack = "flow-runs" | "flow-control";

export type FlowCapabilityDefinition = AgentCapabilityDefinition<
  "flows",
  FlowCapabilityPack
>;

const define = (
  definition: Omit<FlowCapabilityDefinition, "domain">,
): FlowCapabilityDefinition => ({ domain: "flows", ...definition });

export const FLOW_CAPABILITIES = [
  define({
    name: "list_flows",
    pack: "flow-runs",
    risk: "read",
    requiresQueryAccess: true,
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
  define({
    name: "inspect_flow",
    pack: "flow-runs",
    risk: "read",
    requiresQueryAccess: true,
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
  define({
    name: "list_flow_runs",
    pack: "flow-runs",
    risk: "read",
    requiresQueryAccess: true,
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
  define({
    name: "flow_backfill",
    pack: "flow-control",
    // `cancel` discards the run's checkpoints: the next start re-reads from
    // scratch. Destructive, so MCP clients annotate and confirm it as such.
    risk: "destructive",
    minimumWorkspaceRole: "admin",
    requiredGrant: "sources-write",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "run",
  }),
  define({
    name: "flow_stream",
    pack: "flow-control",
    risk: "write",
    minimumWorkspaceRole: "admin",
    requiredGrant: "sources-write",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "run",
  }),
] as const satisfies readonly FlowCapabilityDefinition[];
