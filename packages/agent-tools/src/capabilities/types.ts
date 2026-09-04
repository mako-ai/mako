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
  | "members-write"
  | "schedule-write"
  | "warehouse-write";

export const CAPABILITY_GRANTS = [
  "artifact-write",
  "git-write",
  // Who can reach the workspace at all — the only grant that can widen the
  // set of people holding every other one. Never implicit on any surface.
  "members-write",
  "schedule-write",
  "warehouse-write",
] as const satisfies readonly CapabilityGrant[];

export type CapabilityResultKind = "data" | "artifact" | "run" | "ui-effect";

/**
 * A grant required only when a call's INPUT exercises the gated behavior —
 * e.g. app_update_data_binding needs schedule-write only when the input
 * carries materializationSchedule. Enforced at execution (and on the MCP
 * call path) alongside requiredGrant, so folding a gated setter into a
 * broader tool cannot widen what a grant allows.
 */
export interface CapabilityInputConditionalGrant {
  grant: CapabilityGrant;
  /** Short label of the gated behavior, used in denial messages. */
  behavior: string;
  /** Returns true when this call's input exercises the gated behavior. */
  appliesTo: (input: unknown) => boolean;
}

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
  /** Minimum live workspace role required for this capability. */
  minimumWorkspaceRole?: "member" | "admin";
  requiredGrant?: CapabilityGrant;
  inputConditionalGrants?: readonly CapabilityInputConditionalGrant[];
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
  /**
   * On desktop-acp this capability is delivered by the mako-desktop loopback
   * server (same tool name), so the Mako MCP bridge must NOT register it for
   * acpDesktop clients — one name, one provider per surface.
   */
  desktopDelivery?: "mako-desktop";
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
