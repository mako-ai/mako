/**
 * Sync (flow) tools for agents outside the product: read the syncs, see how
 * each entity is doing, start a backfill, change the trigger controls.
 *
 * Reads are reads. A backfill re-reads a source and MERGEs into the
 * warehouse, and a trigger change rewrites `flows/<slug>.yml` and changes
 * what starts a sync, so both are gated like dbt_run_model (the
 * `warehouse-write` grant) and, like the flow routes they mirror, need an
 * owner or admin. External MCP only: the in-product agent has the flow
 * editor.
 */
import type { AgentCapabilityDefinition, AgentSurface } from "./types";

export type SyncCapabilityDefinition = AgentCapabilityDefinition<
  "sync",
  "syncs"
>;

const EXTERNAL_MCP_ONLY = [
  "external-mcp",
] as const satisfies readonly AgentSurface[];

const define = (
  definition: Omit<SyncCapabilityDefinition, "domain" | "pack">,
): SyncCapabilityDefinition => ({
  domain: "sync",
  pack: "syncs",
  ...definition,
});

export const SYNC_CAPABILITIES: readonly SyncCapabilityDefinition[] = [
  define({
    name: "flow_list",
    risk: "read",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
  define({
    name: "flow_read",
    risk: "read",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
  define({
    name: "flow_status",
    risk: "read",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
  define({
    name: "flow_backfill",
    risk: "write",
    minimumWorkspaceRole: "admin",
    requiredGrant: "warehouse-write",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "run",
  }),
  define({
    name: "flow_update",
    risk: "write",
    minimumWorkspaceRole: "admin",
    requiredGrant: "warehouse-write",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
];
