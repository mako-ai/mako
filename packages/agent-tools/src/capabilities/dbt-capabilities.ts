/**
 * Transport-neutral dbt capability metadata.
 *
 * Tool implementations stay server-side. This registry is the shared source
 * for mode membership, MCP exposure, authorization, token packs, and UI
 * result semantics.
 */
import {
  ALL_AGENT_SURFACES,
  type AgentCapabilityDefinition,
  type AgentSurface,
} from "./types";

export type DbtCapabilityPack =
  | "dbt-orient"
  | "dbt-edit"
  | "dbt-validation"
  | "dbt-projects"
  | "dbt-jobs";

export type DbtCapabilityDefinition = AgentCapabilityDefinition<
  "dbt",
  DbtCapabilityPack
>;

const define = (
  definition: Omit<DbtCapabilityDefinition, "domain">,
): DbtCapabilityDefinition => ({ domain: "dbt", ...definition });

export const DBT_CAPABILITIES = [
  define({
    name: "read_dbt_project_tree",
    pack: "dbt-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "read_dbt_file",
    pack: "dbt-orient",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "create_dbt_file",
    pack: "dbt-edit",
    risk: "write",
    minimumWorkspaceRole: "member",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "modify_dbt_file",
    pack: "dbt-edit",
    risk: "write",
    minimumWorkspaceRole: "member",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "edit_dbt_file",
    pack: "dbt-edit",
    risk: "write",
    minimumWorkspaceRole: "member",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "delete_dbt_file",
    pack: "dbt-edit",
    risk: "destructive",
    minimumWorkspaceRole: "member",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  // Validation runs are async (queue + poll dbt_get_run) since #755, so they
  // are safe on the stateless external MCP surface. Read-risk validation
  // bridges for every key; warehouse-mutating runs additionally require the
  // warehouse-write grant, which external MCP only derives from an explicit
  // warehouse:write API-key scope.
  define({
    name: "dbt_parse",
    pack: "dbt-validation",
    risk: "read",
    minimumWorkspaceRole: "member",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
  }),
  define({
    name: "dbt_compile_model",
    pack: "dbt-validation",
    risk: "read",
    minimumWorkspaceRole: "member",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
  }),
  define({
    name: "dbt_show",
    pack: "dbt-validation",
    risk: "read",
    minimumWorkspaceRole: "member",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
    requiresQueryAccess: true,
  }),
  define({
    name: "dbt_run_model",
    pack: "dbt-validation",
    risk: "destructive",
    minimumWorkspaceRole: "member",
    requiredGrant: "warehouse-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
    requiresQueryAccess: true,
  }),
  define({
    name: "dbt_get_run",
    pack: "dbt-validation",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
    requiresQueryAccess: true,
  }),
  define({
    name: "dbt_cancel_run",
    pack: "dbt-validation",
    risk: "write",
    minimumWorkspaceRole: "member",
    requiredGrant: "warehouse-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
  }),
  define({
    name: "dbt_create_project",
    pack: "dbt-projects",
    risk: "write",
    minimumWorkspaceRole: "admin",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_ensure_dev_environment",
    pack: "dbt-projects",
    risk: "write",
    minimumWorkspaceRole: "member",
    requiredGrant: "warehouse-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
    requiresQueryAccess: true,
  }),
  define({
    name: "dbt_create_job",
    pack: "dbt-jobs",
    risk: "write",
    minimumWorkspaceRole: "admin",
    // A saved job with a cron schedule is executed by the scheduler against
    // the warehouse with no further scope check, so creating, rescheduling or
    // removing one is warehouse authority — never the implicit schedule-write
    // grant every external MCP key holds.
    requiredGrant: "warehouse-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_update_job",
    pack: "dbt-jobs",
    risk: "write",
    minimumWorkspaceRole: "admin",
    // A saved job with a cron schedule is executed by the scheduler against
    // the warehouse with no further scope check, so creating, rescheduling or
    // removing one is warehouse authority — never the implicit schedule-write
    // grant every external MCP key holds.
    requiredGrant: "warehouse-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_delete_job",
    pack: "dbt-jobs",
    risk: "destructive",
    minimumWorkspaceRole: "admin",
    // A saved job with a cron schedule is executed by the scheduler against
    // the warehouse with no further scope check, so creating, rescheduling or
    // removing one is warehouse authority — never the implicit schedule-write
    // grant every external MCP key holds.
    requiredGrant: "warehouse-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_run_job",
    pack: "dbt-jobs",
    risk: "destructive",
    minimumWorkspaceRole: "member",
    requiredGrant: "warehouse-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "run",
    requiresQueryAccess: true,
  }),
] as const satisfies readonly DbtCapabilityDefinition[];

export const DBT_CAPABILITY_NAMES = DBT_CAPABILITIES.map(
  capability => capability.name,
);

export const DBT_CAPABILITY_BY_NAME = new Map(
  DBT_CAPABILITIES.map(capability => [capability.name, capability]),
);

export function dbtCapabilitiesForSurface(
  surface: AgentSurface,
): readonly DbtCapabilityDefinition[] {
  return DBT_CAPABILITIES.filter(capability =>
    capability.surfaces.includes(surface),
  );
}

export function dbtCapabilitiesForPack(
  pack: DbtCapabilityPack,
): readonly DbtCapabilityDefinition[] {
  return DBT_CAPABILITIES.filter(capability => capability.pack === pack);
}
