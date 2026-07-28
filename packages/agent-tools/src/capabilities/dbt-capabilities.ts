/**
 * Transport-neutral dbt capability metadata.
 *
 * Tool implementations stay server-side. This registry is the shared source
 * for mode membership, MCP exposure, authorization, token packs, and UI
 * result semantics.
 */
import {
  ALL_AGENT_SURFACES,
  PRODUCT_AGENT_SURFACES,
  type AgentCapabilityDefinition,
  type AgentSurface,
} from "./types";


export type DbtCapabilityPack =
  | "dbt-orient"
  | "dbt-edit"
  | "dbt-validation"
  | "dbt-projects"
  | "dbt-git-read"
  | "dbt-git-write"
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
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "modify_dbt_file",
    pack: "dbt-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "edit_dbt_file",
    pack: "dbt-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "delete_dbt_file",
    pack: "dbt-edit",
    risk: "destructive",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_list_recoverable_files",
    pack: "dbt-edit",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "dbt_restore_file",
    pack: "dbt-edit",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_parse",
    pack: "dbt-validation",
    risk: "read",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "run",
  }),
  define({
    name: "dbt_compile_model",
    pack: "dbt-validation",
    risk: "read",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "run",
  }),
  define({
    name: "dbt_show",
    pack: "dbt-validation",
    risk: "read",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "run",
    requiresQueryAccess: true,
  }),
  define({
    name: "dbt_run_model",
    pack: "dbt-validation",
    risk: "destructive",
    requiredGrant: "warehouse-write",
    surfaces: PRODUCT_AGENT_SURFACES,
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
    requiredGrant: "warehouse-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "run",
  }),
  define({
    name: "dbt_create_project",
    pack: "dbt-projects",
    risk: "write",
    requiredGrant: "artifact-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_ensure_dev_environment",
    pack: "dbt-projects",
    risk: "write",
    requiredGrant: "warehouse-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
    requiresQueryAccess: true,
  }),
  define({
    name: "dbt_git_status",
    pack: "dbt-git-read",
    risk: "read",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "dbt_list_branches",
    pack: "dbt-git-read",
    risk: "read",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "dbt_compare_branches",
    pack: "dbt-git-read",
    risk: "read",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "dbt_list_pull_requests",
    pack: "dbt-git-read",
    risk: "read",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "dbt_sync_from_repo",
    pack: "dbt-git-write",
    risk: "destructive",
    requiredGrant: "git-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_commit_and_push",
    pack: "dbt-git-write",
    risk: "write",
    requiredGrant: "git-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_commit_to_branch",
    pack: "dbt-git-write",
    risk: "write",
    requiredGrant: "git-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_create_branch",
    pack: "dbt-git-write",
    risk: "write",
    requiredGrant: "git-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_switch_branch",
    pack: "dbt-git-write",
    risk: "destructive",
    requiredGrant: "git-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_delete_branch",
    pack: "dbt-git-write",
    risk: "destructive",
    requiredGrant: "git-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_open_pull_request",
    pack: "dbt-git-write",
    risk: "write",
    requiredGrant: "git-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_merge_pull_request",
    pack: "dbt-git-write",
    risk: "destructive",
    requiredGrant: "git-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_update_pull_request",
    pack: "dbt-git-write",
    risk: "write",
    requiredGrant: "git-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_close_pull_request",
    pack: "dbt-git-write",
    risk: "destructive",
    requiredGrant: "git-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_create_job",
    pack: "dbt-jobs",
    risk: "write",
    requiredGrant: "schedule-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_update_job",
    pack: "dbt-jobs",
    risk: "write",
    requiredGrant: "schedule-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_delete_job",
    pack: "dbt-jobs",
    risk: "destructive",
    requiredGrant: "schedule-write",
    surfaces: PRODUCT_AGENT_SURFACES,
    resultKind: "artifact",
  }),
  define({
    name: "dbt_run_job",
    pack: "dbt-jobs",
    risk: "destructive",
    requiredGrant: "warehouse-write",
    surfaces: PRODUCT_AGENT_SURFACES,
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
