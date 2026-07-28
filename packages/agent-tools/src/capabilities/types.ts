/**
 * Transport-neutral agent capability metadata, shared by every domain
 * registry (dbt, apps, consoles, query, notebooks, …).
 *
 * Tool implementations stay server-side. Registries built from these types
 * are the single source for mode membership, MCP exposure, authorization,
 * token packs, and UI result semantics.
 */

export type AgentSurface = "in-chat" | "desktop-acp" | "external-mcp";

export type CapabilityRisk = "read" | "write" | "destructive";

export type CapabilityGrant =
  | "artifact-write"
  | "git-write"
  | "schedule-write"
  | "warehouse-write";

export const CAPABILITY_GRANTS = [
  "artifact-write",
  "git-write",
  "schedule-write",
  "warehouse-write",
] as const satisfies readonly CapabilityGrant[];

export type CapabilityResultKind = "data" | "artifact" | "run" | "ui-effect";

/** Mirrors the MCP bridge policy's exclusion taxonomy. */
export type CapabilityMcpExclusionWhy =
  | "client-only"
  | "security"
  | "in-product-only"
  | "deferred";

export interface AgentCapabilityDefinition<
  Domain extends string = string,
  Pack extends string = string,
> {
  name: string;
  domain: Domain;
  pack: Pack;
  risk: CapabilityRisk;
  requiredGrant?: CapabilityGrant;
  surfaces: readonly AgentSurface[];
  resultKind: CapabilityResultKind;
  requiresQueryAccess?: boolean;
  /**
   * Long-running validation must move to the run registry before MCP exposure.
   */
  requiresAsyncMcp?: boolean;
  /**
   * When the tool is kept off MCP surfaces, the bridge policy surfaces this
   * why + note instead of a generic "deferred" classification.
   */
  mcpExclusion?: { why: CapabilityMcpExclusionWhy; note: string };
}

export const ALL_AGENT_SURFACES = [
  "in-chat",
  "desktop-acp",
  "external-mcp",
] as const satisfies readonly AgentSurface[];

export const PRODUCT_AGENT_SURFACES = [
  "in-chat",
  "desktop-acp",
] as const satisfies readonly AgentSurface[];

export const IN_CHAT_ONLY_SURFACES = [
  "in-chat",
] as const satisfies readonly AgentSurface[];
